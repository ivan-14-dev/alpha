import { createHmac } from 'node:crypto';
import { safeEqual } from '../../platform/secrets.js';
import {
  assertAmount, assertCurrency, baseUrl, baseUrlProblems, callProvider, cameroonOperator, currencySettingProblems, fail, fromMajor,
  header, mapStatus, msisdn, normalizeOperator, parseJson, sanitizeText, scrub, toWholeMajor, verifyTimestampedSignature,
} from './http.js';
import type { OperationResult, PaymentProvider, ProviderConfig, ProviderContext, ProviderStatus, StatusResult, WebhookEvent } from './types.js';

/**
 * Kratos Pay (Cameroon mobile money aggregator). Docs: https://kratospay.com/developers/docs/overview
 * Documented: `X-MoK-Public-Key` header only (no secret key, no applicationId), POST {base}/api/v1/live/payin and
 * /payout with {amount, currency: 'XAF', phoneNumber, operator, reference, description}, statuses PENDING / SUCCESS /
 * FAILED, HMAC-signed webhooks and idempotency keys.
 * Not publicly documented (configurable, see docs/v4/payment-providers.md): the status endpoint path, the sandbox path
 * prefix, the webhook signature header name and the idempotency header name.
 */
const ID = 'kratos_pay' as const;
const API = { sandbox: 'https://dev-aggregator-api.kratospay.com', live: 'https://dev-aggregator-api.kratospay.com' };
const PREFIX = { sandbox: '/api/v1/sandbox', live: '/api/v1/live' };
const CURRENCIES = ['XAF'] as const;
const OPERATORS: Record<string, string> = { mtn: 'mtn_momo_cm', orange: 'orange_money_cm' };
const STATUS: Record<string, ProviderStatus> = { SUCCESS: 'succeeded', SUCCESSFUL: 'succeeded', COMPLETED: 'succeeded', FAILED: 'failed', CANCELLED: 'cancelled', CANCELED: 'cancelled', EXPIRED: 'cancelled', PENDING: 'pending', PROCESSING: 'pending', INITIATED: 'pending' };
const WEBHOOK_TOLERANCE_SECONDS = 300;
const DEFAULT_SIGNATURE_HEADER = 'X-MoK-Signature';

function prefix(config: ProviderConfig) {
  return (config.settings.api_path?.trim() || PREFIX[config.environment]).replace(/\/+$/, '');
}

function statusPath(config: ProviderConfig, kind: 'collection' | 'payout' | 'refund', reference: string) {
  const template = config.settings.status_path?.trim() || `${prefix(config)}/transactions/{reference}`;
  return template.replace('{reference}', encodeURIComponent(reference)).replace('{kind}', kind === 'collection' ? 'payin' : 'payout');
}

async function api<T = any>(config: ProviderConfig, context: ProviderContext, method: 'GET' | 'POST', path: string, json?: unknown, idempotencyKey?: string, accept?: number[]) {
  return callProvider<T>(ID, config, context, {
    method,
    url: `${baseUrl(config, API)}${path}`,
    headers: { 'X-MoK-Public-Key': config.secrets.public_key ?? '', 'Idempotency-Key': idempotencyKey },
    json,
    accept,
  });
}

/** Kratos operator code: explicit operator first, then the Cameroon numbering plan. */
export function kratosOperator(operator: string | undefined, phone: string): string {
  if (operator && Object.values(OPERATORS).includes(operator)) return operator;
  const normalized = normalizeOperator(operator) ?? cameroonOperator(phone);
  const code = normalized ? OPERATORS[normalized] : undefined;
  if (!code) fail(ID, 'Opérateur mobile non pris en charge par Kratos Pay (MTN ou Orange Cameroun).');
  return code;
}

function transactionResult(data: any, providerReference: string): StatusResult {
  const currency = typeof data.currency === 'string' ? data.currency.toUpperCase() : 'XAF';
  const status = mapStatus(data.status, STATUS);
  return {
    status,
    providerReference,
    amountMinor: fromMajor(data.amount, currency),
    currency,
    failureReason: status === 'failed' ? `Kratos Pay : ${sanitizeText(String(data.gatewayMessage ?? data.message ?? 'transaction refusée'))}` : undefined,
    raw: scrub({ status: data.status, reference: data.reference, transaction_id: data.transaction_id ?? data.transactionId }),
  };
}

async function submit(config: ProviderConfig, context: ProviderContext, kind: 'payin' | 'payout', body: Record<string, unknown>, reference: string) {
  const data = (await api(config, context, 'POST', `${prefix(config)}/${kind}`, body, `alpha-${kind}-${reference}`)).data ?? {};
  const status = mapStatus(data.status, STATUS);
  if (status === 'failed') {
    fail(ID, `Kratos Pay a refusé l’opération${data.gatewayMessage ? ` : ${sanitizeText(String(data.gatewayMessage), Object.values(config.secrets))}` : '.'}`);
  }
  return { status, data };
}

function verifySignature(config: ProviderConfig, value: string | undefined, rawBody: Buffer, now: Date): boolean {
  const secret = config.secrets.webhook_secret;
  if (!secret || !value) return false;
  if (/(^|,)\s*t=/.test(value)) {
    return verifyTimestampedSignature({ header: value, secret, rawBody, now, toleranceSeconds: WEBHOOK_TOLERANCE_SECONDS, payload: (t, body) => Buffer.concat([Buffer.from(`${t}.`), body]) });
  }
  const signature = value.replace(/^sha256=/i, '').trim();
  const digest = createHmac('sha256', secret).update(rawBody).digest();
  return safeEqual(signature.toLowerCase(), digest.toString('hex')) || safeEqual(signature, digest.toString('base64'));
}

export const kratosPay: PaymentProvider = {
  id: ID,
  label: 'Kratos Pay (agrégateur mobile money Cameroun)',
  countries: ['CM'],
  currencies: [...CURRENCIES],
  methods: ['mobile_money'],
  capabilities: { collect: true, payout: true, refund: false, webhooks: 'signed' },
  fields: [
    { key: 'public_key', label: 'Clé publique (X-MoK-Public-Key)', secret: true, required: true, help: 'Clé publique Sandbox ou Live du tableau de bord Kratos Pay. Elle reste côté serveur.' },
    { key: 'webhook_secret', label: 'Secret de signature des webhooks', secret: true, required: true, help: 'Secret HMAC des webhooks fourni par Kratos Pay.' },
    { key: 'currency', label: 'Devise de collecte', secret: false, required: true, options: [...CURRENCIES] },
    { key: 'webhook_signature_header', label: 'En-tête de signature des webhooks', secret: false, required: false, placeholder: DEFAULT_SIGNATURE_HEADER, help: 'À confirmer auprès de Kratos Pay si différent.' },
    { key: 'api_path', label: 'Préfixe des chemins d’API', secret: false, required: false, placeholder: '/api/v1/live', help: 'Par défaut /api/v1/live en production et /api/v1/sandbox en bac à sable.' },
    { key: 'status_path', label: 'Chemin de consultation d’une transaction', secret: false, required: false, placeholder: '/api/v1/live/transactions/{reference}', help: 'Variables : {reference}, {kind} (payin ou payout).' },
    { key: 'base_url', label: 'URL d’API personnalisée', secret: false, required: false, placeholder: 'https://dev-aggregator-api.kratospay.com' },
  ],
  docsUrl: 'https://kratospay.com/developers/docs/overview',
  validateConfig(config) {
    const problems = [...baseUrlProblems(config), ...currencySettingProblems(config, CURRENCIES)];
    const key = config.secrets.public_key;
    if (key && !/^[A-Za-z0-9_.-]{8,}$/.test(key)) problems.push('La clé publique Kratos Pay est invalide.');
    const secret = config.secrets.webhook_secret;
    if (secret && secret.length < 16) problems.push('Le secret des webhooks Kratos Pay semble trop court.');
    const headerName = config.settings.webhook_signature_header;
    if (headerName && !/^[A-Za-z0-9-]{1,64}$/.test(headerName)) problems.push('Nom d’en-tête de signature invalide.');
    for (const [key, label] of [['api_path', 'Le préfixe des chemins'], ['status_path', 'Le chemin de consultation']] as const) {
      const value = config.settings[key]?.trim();
      if (value && !/^\/[A-Za-z0-9_\-/{}.]*$/.test(value)) problems.push(`${label} doit commencer par « / » et ne contenir ni espace ni paramètre.`);
    }
    if (config.settings.status_path && !config.settings.status_path.includes('{reference}')) problems.push('Le chemin de consultation doit contenir {reference}.');
    if (config.environment === 'live' && config.settings.api_path && /sandbox|test/i.test(config.settings.api_path)) problems.push('Le préfixe d’API pointe vers le bac à sable alors que l’environnement est en production.');
    return problems;
  },

  async collect(config, request, context) {
    assertAmount(ID, request.amountMinor);
    assertCurrency(ID, request.currency, CURRENCIES);
    const phoneNumber = msisdn(ID, request.customer.phone, 'CM');
    const amount = toWholeMajor(ID, request.amountMinor, request.currency);
    const { status, data } = await submit(config, context, 'payin', {
      amount,
      currency: request.currency,
      phoneNumber,
      operator: kratosOperator(request.operator, phoneNumber),
      reference: request.reference,
      description: request.description.slice(0, 120) || 'Paiement Alpha',
    }, request.reference);
    return {
      kind: 'pending_approval',
      providerReference: request.reference,
      instructions: status === 'succeeded'
        ? 'Paiement confirmé par l’opérateur.'
        : `Validez la demande de paiement de ${amount} XAF reçue sur votre téléphone en saisissant votre code secret Mobile Money.`,
      raw: scrub({ status: data.status, reference: data.reference, transaction_id: data.transaction_id ?? data.transactionId }),
    };
  },

  async status(config, kind, providerReference, context) {
    const response = await api(config, context, 'GET', statusPath(config, kind, providerReference), undefined, undefined, [404]);
    if (!response.ok) return { status: 'pending', providerReference };
    const data = response.data?.data && typeof response.data.data === 'object' ? response.data.data : response.data ?? {};
    if (data.reference !== undefined && String(data.reference) !== providerReference) fail(ID, 'Kratos Pay a renvoyé une transaction qui ne correspond pas à la référence.');
    return transactionResult(data, providerReference);
  },

  async payout(config, request, context): Promise<OperationResult> {
    assertAmount(ID, request.amountMinor);
    assertCurrency(ID, request.currency, CURRENCIES);
    const phoneNumber = msisdn(ID, request.recipient.phone, 'CM');
    const { status, data } = await submit(config, context, 'payout', {
      amount: toWholeMajor(ID, request.amountMinor, request.currency),
      currency: request.currency,
      phoneNumber,
      operator: kratosOperator(request.recipient.operator, phoneNumber),
      reference: request.reference,
      description: request.description.slice(0, 120) || 'Versement Alpha',
    }, request.reference);
    return { status, providerReference: request.reference, raw: scrub({ status: data.status, reference: data.reference, transaction_id: data.transaction_id ?? data.transactionId }) };
  },

  async verifyWebhook(config, input, context) {
    const headerName = config.settings.webhook_signature_header?.trim() || DEFAULT_SIGNATURE_HEADER;
    if (!verifySignature(config, header(input, headerName), input.rawBody, context.now())) return null;
    const payload = parseJson(input.rawBody);
    if (!payload || typeof payload !== 'object') return null;
    const data = payload.data && typeof payload.data === 'object' ? payload.data : payload;
    const reference = typeof data.reference === 'string' ? data.reference : undefined;
    if (!reference) return [];
    const kindHint = String(payload.event ?? payload.type ?? data.type ?? data.transaction_type ?? data.operation ?? '').toLowerCase();
    const type: WebhookEvent['type'] = /payout|cash_?out|withdraw|disburse/.test(kindHint) ? 'payout' : 'collection';
    const result = transactionResult(data, reference);
    const transactionId = data.transaction_id ?? data.transactionId;
    return [{
      type,
      reference,
      providerReference: reference,
      status: result.status,
      amountMinor: result.amountMinor,
      currency: result.currency,
      eventId: typeof payload.id === 'string' ? payload.id : `kratos:${transactionId ?? reference}:${String(data.status ?? '').toUpperCase()}`,
      raw: result.raw,
    }];
  },
};
