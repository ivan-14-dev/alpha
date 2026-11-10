import { createHmac } from 'node:crypto';
import { safeEqual } from '../../platform/secrets.js';
import {
  assertAmount, assertCurrency, baseUrl, baseUrlProblems, callProvider, currencySettingProblems, fail, fromMajor, header,
  mapStatus, msisdn, noWhitespace, normalizeOperator, parseJson, scrub, toMajorNumber,
} from './http.js';
import type { OperationResult, PaymentProvider, ProviderConfig, ProviderContext, ProviderStatus, StatusResult, WebhookEvent } from './types.js';

/**
 * Flutterwave v3: hosted payment links (/v3/payments), verification by tx_ref, transfers (bank / mobile money)
 * and refunds. Amounts are sent in MAJOR units (decimal numbers). Docs: https://developer.flutterwave.com/v3.0/reference
 * Webhooks carry the dashboard "secret hash" in the `verif-hash` header (shared secret, not a body signature),
 * so the payments module must re-confirm with status() — which it always does.
 */
const ID = 'flutterwave' as const;
const CURRENCIES = ['XAF', 'XOF', 'NGN', 'GHS', 'KES', 'UGX', 'RWF', 'TZS', 'ZAR', 'EUR', 'USD', 'GBP'] as const;
const API = { sandbox: 'https://api.flutterwave.com', live: 'https://api.flutterwave.com' };

const COLLECTION: Record<string, ProviderStatus> = { SUCCESSFUL: 'succeeded', FAILED: 'failed', CANCELLED: 'cancelled', PENDING: 'pending', NEW: 'pending' };
const TRANSFER: Record<string, ProviderStatus> = { SUCCESSFUL: 'succeeded', FAILED: 'failed', NEW: 'pending', PENDING: 'pending' };
const REFUND: Record<string, ProviderStatus> = { COMPLETED: 'succeeded', SUCCESSFUL: 'succeeded', FAILED: 'failed', PENDING: 'pending', NEW: 'pending' };
const DEFAULT_COUNTRY: Record<string, string> = { XAF: 'CM', XOF: 'CI', GHS: 'GH', KES: 'KE', UGX: 'UG', RWF: 'RW', TZS: 'TZ', NGN: 'NG' };

async function api<T = any>(config: ProviderConfig, context: ProviderContext, method: 'GET' | 'POST', path: string, json?: unknown, accept?: number[]) {
  return callProvider<T>(ID, config, context, {
    method,
    url: `${baseUrl(config, API)}${path}`,
    headers: { Authorization: `Bearer ${config.secrets.secret_key ?? ''}` },
    json,
    accept,
  });
}

/**
 * Mobile money "account_bank" codes (https://developer.flutterwave.com/docs/mobile-money): CI = FMM, Moov,
 * orangemoney, WAVE; SN = freemoney, orangemoney, WAVE; GH/UG/RW = MTN...; KE = MPS. Cameroon MoMo payouts use
 * the francophone code FMM (to confirm with Flutterwave for your account).
 */
export function flutterwaveMobileMoneyBank(country: string, operator: string | undefined): string {
  const op = normalizeOperator(operator);
  if (country === 'KE') return 'MPS';
  if (country === 'GH') return op === 'airtel' ? 'AIRTELTIGO' : 'MTN';
  if (country === 'UG') return op === 'airtel' ? 'Airtel' : 'MTN';
  if (country === 'RW') return 'MTN';
  if (op === 'orange') return 'orangemoney';
  if (op === 'wave') return 'WAVE';
  if (op === 'moov' && country === 'CI') return 'Moov';
  if (op === 'free' && country === 'SN') return 'freemoney';
  return 'FMM';
}

function collectionResult(data: any, providerReference: string): StatusResult {
  const currency = typeof data.currency === 'string' ? data.currency.toUpperCase() : undefined;
  const status = mapStatus(data.status, COLLECTION);
  return {
    status,
    providerReference,
    amountMinor: fromMajor(data.amount, currency),
    currency,
    failureReason: status === 'failed' || status === 'cancelled' ? String(data.processor_response ?? 'Paiement refusé.').slice(0, 200) : undefined,
    raw: scrub({ id: data.id, tx_ref: data.tx_ref, flw_ref: data.flw_ref, status: data.status }),
  };
}

async function verifyByReference(config: ProviderConfig, context: ProviderContext, txRef: string) {
  const response = await api(config, context, 'GET', `/v3/transactions/verify_by_reference?tx_ref=${encodeURIComponent(txRef)}`, undefined, [400, 404]);
  if (!response.ok) {
    const message = String(response.data?.message ?? '');
    // The customer has not paid yet: Flutterwave answers 400/404 "No transaction was found for this id".
    if (response.status === 404 || /no transaction|not found/i.test(message)) return null;
    fail(ID, `Flutterwave a refusé la vérification (HTTP ${response.status}).`, false, response.status);
  }
  return response.data?.data ?? null;
}

export const flutterwave: PaymentProvider = {
  id: ID,
  label: 'Flutterwave (cartes, mobile money, virements)',
  countries: ['CM', 'CI', 'SN', 'BF', 'ML', 'BJ', 'TG', 'NE', 'GA', 'CG', 'NG', 'GH', 'KE', 'UG', 'RW', 'TZ', 'ZA'],
  currencies: [...CURRENCIES],
  methods: ['card', 'mobile_money', 'bank_transfer'],
  capabilities: { collect: true, payout: true, refund: true, webhooks: 'signed' },
  fields: [
    { key: 'secret_key', label: 'Clé secrète API', secret: true, required: true, placeholder: 'FLWSECK_TEST-… ou FLWSECK-…', help: 'Tableau de bord Flutterwave → Settings → API Keys.' },
    { key: 'secret_hash', label: 'Secret hash des webhooks (verif-hash)', secret: true, required: true, help: 'Valeur aléatoire (32 caractères recommandés) saisie dans Settings → Webhooks.' },
    { key: 'currency', label: 'Devise de collecte', secret: false, required: true, options: [...CURRENCIES] },
    { key: 'payment_options', label: 'Moyens proposés (facultatif)', secret: false, required: false, placeholder: 'card,mobilemoneyfranco', help: 'Liste payment_options Flutterwave. Vide = déduit du moyen choisi.' },
    { key: 'base_url', label: 'URL d’API personnalisée (tests uniquement)', secret: false, required: false, placeholder: 'https://api.flutterwave.com' },
  ],
  docsUrl: 'https://developer.flutterwave.com/v3.0/docs',
  validateConfig(config) {
    const problems = [...baseUrlProblems(config), ...currencySettingProblems(config, CURRENCIES), ...noWhitespace(config.secrets.secret_key, 'La clé secrète')];
    const key = config.secrets.secret_key;
    if (key) {
      if (!/^FLWSECK(_TEST)?-[A-Za-z0-9-]+$/.test(key)) problems.push('La clé secrète Flutterwave doit commencer par FLWSECK_TEST- ou FLWSECK-.');
      else if (config.environment === 'sandbox' && !key.startsWith('FLWSECK_TEST-')) problems.push('Utilisez une clé de test (FLWSECK_TEST-) pour le bac à sable.');
      else if (config.environment === 'live' && key.startsWith('FLWSECK_TEST-')) problems.push('Utilisez une clé live (FLWSECK-) en production.');
    }
    const hash = config.secrets.secret_hash;
    if (hash && hash.length < 16) problems.push('Le secret hash des webhooks doit contenir au moins 16 caractères.');
    const options = config.settings.payment_options?.trim();
    if (options && !/^[a-z_]+(,[a-z_]+)*$/.test(options)) problems.push('payment_options : liste de codes séparés par des virgules (ex. card,mobilemoneyfranco).');
    return problems;
  },

  async collect(config, request, context) {
    assertAmount(ID, request.amountMinor);
    assertCurrency(ID, request.currency, CURRENCIES);
    let paymentOptions = config.settings.payment_options?.trim() || undefined;
    if (!paymentOptions && request.method === 'card') paymentOptions = 'card';
    if (!paymentOptions && request.method === 'mobile_money' && ['XAF', 'XOF'].includes(request.currency)) paymentOptions = 'mobilemoneyfranco';
    const response = await api(config, context, 'POST', '/v3/payments', {
      tx_ref: request.reference,
      amount: toMajorNumber(request.amountMinor, request.currency),
      currency: request.currency,
      redirect_url: request.returnUrl,
      payment_options: paymentOptions,
      customer: { email: request.customer.email, name: request.customer.name, phonenumber: request.customer.phone },
      customizations: { title: 'Alpha', description: request.description.slice(0, 200) },
      meta: { alpha_reference: request.reference },
    });
    const link = response.data?.data?.link;
    if (typeof link !== 'string') fail(ID, 'Flutterwave n’a pas renvoyé de lien de paiement.');
    return { kind: 'redirect', url: link, providerReference: request.reference, raw: scrub({ status: response.data?.status }) };
  },

  async status(config, kind, providerReference, context) {
    if (kind === 'collection') {
      const data = await verifyByReference(config, context, providerReference);
      if (!data) return { status: 'pending', providerReference };
      if (data.tx_ref && data.tx_ref !== providerReference) fail(ID, 'Flutterwave a renvoyé une transaction qui ne correspond pas à la référence.');
      return collectionResult(data, providerReference);
    }
    if (kind === 'payout') {
      const data = (await api(config, context, 'GET', `/v3/transfers/${encodeURIComponent(providerReference)}`)).data?.data ?? {};
      const status = mapStatus(data.status, TRANSFER);
      const currency = typeof data.currency === 'string' ? data.currency.toUpperCase() : undefined;
      return { status, providerReference, amountMinor: fromMajor(data.amount, currency), currency, failureReason: status === 'failed' ? String(data.complete_message ?? 'Transfert refusé.').slice(0, 200) : undefined, raw: scrub({ id: data.id, status: data.status, reference: data.reference }) };
    }
    const data = (await api(config, context, 'GET', `/v3/refunds/${encodeURIComponent(providerReference)}`)).data?.data ?? {};
    const currency = typeof data.currency === 'string' ? data.currency.toUpperCase() : undefined;
    return { status: mapStatus(data.status, REFUND), providerReference, amountMinor: fromMajor(data.amount_refunded ?? data.AmountRefunded, currency), currency, raw: scrub({ id: data.id, status: data.status }) };
  },

  async payout(config, request, context): Promise<OperationResult> {
    assertAmount(ID, request.amountMinor);
    assertCurrency(ID, request.currency, CURRENCIES);
    const { recipient } = request;
    const country = (recipient.country ?? DEFAULT_COUNTRY[request.currency] ?? '').toUpperCase();
    let accountBank: string;
    let accountNumber: string;
    if (recipient.accountNumber && recipient.bankCode) {
      accountBank = recipient.bankCode;
      accountNumber = recipient.accountNumber.replace(/\s/g, '');
    } else {
      accountBank = recipient.bankCode ?? flutterwaveMobileMoneyBank(country, recipient.operator);
      accountNumber = msisdn(ID, recipient.phone, country);
    }
    const response = await api(config, context, 'POST', '/v3/transfers', {
      account_bank: accountBank,
      account_number: accountNumber,
      amount: toMajorNumber(request.amountMinor, request.currency),
      currency: request.currency,
      beneficiary_name: recipient.name,
      narration: request.description.slice(0, 100),
      reference: request.reference,
      callback_url: context.webhookUrl,
      meta: country ? { beneficiary_country: country } : undefined,
    });
    const data = response.data?.data ?? {};
    if (data.id === undefined) fail(ID, 'Flutterwave n’a pas renvoyé d’identifiant de transfert.');
    const status = mapStatus(data.status, TRANSFER);
    return { status, providerReference: String(data.id), failureReason: status === 'failed' ? String(data.complete_message ?? 'Transfert refusé.').slice(0, 200) : undefined, raw: scrub({ id: data.id, status: data.status, reference: data.reference }) };
  },

  async refund(config, request, context): Promise<OperationResult> {
    assertAmount(ID, request.amountMinor);
    assertCurrency(ID, request.currency, CURRENCIES);
    let transactionId = /^\d+$/.test(request.providerReference) ? request.providerReference : undefined;
    if (!transactionId) {
      const data = await verifyByReference(config, context, request.providerReference);
      if (!data?.id) fail(ID, 'Transaction Flutterwave introuvable : remboursement impossible.');
      if (String(data.status).toLowerCase() !== 'successful') fail(ID, 'Seule une transaction Flutterwave réussie peut être remboursée.');
      transactionId = String(data.id);
    }
    const response = await api(config, context, 'POST', `/v3/transactions/${encodeURIComponent(transactionId)}/refund`, {
      amount: toMajorNumber(request.amountMinor, request.currency),
      comments: request.reason.slice(0, 200),
      callbackurl: context.webhookUrl,
    });
    const data = response.data?.data ?? {};
    if (data.id === undefined) fail(ID, 'Flutterwave n’a pas renvoyé d’identifiant de remboursement.');
    return { status: mapStatus(data.status, REFUND), providerReference: String(data.id), raw: scrub({ id: data.id, status: data.status }) };
  },

  async verifyWebhook(config, input) {
    const secretHash = config.secrets.secret_hash;
    if (!secretHash) return null;
    const legacy = header(input, 'verif-hash');
    const signature = header(input, 'flutterwave-signature');
    // v3 sends the configured secret hash verbatim; newer accounts may sign the raw body (base64 HMAC-SHA256).
    const authentic = signature
      ? safeEqual(signature, createHmac('sha256', secretHash).update(input.rawBody).digest('base64'))
      : !!legacy && safeEqual(legacy, secretHash);
    if (!authentic) return null;
    const payload = parseJson(input.rawBody);
    if (!payload || typeof payload !== 'object') return null;
    const name = String(payload.event ?? payload['event.type'] ?? '').toLowerCase();
    const data = payload.data && typeof payload.data === 'object' ? payload.data : payload;
    const currency = typeof data.currency === 'string' ? data.currency.toUpperCase() : undefined;
    const events: WebhookEvent[] = [];
    if (name === 'charge.completed' || name === 'card_transaction' || name.endsWith('_transaction')) {
      const txRef = data.tx_ref ?? data.txRef;
      if (typeof txRef !== 'string') return [];
      const status = mapStatus(data.status, COLLECTION);
      events.push({ type: 'collection', reference: txRef, providerReference: txRef, status, amountMinor: fromMajor(data.amount, currency), currency, eventId: `flw:charge:${data.id ?? txRef}:${status}`, raw: scrub({ id: data.id, status: data.status }) });
    } else if (name.startsWith('transfer')) {
      const status = mapStatus(data.status, TRANSFER);
      events.push({ type: 'payout', reference: typeof data.reference === 'string' ? data.reference : undefined, providerReference: data.id !== undefined ? String(data.id) : undefined, status, amountMinor: fromMajor(data.amount, currency), currency, eventId: `flw:transfer:${data.id}:${status}`, raw: scrub({ id: data.id, status: data.status }) });
    } else if (name.startsWith('refund') || 'AmountRefunded' in data) {
      const status = mapStatus(data.status, REFUND);
      events.push({ type: 'refund', providerReference: data.id !== undefined ? String(data.id) : undefined, status, eventId: `flw:refund:${data.id}:${status}`, raw: scrub({ id: data.id, status: data.status }) });
    }
    return events;
  },
};
