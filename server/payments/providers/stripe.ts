import { exponent } from '../mode.js';
import {
  assertAmount, assertCurrency, baseUrl, baseUrlProblems, callProvider, currencySettingProblems, fail, header, noWhitespace,
  parseJson, rescale, scrub, verifyTimestampedSignature,
} from './http.js';
import type { OperationResult, PaymentProvider, ProviderConfig, ProviderContext, ProviderStatus, StatusResult, WebhookEvent } from './types.js';

/**
 * Stripe: hosted Checkout Sessions (cards), refunds, and payouts to Stripe Connect accounts via Transfers
 * ("separate charges and transfers"). Docs: https://docs.stripe.com/api
 * Amounts use Stripe units: zero-decimal currencies (XAF, XOF...) are sent in major units, others in cents.
 */
const ID = 'stripe' as const;
const CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'CAD', 'XAF', 'XOF'] as const;
/** https://docs.stripe.com/currencies#zero-decimal */
export const STRIPE_ZERO_DECIMAL = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
const WEBHOOK_TOLERANCE_SECONDS = 300;

const stripeExponent = (currency: string) => (STRIPE_ZERO_DECIMAL.has(currency) ? 0 : 2);
export const toStripeAmount = (amountMinor: number, currency: string) => rescale(ID, amountMinor, exponent(currency), stripeExponent(currency));
export const fromStripeAmount = (amount: number, currency: string) => rescale(ID, amount, stripeExponent(currency), exponent(currency));

function upper(value: unknown) { return typeof value === 'string' ? value.toUpperCase() : undefined; }

function amountFromStripe(amount: unknown, currency: unknown): { amountMinor?: number; currency?: string } {
  const code = upper(currency);
  if (typeof amount !== 'number' || !code) return {};
  try { return { amountMinor: fromStripeAmount(amount, code), currency: code }; }
  catch { return { currency: code }; }
}

async function api<T = any>(config: ProviderConfig, context: ProviderContext, method: 'GET' | 'POST', path: string, form?: URLSearchParams, idempotencyKey?: string): Promise<T> {
  const response = await callProvider<T>(ID, config, context, {
    method,
    url: `${baseUrl(config, { sandbox: 'https://api.stripe.com', live: 'https://api.stripe.com' })}${path}`,
    headers: {
      Authorization: `Bearer ${config.secrets.secret_key ?? ''}`,
      'Stripe-Version': config.settings.api_version?.trim() || undefined,
      'Idempotency-Key': idempotencyKey,
    },
    form,
  });
  return response.data;
}

function sessionStatus(session: any): { status: ProviderStatus; failureReason?: string } {
  if (session.payment_status === 'paid' || session.payment_status === 'no_payment_required') return { status: 'succeeded' };
  if (session.status === 'expired') return { status: 'cancelled', failureReason: 'Session de paiement expirée.' };
  if (session.payment_intent && typeof session.payment_intent === 'object' && session.payment_intent.status === 'canceled') return { status: 'cancelled', failureReason: 'Paiement annulé.' };
  return { status: 'pending' };
}

function paymentIntentStatus(intent: any): ProviderStatus {
  if (intent.status === 'succeeded') return 'succeeded';
  if (intent.status === 'canceled') return 'cancelled';
  return 'pending';
}

function refundStatus(value: unknown): ProviderStatus {
  if (value === 'succeeded') return 'succeeded';
  if (value === 'failed') return 'failed';
  if (value === 'canceled') return 'cancelled';
  return 'pending';
}

function transferResult(transfer: any): StatusResult {
  const reversed = transfer.reversed === true || (typeof transfer.amount_reversed === 'number' && transfer.amount_reversed > 0 && transfer.amount_reversed >= transfer.amount);
  return {
    status: reversed ? 'failed' : 'succeeded',
    providerReference: transfer.id,
    ...amountFromStripe(transfer.amount, transfer.currency),
    failureReason: reversed ? 'Transfert Stripe annulé (reversed).' : undefined,
    raw: scrub({ id: transfer.id, reversed: transfer.reversed, destination: transfer.destination }),
  };
}

function metadataReference(object: any): string | undefined {
  const value = object?.metadata?.alpha_reference;
  return typeof value === 'string' && value ? value : undefined;
}

export const stripe: PaymentProvider = {
  id: ID,
  label: 'Stripe (cartes bancaires, Stripe Connect)',
  countries: ['*'],
  currencies: [...CURRENCIES],
  methods: ['card'],
  capabilities: { collect: true, payout: true, refund: true, webhooks: 'signed' },
  fields: [
    { key: 'secret_key', label: 'Clé secrète API', secret: true, required: true, placeholder: 'sk_test_… ou sk_live_…', help: 'Tableau de bord Stripe → Développeurs → Clés API. Une clé restreinte (rk_…) est recommandée en production.' },
    { key: 'webhook_secret', label: 'Secret de signature du webhook', secret: true, required: true, placeholder: 'whsec_…', help: 'Affiché lors de la création de l’endpoint webhook (Développeurs → Webhooks).' },
    { key: 'currency', label: 'Devise de collecte', secret: false, required: true, options: [...CURRENCIES] },
    { key: 'api_version', label: 'Version de l’API Stripe (facultatif)', secret: false, required: false, placeholder: 'AAAA-MM-JJ.nom', help: 'Envoyée dans l’en-tête Stripe-Version. Laissez vide pour utiliser la version du compte.' },
    { key: 'base_url', label: 'URL d’API personnalisée (tests uniquement)', secret: false, required: false, placeholder: 'https://api.stripe.com' },
  ],
  docsUrl: 'https://docs.stripe.com/api',
  validateConfig(config) {
    const problems = [...baseUrlProblems(config), ...currencySettingProblems(config, CURRENCIES), ...noWhitespace(config.secrets.secret_key, 'La clé secrète')];
    const key = config.secrets.secret_key;
    if (key) {
      const mode = /^(sk|rk)_(test|live)_[A-Za-z0-9]+$/.exec(key)?.[2];
      if (!mode) problems.push('La clé secrète Stripe doit commencer par sk_test_, sk_live_, rk_test_ ou rk_live_.');
      else if (config.environment === 'sandbox' && mode !== 'test') problems.push('Utilisez une clé de test (sk_test_ / rk_test_) pour le bac à sable.');
      else if (config.environment === 'live' && mode !== 'live') problems.push('Utilisez une clé live (sk_live_ / rk_live_) en production.');
    }
    const webhook = config.secrets.webhook_secret;
    if (webhook && !/^whsec_[A-Za-z0-9+/=_-]+$/.test(webhook)) problems.push('Le secret de webhook Stripe doit commencer par whsec_.');
    const version = config.settings.api_version?.trim();
    if (version && !/^\d{4}-\d{2}-\d{2}(\.[a-z]+)?$/.test(version)) problems.push('Version d’API Stripe invalide (format AAAA-MM-JJ ou AAAA-MM-JJ.nom).');
    return problems;
  },

  async collect(config, request, context) {
    assertAmount(ID, request.amountMinor);
    assertCurrency(ID, request.currency, CURRENCIES);
    if (request.method && request.method !== 'card') fail(ID, 'Stripe ne gère ici que le paiement par carte.');
    const form = new URLSearchParams();
    form.set('mode', 'payment');
    form.set('client_reference_id', request.reference);
    form.set('success_url', request.returnUrl);
    form.set('cancel_url', request.cancelUrl);
    form.set('payment_method_types[0]', 'card');
    form.set('locale', 'auto');
    form.set('line_items[0][quantity]', '1');
    form.set('line_items[0][price_data][currency]', request.currency.toLowerCase());
    form.set('line_items[0][price_data][unit_amount]', String(toStripeAmount(request.amountMinor, request.currency)));
    form.set('line_items[0][price_data][product_data][name]', request.description.slice(0, 250) || 'Paiement Alpha');
    form.set('metadata[alpha_reference]', request.reference);
    form.set('payment_intent_data[metadata][alpha_reference]', request.reference);
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(request.customer.email)) form.set('customer_email', request.customer.email);
    const session = await api(config, context, 'POST', '/v1/checkout/sessions', form, `alpha-collect-${request.reference}`);
    if (typeof session?.url !== 'string' || typeof session?.id !== 'string') fail(ID, 'Stripe n’a pas renvoyé d’URL de paiement.');
    return { kind: 'redirect', url: session.url, providerReference: session.id, raw: scrub({ id: session.id, status: session.status, payment_status: session.payment_status }) };
  },

  async status(config, kind, providerReference, context) {
    const id = encodeURIComponent(providerReference);
    if (kind === 'payout') return transferResult(await api(config, context, 'GET', `/v1/transfers/${id}`));
    if (kind === 'refund') {
      const refund = await api(config, context, 'GET', `/v1/refunds/${id}`);
      return { status: refundStatus(refund.status), providerReference: refund.id, ...amountFromStripe(refund.amount, refund.currency), failureReason: refund.failure_reason ?? undefined, raw: scrub({ id: refund.id, status: refund.status }) };
    }
    if (providerReference.startsWith('pi_')) {
      const intent = await api(config, context, 'GET', `/v1/payment_intents/${id}`);
      return { status: paymentIntentStatus(intent), providerReference: intent.id, ...amountFromStripe(intent.amount_received || intent.amount, intent.currency), raw: scrub({ id: intent.id, status: intent.status }) };
    }
    const session = await api(config, context, 'GET', `/v1/checkout/sessions/${id}?expand[]=payment_intent`);
    const { status, failureReason } = sessionStatus(session);
    return { status, failureReason, providerReference: session.id, ...amountFromStripe(session.amount_total, session.currency), raw: scrub({ id: session.id, status: session.status, payment_status: session.payment_status }) };
  },

  async payout(config, request, context): Promise<OperationResult> {
    assertAmount(ID, request.amountMinor);
    assertCurrency(ID, request.currency, CURRENCIES);
    const destination = request.recipient.accountId;
    if (!destination || !/^acct_[A-Za-z0-9]+$/.test(destination)) fail(ID, 'Un compte Stripe Connect (acct_…) est requis pour ce versement.');
    const form = new URLSearchParams();
    form.set('amount', String(toStripeAmount(request.amountMinor, request.currency)));
    form.set('currency', request.currency.toLowerCase());
    form.set('destination', destination);
    form.set('transfer_group', request.reference);
    form.set('description', request.description.slice(0, 250));
    form.set('metadata[alpha_reference]', request.reference);
    const transfer = await api(config, context, 'POST', '/v1/transfers', form, `alpha-payout-${request.reference}`);
    const result = transferResult(transfer);
    return { status: result.status, providerReference: result.providerReference, failureReason: result.failureReason, raw: result.raw };
  },

  async refund(config, request, context): Promise<OperationResult> {
    assertAmount(ID, request.amountMinor);
    assertCurrency(ID, request.currency, CURRENCIES);
    let paymentIntent = request.providerReference.startsWith('pi_') ? request.providerReference : undefined;
    if (!paymentIntent) {
      const session = await api(config, context, 'GET', `/v1/checkout/sessions/${encodeURIComponent(request.providerReference)}`);
      paymentIntent = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
    }
    if (!paymentIntent) fail(ID, 'Aucun paiement Stripe à rembourser pour cette session.');
    const form = new URLSearchParams();
    form.set('payment_intent', paymentIntent);
    form.set('amount', String(toStripeAmount(request.amountMinor, request.currency)));
    form.set('reason', 'requested_by_customer');
    form.set('metadata[alpha_reference]', request.reference);
    form.set('metadata[alpha_reason]', request.reason.slice(0, 200));
    const refund = await api(config, context, 'POST', '/v1/refunds', form, `alpha-refund-${request.reference}`);
    return { status: refundStatus(refund.status), providerReference: refund.id, failureReason: refund.failure_reason ?? undefined, raw: scrub({ id: refund.id, status: refund.status }) };
  },

  async verifyWebhook(config, input, context) {
    const valid = verifyTimestampedSignature({
      header: header(input, 'stripe-signature'),
      secret: config.secrets.webhook_secret,
      rawBody: input.rawBody,
      now: context.now(),
      toleranceSeconds: WEBHOOK_TOLERANCE_SECONDS,
      payload: (timestamp, body) => Buffer.concat([Buffer.from(`${timestamp}.`), body]),
    });
    if (!valid) return null;
    const event = parseJson(input.rawBody);
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') return null;
    const object = event.data?.object ?? {};
    const base = { eventId: typeof event.id === 'string' ? event.id : undefined };
    const events: WebhookEvent[] = [];
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
      case 'checkout.session.async_payment_failed':
      case 'checkout.session.expired': {
        let status: ProviderStatus = sessionStatus(object).status;
        if (event.type === 'checkout.session.async_payment_failed') status = 'failed';
        if (event.type === 'checkout.session.expired') status = 'cancelled';
        events.push({ ...base, type: 'collection', reference: object.client_reference_id ?? metadataReference(object), providerReference: object.id, status, ...amountFromStripe(object.amount_total, object.currency), raw: scrub({ id: object.id, status: object.status, payment_status: object.payment_status }) });
        break;
      }
      case 'refund.created':
      case 'refund.updated':
      case 'refund.failed':
      case 'charge.refund.updated':
        events.push({ ...base, type: 'refund', reference: metadataReference(object), providerReference: object.id, status: refundStatus(object.status), ...amountFromStripe(object.amount, object.currency), raw: scrub({ id: object.id, status: object.status }) });
        break;
      case 'transfer.created':
      case 'transfer.updated':
      case 'transfer.reversed': {
        const result = transferResult(object);
        events.push({ ...base, type: 'payout', reference: metadataReference(object) ?? object.transfer_group ?? undefined, providerReference: object.id, status: event.type === 'transfer.reversed' ? 'failed' : result.status, amountMinor: result.amountMinor, currency: result.currency, raw: result.raw });
        break;
      }
      case 'account.updated':
        events.push({ ...base, type: 'account', providerReference: object.id, status: object.charges_enabled && object.payouts_enabled ? 'succeeded' : 'pending', raw: scrub({ id: object.id, charges_enabled: object.charges_enabled, payouts_enabled: object.payouts_enabled }) });
        break;
      default:
        break;
    }
    return events;
  },
};

