import {
  assertAmount, assertCurrency, basicAuth, baseUrl, baseUrlProblems, callProvider, deterministicUuid, fail, fromMajor, mapStatus,
  msisdn, queryString, scrub, toMajorString, tokenCacheKey, urlSignature, verifyUrlSignature, withToken,
} from './http.js';
import type { OperationResult, PaymentProvider, ProviderConfig, ProviderContext, ProviderStatus, StatusResult, WebhookInput } from './types.js';

/**
 * MTN MoMo Open API (Collection + Disbursement). Docs: https://momodeveloper.mtn.com/api-documentation
 * - Token: POST /{product}/token/ with Basic(apiUser:apiKey), Ocp-Apim-Subscription-Key and X-Target-Environment.
 * - Request to pay: POST /collection/v1_0/requesttopay (202, X-Reference-Id = UUID chosen by us).
 * - Payouts: POST /disbursement/v1_0/transfer; refunds: POST /disbursement/v1_0/refund.
 * Callbacks (X-Callback-Url) are NOT signed by MTN: we bind the reference into the callback URL with an HMAC
 * and always report 'pending' so the payments module re-confirms with status().
 * Production base URL: https://momoapi.momo.africa (MTN "One API" migration, replaces proxy.momoapi.mtn.com).
 */
const ID = 'mtn_momo' as const;
const API = { sandbox: 'https://sandbox.momodeveloper.mtn.com', live: 'https://momoapi.momo.africa' };

export const MTN_TARGETS: Record<string, { currency: string; country?: string }> = {
  sandbox: { currency: 'EUR' },
  mtncameroon: { currency: 'XAF', country: 'CM' },
  mtnivorycoast: { currency: 'XOF', country: 'CI' },
  mtnbenin: { currency: 'XOF', country: 'BJ' },
  mtncongo: { currency: 'XAF', country: 'CG' },
  mtnguineaconakry: { currency: 'GNF', country: 'GN' },
  mtnuganda: { currency: 'UGX', country: 'UG' },
  mtnghana: { currency: 'GHS', country: 'GH' },
};
const CURRENCIES = [...new Set(Object.values(MTN_TARGETS).map((item) => item.currency))];
const STATUS: Record<string, ProviderStatus> = { SUCCESSFUL: 'succeeded', FAILED: 'failed', REJECTED: 'failed', TIMEOUT: 'failed', PENDING: 'pending', CREATED: 'pending', ONGOING: 'pending' };
const CANCELLED_REASONS = new Set(['APPROVAL_REJECTED', 'EXPIRED', 'TRANSACTION_CANCELED', 'NOT_ALLOWED_TARGET_ENVIRONMENT_CANCELED']);

type Product = 'collection' | 'disbursement';
type Kind = 'collection' | 'payout' | 'refund';

function target(config: ProviderConfig): string {
  return config.settings.target_environment || (config.environment === 'sandbox' ? 'sandbox' : '');
}

function credentials(config: ProviderConfig, product: Product) {
  return {
    subscriptionKey: config.secrets[`${product}_subscription_key`] ?? '',
    apiUser: config.secrets[`${product}_api_user`] ?? '',
    apiKey: config.secrets[`${product}_api_key`] ?? '',
  };
}

function disbursementConfigured(config: ProviderConfig) {
  const { subscriptionKey, apiUser, apiKey } = credentials(config, 'disbursement');
  return !!(subscriptionKey && apiUser && apiKey);
}

const productOf = (kind: Kind): Product => (kind === 'collection' ? 'collection' : 'disbursement');

/** Deterministic X-Reference-Id so a retried request reuses the same MTN transaction (409 = already created). */
export function mtnReferenceId(config: ProviderConfig, kind: Kind, reference: string) {
  return deterministicUuid(`mtn:${kind}:${credentials(config, productOf(kind)).apiUser}`, reference);
}

async function token(config: ProviderConfig, context: ProviderContext, product: Product) {
  const { subscriptionKey, apiUser, apiKey } = credentials(config, product);
  const response = await callProvider(ID, config, context, {
    method: 'POST',
    url: `${baseUrl(config, API)}/${product}/token/`,
    headers: { Authorization: basicAuth(apiUser, apiKey), 'Ocp-Apim-Subscription-Key': subscriptionKey, 'X-Target-Environment': target(config) },
  });
  const value = response.data?.access_token;
  if (typeof value !== 'string' || !value) fail(ID, 'MTN MoMo n’a pas délivré de jeton d’accès.');
  return { token: value, expiresIn: Number(response.data?.expires_in) || 3600 };
}

async function api<T = any>(config: ProviderConfig, context: ProviderContext, product: Product, method: 'GET' | 'POST', path: string, extra: { json?: unknown; headers?: Record<string, string | undefined>; accept?: number[] } = {}) {
  if (product === 'disbursement' && !disbursementConfigured(config)) fail(ID, 'Les identifiants MTN MoMo Disbursement ne sont pas configurés.');
  const { subscriptionKey, apiUser, apiKey } = credentials(config, product);
  const key = tokenCacheKey(ID, product, baseUrl(config, API), target(config), apiUser, apiKey);
  return withToken(key, context, () => token(config, context, product), (value) => callProvider<T>(ID, config, context, {
    method,
    url: `${baseUrl(config, API)}${path}`,
    headers: { Authorization: `Bearer ${value}`, 'Ocp-Apim-Subscription-Key': subscriptionKey, 'X-Target-Environment': target(config), ...extra.headers },
    json: extra.json,
    accept: extra.accept,
    redact: [value],
  }));
}

function callbackUrl(config: ProviderConfig, context: ProviderContext, kind: Kind, reference: string): string | undefined {
  // MTN requires HTTPS callbacks (and, in sandbox, the host registered as providerCallbackHost).
  if (!/^https:\/\//.test(context.webhookUrl)) return undefined;
  const secret = credentials(config, productOf(kind)).apiKey;
  const url = new URL(context.webhookUrl);
  url.searchParams.set('kind', kind);
  url.searchParams.set('ref', reference);
  url.searchParams.set('sig', urlSignature(secret, `mtn:${kind}`, reference));
  return url.toString();
}

function payerPhone(config: ProviderConfig, phone: string | undefined) {
  return msisdn(ID, phone, MTN_TARGETS[target(config)]?.country);
}

function statusResult(data: any, providerReference: string): StatusResult {
  const currency = typeof data.currency === 'string' ? data.currency.toUpperCase() : undefined;
  let status = mapStatus(data.status, STATUS);
  const reason = typeof data.reason === 'string' ? data.reason : typeof data.reason?.code === 'string' ? data.reason.code : undefined;
  if (status === 'failed' && reason && CANCELLED_REASONS.has(reason.toUpperCase())) status = 'cancelled';
  return {
    status,
    providerReference,
    amountMinor: fromMajor(data.amount, currency),
    currency,
    failureReason: status === 'failed' || status === 'cancelled' ? `MTN MoMo : ${(reason ?? 'transaction refusée').slice(0, 80)}` : undefined,
    raw: scrub({ status: data.status, reason, externalId: data.externalId, financialTransactionId: data.financialTransactionId }),
  };
}

async function submit(config: ProviderConfig, context: ProviderContext, kind: Kind, path: string, reference: string, body: Record<string, unknown>): Promise<OperationResult> {
  const referenceId = mtnReferenceId(config, kind, reference);
  const response = await api(config, context, productOf(kind), 'POST', path, {
    json: body,
    headers: { 'X-Reference-Id': referenceId, 'X-Callback-Url': callbackUrl(config, context, kind, reference) },
    accept: [409],
  });
  // 409 Conflict = this X-Reference-Id already exists (idempotent retry): the original request stands.
  return { status: 'pending', providerReference: referenceId, raw: { httpStatus: response.status } };
}

export const mtnMomo: PaymentProvider = {
  id: ID,
  label: 'MTN Mobile Money (MoMo Open API)',
  countries: ['CM', 'CI', 'BJ', 'CG', 'GN', 'UG', 'GH'],
  currencies: CURRENCIES,
  methods: ['mobile_money'],
  capabilities: { collect: true, payout: true, refund: true, webhooks: 'unsigned' },
  fields: [
    { key: 'target_environment', label: 'Environnement cible (X-Target-Environment)', secret: false, required: true, options: Object.keys(MTN_TARGETS), help: '« sandbox » pour le bac à sable (devise EUR), sinon le marché MTN de votre contrat (ex. mtncameroon).' },
    { key: 'currency', label: 'Devise de collecte', secret: false, required: true, options: CURRENCIES },
    { key: 'collection_subscription_key', label: 'Clé d’abonnement Collection (Ocp-Apim-Subscription-Key)', secret: true, required: true },
    { key: 'collection_api_user', label: 'API User / User ID Collection', secret: true, required: true },
    { key: 'collection_api_key', label: 'API Key / Credential Token Collection', secret: true, required: true },
    { key: 'disbursement_subscription_key', label: 'Clé d’abonnement Disbursement (versements, remboursements)', secret: true, required: false },
    { key: 'disbursement_api_user', label: 'API User / User ID Disbursement', secret: true, required: false },
    { key: 'disbursement_api_key', label: 'API Key / Credential Token Disbursement', secret: true, required: false },
    { key: 'base_url', label: 'URL d’API personnalisée', secret: false, required: false, placeholder: 'https://momoapi.momo.africa', help: 'Laissez vide : bac à sable = sandbox.momodeveloper.mtn.com, production = momoapi.momo.africa.' },
  ],
  docsUrl: 'https://momodeveloper.mtn.com/api-documentation',
  validateConfig(config) {
    const problems = baseUrlProblems(config);
    const env = config.settings.target_environment;
    if (env) {
      const info = MTN_TARGETS[env];
      if (!info) problems.push('Environnement cible MTN inconnu.');
      else {
        if (config.environment === 'sandbox' && env !== 'sandbox') problems.push('En bac à sable, l’environnement cible MTN doit être « sandbox ».');
        if (config.environment === 'live' && env === 'sandbox') problems.push('En production, choisissez l’environnement cible MTN de votre pays (ex. mtncameroon).');
        const currency = config.settings.currency;
        if (currency && currency !== info.currency) problems.push(`L’environnement ${env} n’accepte que la devise ${info.currency}.`);
      }
    }
    // Sandbox API users are UUIDs; "One API" production credentials use other formats (user id + credential token).
    const credentialKeys = ['collection_subscription_key', 'collection_api_user', 'collection_api_key', 'disbursement_subscription_key', 'disbursement_api_user', 'disbursement_api_key'];
    if (credentialKeys.some((key) => /\s/.test(config.secrets[key] ?? ''))) problems.push('Les identifiants MTN MoMo ne doivent pas contenir d’espaces.');
    if (config.environment === 'sandbox') {
      for (const product of ['collection', 'disbursement'] as const) {
        const user = config.secrets[`${product}_api_user`];
        if (user && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(user)) problems.push(`En bac à sable, l’API User ${product === 'collection' ? 'Collection' : 'Disbursement'} doit être un UUID.`);
      }
    }
    const disbursement = ['disbursement_subscription_key', 'disbursement_api_user', 'disbursement_api_key'].filter((key) => config.secrets[key]);
    if (disbursement.length > 0 && disbursement.length < 3) problems.push('Renseignez les trois identifiants Disbursement (clé d’abonnement, API User, API Key) ou aucun.');
    return problems;
  },

  async collect(config, request, context) {
    assertAmount(ID, request.amountMinor);
    assertCurrency(ID, request.currency, [MTN_TARGETS[target(config)]?.currency ?? ''].filter(Boolean));
    const result = await submit(config, context, 'collection', '/collection/v1_0/requesttopay', request.reference, {
      amount: toMajorString(request.amountMinor, request.currency),
      currency: request.currency,
      externalId: request.reference,
      payer: { partyIdType: 'MSISDN', partyId: payerPhone(config, request.customer.phone) },
      payerMessage: request.description.slice(0, 160) || 'Paiement Alpha',
      payeeNote: request.reference,
    });
    return {
      kind: 'pending_approval',
      providerReference: result.providerReference,
      instructions: 'Validez la demande de paiement MTN Mobile Money reçue sur votre téléphone (ou composez *126# au Cameroun) en saisissant votre code secret.',
      raw: result.raw,
    };
  },

  async status(config, kind, providerReference, context) {
    const path = kind === 'collection' ? '/collection/v1_0/requesttopay/' : kind === 'payout' ? '/disbursement/v1_0/transfer/' : '/disbursement/v1_0/refund/';
    const response = await api(config, context, productOf(kind), 'GET', `${path}${encodeURIComponent(providerReference)}`, { accept: [404] });
    if (!response.ok) return { status: 'pending', providerReference };
    return statusResult(response.data ?? {}, providerReference);
  },

  async payout(config, request, context) {
    assertAmount(ID, request.amountMinor);
    assertCurrency(ID, request.currency, [MTN_TARGETS[target(config)]?.currency ?? ''].filter(Boolean));
    return submit(config, context, 'payout', '/disbursement/v1_0/transfer', request.reference, {
      amount: toMajorString(request.amountMinor, request.currency),
      currency: request.currency,
      externalId: request.reference,
      payee: { partyIdType: 'MSISDN', partyId: payerPhone(config, request.recipient.phone) },
      payerMessage: request.description.slice(0, 160) || 'Versement Alpha',
      payeeNote: request.reference,
    });
  },

  async refund(config, request, context) {
    assertAmount(ID, request.amountMinor);
    assertCurrency(ID, request.currency, [MTN_TARGETS[target(config)]?.currency ?? ''].filter(Boolean));
    return submit(config, context, 'refund', '/disbursement/v1_0/refund', request.reference, {
      amount: toMajorString(request.amountMinor, request.currency),
      currency: request.currency,
      externalId: request.reference,
      payerMessage: request.reason.slice(0, 160) || 'Remboursement Alpha',
      payeeNote: request.reference,
      referenceIdToRefund: request.providerReference,
    });
  },

  async verifyWebhook(config, input: WebhookInput) {
    const kind = queryString(input, 'kind');
    const reference = queryString(input, 'ref');
    if (kind !== 'collection' && kind !== 'payout' && kind !== 'refund') return null;
    const product = productOf(kind);
    if (!verifyUrlSignature(credentials(config, product).apiKey, `mtn:${kind}`, reference, queryString(input, 'sig'))) return null;
    let bodyStatus = 'callback';
    try {
      const body = JSON.parse(input.rawBody.toString('utf8') || '{}');
      if (typeof body?.status === 'string' && /^[A-Z_]{1,20}$/i.test(body.status)) bodyStatus = body.status.toUpperCase();
    } catch { /* unsigned body: ignored */ }
    // Unsigned callback: only the (HMAC-bound) reference is trusted; the module must re-check with status().
    return [{
      type: kind,
      reference: reference!,
      providerReference: mtnReferenceId(config, kind, reference!),
      status: 'pending',
      eventId: `mtn:${kind}:${reference}:${bodyStatus}`,
    }];
  },
};
