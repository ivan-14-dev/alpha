import { z } from 'zod';
import { HttpError } from '../core.js';
import { transaction } from '../db.js';
import { maskSecret } from '../platform/secrets.js';
import { getSecretSetting, getSetting, hasSecretSetting, publicApiOrigin, setSecretSetting, setSetting, settingUpdatedAt } from '../platform/settings.js';
import { paymentMode } from './mode.js';
import { getProvider, listProviders } from './providers/index.js';
import type { PaymentProvider, ProviderConfig, ProviderContext, ProviderEnvironment, ProviderId } from './providers/types.js';

/**
 * Provider configuration store (admin console → Paiements). One configuration per provider AND environment,
 * so sandbox and live credentials never mix. Non-secret fields are JSON settings; secret fields are sealed
 * individually and never leave the server (the admin API only sees a mask + "configured" flag).
 */
const storedConfig = z.object({
  enabled: z.boolean(),
  settings: z.record(z.string().max(80), z.string().max(500)),
}).strict();
type StoredConfig = z.infer<typeof storedConfig>;

const configKey = (id: ProviderId, environment: ProviderEnvironment) => `payments.provider.${id}.${environment}`;
const secretKey = (id: ProviderId, environment: ProviderEnvironment, field: string) => `${configKey(id, environment)}.secret.${field}`;

function stored(id: ProviderId, environment: ProviderEnvironment): StoredConfig | null {
  return getSetting<StoredConfig | null>(configKey(id, environment), storedConfig.nullable(), null);
}

/** Environment used for real provider calls in the current global payment mode (null in demo). */
export function activeEnvironment(): ProviderEnvironment | null {
  const mode = paymentMode();
  return mode === 'demo' ? null : mode;
}

function requireProvider(id: string): PaymentProvider {
  const provider = getProvider(id);
  if (!provider) throw new HttpError(404, 'Prestataire de paiement inconnu.');
  return provider;
}

/** The simulator works out of the box in sandbox unless an admin disables it; it can never run live. */
function enabledByDefault(id: ProviderId, environment: ProviderEnvironment) {
  return id === 'simulator' && environment === 'sandbox';
}

/** Server-only: decrypted configuration, or null when the provider is not enabled for `environment`. */
export function readProviderConfig(id: string, environment: ProviderEnvironment): ProviderConfig | null {
  const provider = getProvider(id);
  if (!provider) return null;
  if (provider.id === 'simulator' && environment === 'live') return null;
  const config = stored(provider.id, environment);
  const enabled = config ? config.enabled : enabledByDefault(provider.id, environment);
  if (!enabled) return null;
  const secrets: Record<string, string> = {};
  for (const field of provider.fields.filter((item) => item.secret)) {
    const value = getSecretSetting(secretKey(provider.id, environment, field.key));
    if (value) secrets[field.key] = value;
  }
  return { id: provider.id, environment, settings: config?.settings ?? {}, secrets };
}

/** Admin-safe description (no secret values). */
export function describeProviderConfig(id: string, environment: ProviderEnvironment) {
  const provider = requireProvider(id);
  const config = stored(provider.id, environment);
  const enabled = provider.id === 'simulator' && environment === 'live' ? false : config ? config.enabled : enabledByDefault(provider.id, environment);
  const secrets = Object.fromEntries(provider.fields.filter((field) => field.secret).map((field) => {
    const key = secretKey(provider.id, environment, field.key);
    const configured = hasSecretSetting(key);
    return [field.key, { configured, mask: configured ? maskSecret(getSecretSetting(key)) : '' }];
  }));
  const decrypted = readProviderConfig(provider.id, environment) ?? { id: provider.id, environment, settings: config?.settings ?? {}, secrets: {} };
  return {
    id: provider.id,
    environment,
    enabled,
    settings: config?.settings ?? {},
    secrets,
    problems: enabled ? provider.validateConfig(decrypted) : [],
    webhook_url: webhookUrl(provider.id),
    updated_at: settingUpdatedAt(configKey(provider.id, environment)),
  };
}

export interface ProviderConfigInput {
  enabled: boolean;
  settings: Record<string, string>;
  /** `undefined` keeps the stored secret, `null` or '' removes it, a string replaces it. */
  secrets: Record<string, string | null | undefined>;
}

/** Validates against the provider field list; refuses to enable an invalid configuration. */
export function saveProviderConfig(id: string, environment: ProviderEnvironment, input: ProviderConfigInput, actorId: string) {
  const provider = requireProvider(id);
  if (provider.id === 'simulator' && environment === 'live' && input.enabled) throw new HttpError(400, 'Le simulateur ne peut pas être activé en production réelle.');
  const known = new Map(provider.fields.map((field) => [field.key, field]));
  for (const key of [...Object.keys(input.settings), ...Object.keys(input.secrets)]) {
    const field = known.get(key);
    if (!field) throw new HttpError(400, `Champ inconnu pour ${provider.label} : ${key}.`);
    if (field.secret !== Object.hasOwn(input.secrets, key)) throw new HttpError(400, `Le champ ${field.label} doit être envoyé dans ${field.secret ? 'secrets' : 'settings'}.`);
    const value = field.secret ? input.secrets[key] : input.settings[key];
    if (typeof value === 'string' && value.length > (field.secret ? 4000 : 500)) throw new HttpError(400, `${field.label} est trop long.`);
    if (!field.secret && field.options && value && !field.options.includes(value)) throw new HttpError(400, `${field.label} : valeur non autorisée.`);
  }
  transaction(() => {
    setSetting(configKey(provider.id, environment), { enabled: input.enabled, settings: input.settings }, actorId);
    for (const [key, value] of Object.entries(input.secrets)) {
      if (value === undefined) continue;
      setSecretSetting(secretKey(provider.id, environment, key), value ? value : null, actorId);
    }
    if (input.enabled) {
      const config = readProviderConfig(provider.id, environment)!;
      const missing = provider.fields.filter((field) => field.required && !(field.secret ? config.secrets[field.key] : config.settings[field.key]));
      const problems = [...missing.map((field) => `${field.label} est requis.`), ...provider.validateConfig(config)];
      if (problems.length) throw new HttpError(400, problems.join(' '));
    }
  });
  return describeProviderConfig(provider.id, environment);
}

/** Providers usable right now (current mode), optionally filtered for a checkout. */
export function enabledProviders(filter: { currency?: string; country?: string; method?: string } = {}) {
  const environment = activeEnvironment();
  if (!environment) return [];
  return listProviders().filter((provider) => {
    const config = readProviderConfig(provider.id, environment);
    if (!config) return false;
    if (filter.method && !provider.methods.includes(filter.method as never)) return false;
    if (filter.country && !provider.countries.includes('*') && !provider.countries.includes(filter.country)) return false;
    if (filter.currency && !provider.currencies.includes(filter.currency)) return false;
    return provider.validateConfig(config).length === 0;
  });
}

export function webhookUrl(id: string) {
  return `${publicApiOrigin()}/api/payments/webhooks/${encodeURIComponent(id)}`;
}

let fetchOverride: typeof fetch | null = null;
/** Tests inject a fake fetch so no network call ever leaves the machine. */
export function setProviderFetchForTests(value: typeof fetch | null) { fetchOverride = value; }

export function providerContext(id: string): ProviderContext {
  return {
    fetch: (input, init) => (fetchOverride ?? globalThis.fetch)(input, { signal: AbortSignal.timeout(20000), ...init }),
    now: () => new Date(),
    webhookUrl: webhookUrl(id),
  };
}
