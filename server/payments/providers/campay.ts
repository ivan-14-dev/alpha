import { createHmac } from 'node:crypto';
import { safeEqual } from '../../platform/secrets.js';
import {
  assertAmount, assertCurrency, baseUrl, baseUrlProblems, callProvider, currencySettingProblems, fail, fromMajor, mapStatus,
  msisdn, parseJson, scrub, tokenCacheKey, toWholeMajor, withToken,
} from './http.js';
import type { PaymentProvider, ProviderConfig, ProviderContext, ProviderStatus, StatusResult, WebhookInput } from './types.js';

/**
 * CamPay (Cameroon, XAF, MTN Mobile Money & Orange Money). Docs: https://documenter.getpostman.com/view/2391374/T1LV8PVA
 * Auth: POST /token/ with the application username/password -> `Authorization: Token <token>`.
 * Collect: /collect/ (USSD push, customer approves on the phone) or /get_payment_link/ (hosted page).
 * Callbacks are GET requests whose query carries a `signature` JWT (HS256, signed with the "webhook key").
 */
const ID = 'campay' as const;
const CURRENCIES = ['XAF'] as const;
const API = { sandbox: 'https://demo.campay.net/api', live: 'https://www.campay.net/api' };
const STATUS: Record<string, ProviderStatus> = { SUCCESSFUL: 'succeeded', SUCCESS: 'succeeded', FAILED: 'failed', CANCELLED: 'cancelled', PENDING: 'pending' };
const JWT_LEEWAY_SECONDS = 300;

function credentials(config: ProviderConfig) {
  return { username: config.secrets.app_username ?? '', password: config.secrets.app_password ?? '' };
}

async function token(config: ProviderConfig, context: ProviderContext) {
  const response = await callProvider(ID, config, context, { method: 'POST', url: `${baseUrl(config, API)}/token/`, json: credentials(config) });
  const value = response.data?.token;
  if (typeof value !== 'string' || !value) fail(ID, 'CamPay n’a pas délivré de jeton d’accès.');
  return { token: value, expiresIn: Number(response.data?.expires_in) || 3600 };
}

async function api<T = any>(config: ProviderConfig, context: ProviderContext, method: 'GET' | 'POST', path: string, json?: unknown, accept?: number[]) {
  const { username, password } = credentials(config);
  const key = tokenCacheKey(ID, baseUrl(config, API), username, password);
  return withToken(key, context, () => token(config, context), (value) => callProvider<T>(ID, config, context, {
    method,
    url: `${baseUrl(config, API)}${path}`,
    headers: { Authorization: `Token ${value}` },
    json,
    accept,
    redact: [value],
  }));
}

function transactionResult(data: any, providerReference: string): StatusResult {
  const currency = typeof data.currency === 'string' ? data.currency.toUpperCase() : 'XAF';
  const status = mapStatus(data.status, STATUS);
  return {
    status,
    providerReference,
    amountMinor: fromMajor(data.amount, currency),
    currency,
    failureReason: status === 'failed' ? `Transaction refusée par l’opérateur${data.code ? ` (${String(data.code).slice(0, 40)})` : ''}.` : undefined,
    raw: scrub({ reference: data.reference, status: data.status, operator: data.operator, external_reference: data.external_reference }),
  };
}

function base64UrlJson(segment: string): any {
  try { return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')); }
  catch { return undefined; }
}

/** Verifies an HS256 JWT; returns its claims or null. */
export function verifyCampayJwt(jwt: string | undefined, key: string | undefined, now: Date): Record<string, unknown> | null {
  if (!jwt || !key) return null;
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  const head = base64UrlJson(parts[0]);
  if (!head || head.alg !== 'HS256') return null;
  const expected = createHmac('sha256', key).update(`${parts[0]}.${parts[1]}`).digest('base64url');
  if (!safeEqual(parts[2], expected)) return null;
  const claims = base64UrlJson(parts[1]);
  if (!claims || typeof claims !== 'object') return null;
  const seconds = Math.floor(now.getTime() / 1000);
  if (typeof claims.exp === 'number' && seconds > claims.exp + JWT_LEEWAY_SECONDS) return null;
  if (typeof claims.nbf === 'number' && seconds + JWT_LEEWAY_SECONDS < claims.nbf) return null;
  return claims;
}

function callbackParams(input: WebhookInput): Record<string, string> {
  const params: Record<string, string> = {};
  const assign = (source: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(source)) {
      const item = Array.isArray(value) ? value[0] : value;
      if (typeof item === 'string' || typeof item === 'number') params[key] = String(item);
    }
  };
  const text = input.rawBody.toString('utf8').trim();
  if (text) {
    const json = parseJson(text);
    if (json && typeof json === 'object') assign(json);
    else if (json === undefined) assign(Object.fromEntries(new URLSearchParams(text)));
  }
  // Query parameters (GET callbacks) take precedence over the body.
  assign(input.query);
  return params;
}

export const campay: PaymentProvider = {
  id: ID,
  label: 'CamPay (MTN MoMo & Orange Money Cameroun)',
  countries: ['CM'],
  currencies: [...CURRENCIES],
  methods: ['mobile_money'],
  capabilities: { collect: true, payout: true, refund: false, webhooks: 'signed' },
  fields: [
    { key: 'app_username', label: 'Nom d’utilisateur de l’application', secret: true, required: true, help: 'CamPay → Applications → identifiants d’accès API (App username).' },
    { key: 'app_password', label: 'Mot de passe de l’application', secret: true, required: true },
    { key: 'webhook_key', label: 'Clé webhook (signature JWT)', secret: true, required: true, help: 'CamPay → Applications → « Webhook key ». Sert à vérifier le paramètre signature des callbacks.' },
    { key: 'currency', label: 'Devise de collecte', secret: false, required: true, options: [...CURRENCIES] },
    { key: 'collect_mode', label: 'Mode d’encaissement', secret: false, required: false, options: ['ussd', 'payment_link'], help: 'ussd : demande de validation envoyée au téléphone du client (numéro requis). payment_link : page CamPay hébergée.' },
    { key: 'base_url', label: 'URL d’API personnalisée (tests uniquement)', secret: false, required: false, placeholder: 'https://demo.campay.net/api' },
  ],
  docsUrl: 'https://documenter.getpostman.com/view/2391374/T1LV8PVA',
  validateConfig(config) {
    const problems = [...baseUrlProblems(config), ...currencySettingProblems(config, CURRENCIES)];
    const key = config.secrets.webhook_key;
    if (key && key.length < 8) problems.push('La clé webhook CamPay semble trop courte.');
    const username = config.secrets.app_username;
    if (username && /\s/.test(username)) problems.push('Le nom d’utilisateur CamPay ne doit pas contenir d’espaces.');
    return problems;
  },

  async collect(config, request, context) {
    assertAmount(ID, request.amountMinor);
    assertCurrency(ID, request.currency, CURRENCIES);
    const amount = String(toWholeMajor(ID, request.amountMinor, request.currency));
    const description = request.description.slice(0, 100) || 'Paiement Alpha';
    const usePaymentLink = config.settings.collect_mode === 'payment_link' || (!request.customer.phone && config.settings.collect_mode !== 'ussd');
    if (usePaymentLink) {
      const response = await api(config, context, 'POST', '/get_payment_link/', {
        amount,
        currency: request.currency,
        description,
        external_reference: request.reference,
        redirect_url: request.returnUrl,
        failure_redirect_url: request.cancelUrl,
        payment_options: 'MOMO',
      });
      const link = response.data?.link;
      if (typeof link !== 'string') fail(ID, 'CamPay n’a pas renvoyé de lien de paiement.');
      const reference = typeof response.data?.reference === 'string' ? response.data.reference : request.reference;
      return { kind: 'redirect', url: link, providerReference: reference, raw: scrub({ reference }) };
    }
    const response = await api(config, context, 'POST', '/collect/', {
      amount,
      currency: request.currency,
      from: msisdn(ID, request.customer.phone, 'CM'),
      description,
      external_reference: request.reference,
    });
    const data = response.data ?? {};
    if (typeof data.reference !== 'string') fail(ID, 'CamPay n’a pas renvoyé de référence de transaction.');
    const operator = typeof data.operator === 'string' ? ` ${data.operator}` : '';
    const ussd = typeof data.ussd_code === 'string' && /^[*#\d]+$/.test(data.ussd_code) ? ` (ou composez ${data.ussd_code})` : '';
    return {
      kind: 'pending_approval',
      providerReference: data.reference,
      instructions: `Validez la demande de paiement de ${amount} XAF reçue sur votre téléphone${operator}${ussd} en saisissant votre code secret Mobile Money.`,
      raw: scrub({ reference: data.reference, operator: data.operator }),
    };
  },

  async status(config, _kind, providerReference, context) {
    const response = await api(config, context, 'GET', `/transaction/${encodeURIComponent(providerReference)}/`, undefined, [400, 404]);
    if (!response.ok) return { status: 'pending', providerReference };
    return transactionResult(response.data ?? {}, providerReference);
  },

  async payout(config, request, context) {
    assertAmount(ID, request.amountMinor);
    assertCurrency(ID, request.currency, CURRENCIES);
    const response = await api(config, context, 'POST', '/withdraw/', {
      amount: String(toWholeMajor(ID, request.amountMinor, request.currency)),
      currency: request.currency,
      to: msisdn(ID, request.recipient.phone, 'CM'),
      description: request.description.slice(0, 100) || 'Versement Alpha',
      external_reference: request.reference,
    });
    const data = response.data ?? {};
    if (typeof data.reference !== 'string') fail(ID, 'CamPay n’a pas renvoyé de référence de retrait.');
    const status = mapStatus(data.status, STATUS);
    return { status, providerReference: data.reference, failureReason: status === 'failed' ? 'Retrait refusé par CamPay.' : undefined, raw: scrub({ reference: data.reference, status: data.status }) };
  },

  async verifyWebhook(config, input, context) {
    const params = callbackParams(input);
    const claims = verifyCampayJwt(params.signature, config.secrets.webhook_key, context.now());
    if (!claims) return null;
    for (const key of ['reference', 'external_reference', 'status', 'amount']) {
      if (claims[key] !== undefined && params[key] !== undefined && String(claims[key]) !== params[key]) return null;
    }
    const providerReference = params.reference;
    if (!providerReference) return [];
    const status = mapStatus(params.status, STATUS);
    const currency = (params.currency || 'XAF').toUpperCase();
    return [{
      type: params.endpoint === 'withdraw' ? 'payout' : 'collection',
      reference: params.external_reference || undefined,
      providerReference,
      status,
      amountMinor: fromMajor(params.amount, currency),
      currency,
      eventId: `campay:${providerReference}:${status}`,
      raw: scrub({ reference: providerReference, status: params.status, operator: params.operator, endpoint: params.endpoint }),
    }];
  },
};
