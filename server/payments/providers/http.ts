import { createHash, createHmac } from 'node:crypto';
import { exponent } from '../mode.js';
import { hmacHex, safeEqual } from '../../platform/secrets.js';
import { ProviderError, type ProviderConfig, type ProviderContext, type ProviderId, type ProviderStatus, type WebhookInput } from './types.js';

/**
 * Shared helpers for provider adapters: HTTP calls with uniform error handling, amount conversions,
 * webhook signature helpers, phone normalisation and an in-memory OAuth token cache.
 * Nothing here touches the database.
 */

export const providerLabels: Record<ProviderId, string> = {
  simulator: 'Alpha Simulator',
  stripe: 'Stripe',
  flutterwave: 'Flutterwave',
  campay: 'CamPay',
  mtn_momo: 'MTN MoMo',
  orange_money: 'Orange Money',
  wave: 'Wave',
  kratos_pay: 'Kratos Pay',
};

export function fail(provider: ProviderId, message: string, retryable = false, httpStatus?: number): never {
  throw new ProviderError(provider, message, retryable, httpStatus);
}

// ---------------------------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------------------------

/** Removes secrets, bearer tokens, e-mail addresses and phone/account numbers from provider text. */
export function sanitizeText(text: string, secrets: Iterable<string> = []): string {
  let value = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) value = value.split(secret).join('[secret]');
  }
  return value
    .replace(/(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [secret]')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]')
    .replace(/\+?\d[\d\s.-]{5,}\d/g, '[numéro masqué]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

const personalKey = /phone|msisdn|partyid|mobile|account_?number|^from$|^to$|email|customer_?name|beneficiary_?name|full_?name|^payer$|^payee$/i;
const secretKey = /token|secret|password|authorization|api_?key|merchant_?key|signature|hash/i;

/** Deep copy of a provider payload safe to persist or log (personal data masked, secrets removed). */
export function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[…]';
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => scrub(item, depth + 1));
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (secretKey.test(key)) output[key] = '[secret]';
      else if (personalKey.test(key) && item !== null && typeof item !== 'object') output[key] = maskValue(String(item));
      else if (personalKey.test(key)) output[key] = scrub(item, depth + 1);
      else output[key] = scrub(item, depth + 1);
    }
    return output;
  }
  if (typeof value === 'string' && value.length > 500) return `${value.slice(0, 500)}…`;
  return value;
}

function maskValue(value: string): string {
  if (value.length <= 4) return '••••';
  return `••••${value.slice(-2)}`;
}

function secretsOf(config: ProviderConfig): string[] {
  return Object.values(config.secrets).filter((item): item is string => typeof item === 'string' && item.length >= 4);
}

// ---------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------

export interface HttpRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;
  headers?: Record<string, string | undefined>;
  /** JSON body (serialised with JSON.stringify). */
  json?: unknown;
  /** application/x-www-form-urlencoded body. */
  form?: URLSearchParams;
  /** Statuses returned to the caller instead of throwing (e.g. 404 = not found yet). */
  accept?: number[];
  /** Extra values to redact from error messages (tokens obtained at runtime). */
  redact?: string[];
}

export interface HttpResponse<T = any> {
  status: number;
  ok: boolean;
  data: T;
  headers: Headers;
}

export function serializeBody(request: Pick<HttpRequest, 'json' | 'form'>): { body?: string; contentType?: string } {
  if (request.form) return { body: request.form.toString(), contentType: 'application/x-www-form-urlencoded' };
  if (request.json !== undefined) return { body: JSON.stringify(request.json), contentType: 'application/json' };
  return {};
}

/** Extracts a human message from common provider error shapes. */
function providerMessage(data: unknown): string {
  if (!data || typeof data !== 'object') return typeof data === 'string' ? data : '';
  const record = data as Record<string, any>;
  const candidates = [
    record.error?.message, record.error_description, record.error_message, record.message, record.detail,
    record.description, record.reason?.message, record.reason, record.gatewayMessage,
    typeof record.error === 'string' ? record.error : undefined,
  ];
  const found = candidates.find((item) => typeof item === 'string' && item.trim());
  return typeof found === 'string' ? found : '';
}

/**
 * Calls a provider API through `context.fetch` (which owns the timeout). 2xx (and `accept`ed statuses)
 * resolve with parsed JSON; 408/429/5xx and network failures throw a retryable ProviderError; other
 * statuses throw a non-retryable one. Error messages never contain secrets, tokens or phone numbers.
 */
export async function callProvider<T = any>(provider: ProviderId, config: ProviderConfig, context: ProviderContext, request: HttpRequest, prepared?: { body?: string; contentType?: string }): Promise<HttpResponse<T>> {
  const label = providerLabels[provider];
  const { body, contentType } = prepared ?? serializeBody(request);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (contentType) headers['Content-Type'] = contentType;
  for (const [key, value] of Object.entries(request.headers ?? {})) if (value !== undefined) headers[key] = value;
  const redact = [...secretsOf(config), ...(request.redact ?? [])];

  let response: Response;
  try {
    response = await context.fetch(request.url, { method: request.method ?? (body === undefined ? 'GET' : 'POST'), headers, body });
  } catch (error) {
    const name = (error as Error)?.name;
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'délai dépassé' : 'erreur réseau';
    fail(provider, `${label} est injoignable (${reason}). Réessayez plus tard.`, true);
  }

  const text = await response.text().catch(() => '');
  let data: unknown = null;
  let parsed = true;
  if (text.trim()) {
    try { data = JSON.parse(text); }
    catch { parsed = false; data = text; }
  }
  const accepted = response.ok || (request.accept ?? []).includes(response.status);
  if (accepted) {
    if (!parsed && response.ok) fail(provider, `${label} a renvoyé une réponse illisible (HTTP ${response.status}).`, false, response.status);
    return { status: response.status, ok: response.ok, data: data as T, headers: response.headers };
  }
  if (response.status === 401 || response.status === 403) {
    fail(provider, `${label} a refusé l’authentification (HTTP ${response.status}). Vérifiez les identifiants configurés.`, false, response.status);
  }
  if (response.status === 408 || response.status === 429 || response.status >= 500) {
    fail(provider, `${label} est temporairement indisponible (HTTP ${response.status}). Réessayez plus tard.`, true, response.status);
  }
  const detail = sanitizeText(parsed ? providerMessage(data) : '', redact);
  fail(provider, `${label} a refusé la requête (HTTP ${response.status})${detail ? ` : ${detail}` : '.'}`, false, response.status);
}

export function baseUrl(config: ProviderConfig, defaults: { sandbox: string; live: string }): string {
  const override = config.settings.base_url?.trim();
  return (override || defaults[config.environment]).replace(/\/+$/, '');
}

/** Problems with an optional `base_url` override (https only; plain http allowed for localhost mocks in sandbox). */
export function baseUrlProblems(config: ProviderConfig): string[] {
  const value = config.settings.base_url?.trim();
  if (!value) return [];
  let url: URL;
  try { url = new URL(value); }
  catch { return ['L’URL d’API personnalisée est invalide.']; }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash) return [];
  if (url.protocol === 'http:' && local && config.environment === 'sandbox') return [];
  return ['L’URL d’API personnalisée doit être en HTTPS, sans identifiants ni paramètres.'];
}

export function basicAuth(user: string, password: string) {
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
}

// ---------------------------------------------------------------------------------------------
// OAuth / session token cache (in memory, per provider credentials)
// ---------------------------------------------------------------------------------------------

const tokens = new Map<string, { value: string; expiresAt: number }>();

export function tokenCacheKey(...parts: string[]) {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex');
}

/** Returns a cached token or fetches a new one; tokens are refreshed 60 s before expiry. */
export async function cachedToken(key: string, context: ProviderContext, fetcher: () => Promise<{ token: string; expiresIn?: number }>): Promise<string> {
  const now = context.now().getTime();
  const cached = tokens.get(key);
  if (cached && cached.expiresAt > now) return cached.value;
  const { token, expiresIn } = await fetcher();
  const lifetime = Math.max(0, (Number.isFinite(expiresIn) && expiresIn! > 0 ? expiresIn! : 3600) - 60) * 1000;
  if (lifetime > 0) tokens.set(key, { value: token, expiresAt: now + lifetime });
  return token;
}

export function invalidateToken(key: string) { tokens.delete(key); }

/** Tests and credential rotation. */
export function clearProviderTokenCache() { tokens.clear(); }

/** Runs `work` with a token and retries once with a fresh token when the provider answers 401. */
export async function withToken<T>(key: string, context: ProviderContext, fetcher: () => Promise<{ token: string; expiresIn?: number }>, work: (token: string) => Promise<T>): Promise<T> {
  const token = await cachedToken(key, context, fetcher);
  try {
    return await work(token);
  } catch (error) {
    if (error instanceof ProviderError && error.httpStatus === 401) {
      invalidateToken(key);
      return work(await cachedToken(key, context, fetcher));
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Amounts
// ---------------------------------------------------------------------------------------------

export function assertAmount(provider: ProviderId, amountMinor: number) {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) fail(provider, 'Montant invalide : un entier strictement positif (unités mineures) est attendu.');
}

export function assertCurrency(provider: ProviderId, currency: string, allowed: readonly string[]) {
  if (!allowed.includes(currency)) fail(provider, `${providerLabels[provider]} ne prend pas en charge la devise ${currency} dans cette configuration.`);
}

/** Integer minor units -> decimal string in major units ("12.50", "5000"). Exact (no float maths). */
export function toMajorString(amountMinor: number, currency: string): string {
  const exp = exponent(currency);
  if (exp === 0) return String(amountMinor);
  const negative = amountMinor < 0;
  const digits = String(Math.abs(amountMinor)).padStart(exp + 1, '0');
  return `${negative ? '-' : ''}${digits.slice(0, -exp)}.${digits.slice(-exp)}`;
}

export function toMajorNumber(amountMinor: number, currency: string): number {
  return Number(toMajorString(amountMinor, currency));
}

/** Integer major amount for providers that only accept whole units (XAF/XOF...). */
export function toWholeMajor(provider: ProviderId, amountMinor: number, currency: string): number {
  const exp = exponent(currency);
  if (amountMinor % 10 ** exp !== 0) fail(provider, `${providerLabels[provider]} n’accepte que des montants entiers en ${currency}.`);
  return amountMinor / 10 ** exp;
}

/** Major amount (number or decimal string) from a provider -> integer minor units, or undefined. */
export function fromMajor(value: unknown, currency: string | undefined): number | undefined {
  if (value === null || value === undefined || value === '' || !currency) return undefined;
  const numeric = typeof value === 'number' ? value : Number(String(value).replace(/\s/g, '').replace(',', '.'));
  if (!Number.isFinite(numeric)) return undefined;
  try { return Math.round(numeric * 10 ** exponent(currency.toUpperCase())); }
  catch { return undefined; }
}

/** Re-scales an integer amount between two decimal exponents; refuses lossy conversions. */
export function rescale(provider: ProviderId, amount: number, fromExponent: number, toExponent: number): number {
  if (toExponent >= fromExponent) return amount * 10 ** (toExponent - fromExponent);
  const factor = 10 ** (fromExponent - toExponent);
  if (amount % factor !== 0) fail(provider, 'Montant non représentable dans les unités du prestataire.');
  return amount / factor;
}

// ---------------------------------------------------------------------------------------------
// Phones & operators
// ---------------------------------------------------------------------------------------------

export const dialCodes: Record<string, string> = {
  CM: '237', CI: '225', SN: '221', ML: '223', BF: '226', BJ: '229', TG: '228', NE: '227', GN: '224',
  CG: '242', GA: '241', TD: '235', CF: '236', GQ: '240', UG: '256', GH: '233', KE: '254', RW: '250', NG: '234', FR: '33',
};

/** 10-digit national plans where the leading 0 belongs to the number (Côte d'Ivoire 2021, Bénin 2024). */
const keepsLeadingZero = new Set(['CI', 'BJ']);

/** International MSISDN without "+" (e.g. 2376XXXXXXXX). Never echoes the number in errors. */
export function msisdn(provider: ProviderId, phone: string | undefined, country?: string): string {
  if (!phone) fail(provider, 'Un numéro de téléphone mobile est requis pour ce moyen de paiement.');
  let digits = phone.replace(/[\s().-]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  else if (digits.startsWith('00')) digits = digits.slice(2);
  else if (country && dialCodes[country] && digits.length <= 10) digits = `${dialCodes[country]}${keepsLeadingZero.has(country) ? digits : digits.replace(/^0/, '')}`;
  if (!/^\d{8,15}$/.test(digits)) fail(provider, 'Numéro de téléphone mobile invalide.');
  return digits;
}

export type Operator = 'mtn' | 'orange' | 'moov' | 'wave' | 'airtel' | 'free' | 'mpesa';

export function normalizeOperator(value: string | undefined): Operator | undefined {
  const key = (value ?? '').toLowerCase().replace(/[\s-]/g, '_');
  if (!key) return undefined;
  if (/^(mtn|momo|mtn_momo|mtn_mobile_money)/.test(key)) return 'mtn';
  if (/^(orange|om|orange_money)/.test(key)) return 'orange';
  if (/^(moov|flooz)/.test(key)) return 'moov';
  if (key.startsWith('wave')) return 'wave';
  if (key.startsWith('airtel')) return 'airtel';
  if (/^(free|freemoney)/.test(key)) return 'free';
  if (/^(mpesa|m_pesa|safaricom)/.test(key)) return 'mpesa';
  return undefined;
}

/** Cameroon numbering plan (ART): MTN 650-654, 67x, 680-684; Orange 655-659, 69x, 685-689. */
export function cameroonOperator(number: string): Operator | undefined {
  const local = number.startsWith('237') ? number.slice(3) : number;
  if (!/^6\d{8}$/.test(local)) return undefined;
  const prefix = Number(local.slice(0, 3));
  if ((prefix >= 650 && prefix <= 654) || (prefix >= 670 && prefix <= 679) || (prefix >= 680 && prefix <= 684)) return 'mtn';
  if ((prefix >= 655 && prefix <= 659) || (prefix >= 690 && prefix <= 699) || (prefix >= 685 && prefix <= 689)) return 'orange';
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------------------------

export function header(input: WebhookInput, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(input.headers)) {
    if (key.toLowerCase() !== wanted) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

export function parseJson(raw: Buffer | string): any {
  try {
    const text = typeof raw === 'string' ? raw : raw.toString('utf8');
    return text.trim() ? JSON.parse(text) : null;
  } catch { return undefined; }
}

/** Parses `t=123,v1=abc,v1=def` style headers (Stripe, Wave). */
export function parseSignatureHeader(value: string | undefined): { timestamp?: string; signatures: Record<string, string[]> } {
  const signatures: Record<string, string[]> = {};
  let timestamp: string | undefined;
  for (const part of (value ?? '').split(',')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const item = part.slice(index + 1).trim();
    if (key === 't') timestamp = item;
    else (signatures[key] ??= []).push(item);
  }
  return { timestamp, signatures };
}

/**
 * Verifies a timestamped HMAC-SHA256 header (`t=...,v1=...`). `payload` builds the signed string from
 * the timestamp and raw body. Rejects timestamps outside ±toleranceSeconds.
 */
export function verifyTimestampedSignature(options: { header: string | undefined; secret: string | undefined; rawBody: Buffer; now: Date; toleranceSeconds: number; payload: (timestamp: string, body: Buffer) => Buffer }): boolean {
  if (!options.secret || !options.header) return false;
  const { timestamp, signatures } = parseSignatureHeader(options.header);
  const candidates = signatures.v1 ?? [];
  if (!timestamp || !/^\d{1,12}$/.test(timestamp) || !candidates.length) return false;
  if (Math.abs(Math.floor(options.now.getTime() / 1000) - Number(timestamp)) > options.toleranceSeconds) return false;
  const expected = hmacHex(options.secret, options.payload(timestamp, options.rawBody));
  return candidates.some((candidate) => safeEqual(candidate.toLowerCase(), expected));
}

/** Short HMAC binding a value into a callback URL for providers whose callbacks are not signed. */
export function urlSignature(secret: string, purpose: string, value: string): string {
  return createHmac('sha256', secret).update(`${purpose}\u0000${value}`).digest('base64url').slice(0, 32);
}

export function verifyUrlSignature(secret: string | undefined, purpose: string, value: unknown, signature: unknown): boolean {
  if (!secret || typeof value !== 'string' || typeof signature !== 'string' || !value) return false;
  return safeEqual(signature, urlSignature(secret, purpose, value));
}

export function queryString(input: WebhookInput, key: string): string | undefined {
  const value = input.query[key];
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : undefined;
  return typeof value === 'string' ? value : undefined;
}

/** Deterministic RFC 4122 v4-shaped UUID so retries reuse the same provider reference (MTN X-Reference-Id). */
export function deterministicUuid(namespace: string, value: string): string {
  const hash = createHash('sha256').update(`${namespace}\u0000${value}`).digest().subarray(0, 16);
  hash[6] = (hash[6] & 0x0f) | 0x40;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function mapStatus(value: unknown, table: Record<string, ProviderStatus>, fallback: ProviderStatus = 'pending'): ProviderStatus {
  return typeof value === 'string' ? table[value.toUpperCase()] ?? fallback : fallback;
}

/** Validates the optional `currency` setting against the provider list. */
export function currencySettingProblems(config: ProviderConfig, allowed: readonly string[]): string[] {
  const currency = config.settings.currency;
  return currency && !allowed.includes(currency) ? [`La devise ${currency} n’est pas disponible dans cet environnement.`] : [];
}

export function noWhitespace(value: string | undefined, label: string): string[] {
  return value && /\s/.test(value) ? [`${label} ne doit pas contenir d’espaces.`] : [];
}
