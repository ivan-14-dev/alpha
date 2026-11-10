import { hmacHex, safeEqual } from '../../platform/secrets.js';
import {
  assertAmount, assertCurrency, baseUrl, baseUrlProblems, callProvider, currencySettingProblems, fail, fromMajor, header, mapStatus,
  msisdn, noWhitespace, parseJson, scrub, serializeBody, toMajorString, verifyTimestampedSignature,
} from './http.js';
import type { OperationResult, PaymentProvider, ProviderConfig, ProviderContext, ProviderStatus, StatusResult, WebhookEvent } from './types.js';

/**
 * Wave Business APIs (Senegal, Côte d'Ivoire...). Docs: https://docs.wave.com/checkout , https://docs.wave.com/payout
 * - Checkout: POST /v1/checkout/sessions (amount as a decimal string, XOF has no decimals) -> wave_launch_url.
 * - Refund: POST /v1/checkout/sessions/:id/refund (full refund only, synchronous).
 * - Payout: POST /v1/payout with an `idempotency-key` header.
 * - Webhooks: `Wave-Signature: t=<ts>,v1=<hex>` = HMAC-SHA256(webhook secret, ts + raw body) (no separator),
 *   or the "shared secret" strategy (`Authorization: Bearer <webhook secret>`).
 * - Optional request signing (API keys created with "signing" enabled): same header on our requests.
 * Wave has no public sandbox: "sandbox" uses the same host with a test/limited API key.
 */
const ID = 'wave' as const;
const API = { sandbox: 'https://api.wave.com', live: 'https://api.wave.com' };
const CURRENCIES = ['XOF'] as const;
const WEBHOOK_TOLERANCE_SECONDS = 300;
const PAYOUT: Record<string, ProviderStatus> = { SUCCEEDED: 'succeeded', FAILED: 'failed', REVERSED: 'failed', PROCESSING: 'pending' };

async function api<T = any>(config: ProviderConfig, context: ProviderContext, method: 'GET' | 'POST', path: string, json?: unknown, idempotencyKey?: string) {
  const prepared = serializeBody({ json });
  const headers: Record<string, string | undefined> = { Authorization: `Bearer ${config.secrets.api_key ?? ''}`, 'idempotency-key': idempotencyKey };
  const signingSecret = config.secrets.signing_secret;
  if (signingSecret) {
    const timestamp = String(Math.floor(context.now().getTime() / 1000));
    headers['Wave-Signature'] = `t=${timestamp},v1=${hmacHex(signingSecret, `${timestamp}${prepared.body ?? ''}`)}`;
  }
  return callProvider<T>(ID, config, context, { method, url: `${baseUrl(config, API)}${path}`, headers }, prepared);
}

function sessionResult(session: any): StatusResult {
  const currency = typeof session.currency === 'string' ? session.currency.toUpperCase() : undefined;
  let status: ProviderStatus = 'pending';
  if (session.payment_status === 'succeeded') status = 'succeeded';
  else if (session.payment_status === 'cancelled' || session.checkout_status === 'expired') status = 'cancelled';
  const error = session.last_payment_error;
  return {
    status,
    providerReference: session.id,
    amountMinor: fromMajor(session.amount, currency),
    currency,
    failureReason: status === 'cancelled' ? (typeof error?.message === 'string' ? `Wave : ${error.message.slice(0, 120)}` : 'Session Wave expirée ou annulée.') : undefined,
    raw: scrub({ id: session.id, checkout_status: session.checkout_status, payment_status: session.payment_status, transaction_id: session.transaction_id }),
  };
}

function payoutResult(payout: any): StatusResult {
  const currency = typeof payout.currency === 'string' ? payout.currency.toUpperCase() : undefined;
  const status = mapStatus(payout.status, PAYOUT);
  const error = payout.payout_error;
  return {
    status,
    providerReference: payout.id,
    amountMinor: fromMajor(payout.receive_amount, currency),
    currency,
    failureReason: status === 'failed' ? `Wave : ${String(error?.error_code ?? error?.error_message ?? payout.status).slice(0, 120)}` : undefined,
    raw: scrub({ id: payout.id, status: payout.status, client_reference: payout.client_reference }),
  };
}

function e164(phone: string | undefined, country: string | undefined) {
  return `+${msisdn(ID, phone, country)}`;
}

export const wave: PaymentProvider = {
  id: ID,
  label: 'Wave (Sénégal, Côte d’Ivoire)',
  countries: ['SN', 'CI', 'ML', 'BF'],
  currencies: [...CURRENCIES],
  methods: ['mobile_money'],
  capabilities: { collect: true, payout: true, refund: true, webhooks: 'signed' },
  fields: [
    { key: 'api_key', label: 'Clé API Wave Business', secret: true, required: true, placeholder: 'wave_sn_prod_…', help: 'Portail Wave Business → Développeurs → Clés API (permissions Checkout et, si besoin, Payout).' },
    { key: 'webhook_secret', label: 'Secret du webhook', secret: true, required: true, help: 'Affiché une seule fois à la création du webhook (portail Wave Business).' },
    { key: 'webhook_auth', label: 'Stratégie de sécurité du webhook', secret: false, required: false, options: ['signing_secret', 'shared_secret'], help: 'signing_secret (recommandé) : en-tête Wave-Signature. shared_secret : en-tête Authorization: Bearer.' },
    { key: 'signing_secret', label: 'Secret de signature des requêtes (facultatif)', secret: true, required: false, help: 'Uniquement si la clé API a été créée avec la signature des requêtes activée.' },
    { key: 'country', label: 'Pays par défaut des bénéficiaires', secret: false, required: false, options: ['SN', 'CI', 'ML', 'BF'] },
    { key: 'currency', label: 'Devise de collecte', secret: false, required: true, options: [...CURRENCIES] },
    { key: 'aggregated_merchant_id', label: 'ID marchand agrégé (facultatif)', secret: false, required: false, placeholder: 'am-…' },
    { key: 'base_url', label: 'URL d’API personnalisée (tests uniquement)', secret: false, required: false, placeholder: 'https://api.wave.com' },
  ],
  docsUrl: 'https://docs.wave.com/checkout',
  validateConfig(config) {
    const problems = [...baseUrlProblems(config), ...currencySettingProblems(config, CURRENCIES), ...noWhitespace(config.secrets.api_key, 'La clé API'), ...noWhitespace(config.secrets.webhook_secret, 'Le secret du webhook')];
    const key = config.secrets.api_key;
    if (key && !/^wave_[a-z]{2}_[A-Za-z0-9_-]+$/.test(key)) problems.push('La clé API Wave doit commencer par wave_<pays>_ (ex. wave_sn_prod_…).');
    if (key && config.environment === 'sandbox' && /_prod_/.test(key)) problems.push('Clé de production Wave détectée en bac à sable : utilisez une clé de test ou passez en production.');
    const secret = config.secrets.webhook_secret;
    if (secret && secret.length < 16) problems.push('Le secret du webhook Wave semble trop court.');
    const aggregated = config.settings.aggregated_merchant_id;
    if (aggregated && !/^am-[A-Za-z0-9_-]+$/.test(aggregated)) problems.push('L’ID marchand agrégé Wave doit commencer par am-.');
    return problems;
  },

  async collect(config, request, context) {
    assertAmount(ID, request.amountMinor);
    assertCurrency(ID, request.currency, CURRENCIES);
    const session = (await api(config, context, 'POST', '/v1/checkout/sessions', {
      amount: toMajorString(request.amountMinor, request.currency),
      currency: request.currency,
      success_url: request.returnUrl,
      error_url: request.cancelUrl,
      client_reference: request.reference,
      aggregated_merchant_id: config.settings.aggregated_merchant_id || undefined,
    }, `alpha-collect-${request.reference}`)).data ?? {};
    if (typeof session.wave_launch_url !== 'string' || typeof session.id !== 'string') fail(ID, 'Wave n’a pas renvoyé d’URL de paiement.');
    return { kind: 'redirect', url: session.wave_launch_url, providerReference: session.id, raw: scrub({ id: session.id, checkout_status: session.checkout_status }) };
  },

  async status(config, kind, providerReference, context) {
    const id = encodeURIComponent(providerReference);
    if (kind === 'payout') return payoutResult((await api(config, context, 'GET', `/v1/payout/${id}`)).data ?? {});
    const session = (await api(config, context, 'GET', `/v1/checkout/sessions/${id}`)).data ?? {};
    if (kind === 'refund') {
      // Wave refunds are synchronous (HTTP 200 = refunded): the session id doubles as refund reference.
      const result = sessionResult(session);
      return { ...result, status: 'succeeded', failureReason: undefined };
    }
    return sessionResult(session);
  },

  async payout(config, request, context): Promise<OperationResult> {
    assertAmount(ID, request.amountMinor);
    assertCurrency(ID, request.currency, CURRENCIES);
    const payout = (await api(config, context, 'POST', '/v1/payout', {
      currency: request.currency,
      receive_amount: toMajorString(request.amountMinor, request.currency),
      name: request.recipient.name.slice(0, 100),
      mobile: e164(request.recipient.phone, (request.recipient.country ?? config.settings.country)?.toUpperCase()),
      client_reference: request.reference,
      payment_reason: request.description.slice(0, 40) || undefined,
    }, `alpha-payout-${request.reference}`)).data ?? {};
    if (typeof payout.id !== 'string') fail(ID, 'Wave n’a pas renvoyé d’identifiant de versement.');
    const result = payoutResult(payout);
    return { status: result.status, providerReference: payout.id, failureReason: result.failureReason, raw: result.raw };
  },

  async refund(config, request, context): Promise<OperationResult> {
    assertAmount(ID, request.amountMinor);
    assertCurrency(ID, request.currency, CURRENCIES);
    const id = encodeURIComponent(request.providerReference);
    const session = (await api(config, context, 'GET', `/v1/checkout/sessions/${id}`)).data ?? {};
    if (session.payment_status !== 'succeeded') fail(ID, 'Seul un paiement Wave réussi peut être remboursé.');
    if (fromMajor(session.amount, request.currency) !== request.amountMinor) fail(ID, 'Wave ne permet que le remboursement intégral d’une session de paiement.');
    await api(config, context, 'POST', `/v1/checkout/sessions/${id}/refund`, undefined, `alpha-refund-${request.reference}`);
    return { status: 'succeeded', providerReference: request.providerReference, raw: scrub({ id: session.id }) };
  },

  async verifyWebhook(config, input, context) {
    const secret = config.secrets.webhook_secret;
    if (!secret) return null;
    let valid: boolean;
    if (config.settings.webhook_auth === 'shared_secret') {
      const authorization = header(input, 'authorization') ?? '';
      valid = authorization.startsWith('Bearer ') && safeEqual(authorization.slice(7), secret);
    } else {
      valid = verifyTimestampedSignature({
        header: header(input, 'wave-signature'),
        secret,
        rawBody: input.rawBody,
        now: context.now(),
        toleranceSeconds: WEBHOOK_TOLERANCE_SECONDS,
        payload: (timestamp, body) => Buffer.concat([Buffer.from(timestamp), body]),
      });
    }
    if (!valid) return null;
    const event = parseJson(input.rawBody);
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') return null;
    const data = event.data ?? {};
    const eventId = typeof event.id === 'string' ? event.id : undefined;
    const events: WebhookEvent[] = [];
    if (event.type.startsWith('checkout.session.')) {
      const result = sessionResult(data);
      let status = result.status;
      if (event.type === 'checkout.session.completed') status = data.payment_status === 'succeeded' ? 'succeeded' : status;
      if (event.type === 'checkout.session.payment_failed') status = 'failed';
      events.push({ type: 'collection', reference: data.client_reference ?? undefined, providerReference: data.id, status, amountMinor: result.amountMinor, currency: result.currency, eventId, raw: result.raw });
    } else if (event.type.startsWith('payout.') || (typeof data.id === 'string' && data.id.startsWith('pt-'))) {
      const result = payoutResult(data);
      events.push({ type: 'payout', reference: data.client_reference ?? undefined, providerReference: data.id, status: result.status, amountMinor: result.amountMinor, currency: result.currency, eventId, raw: result.raw });
    }
    return events;
  },
};
