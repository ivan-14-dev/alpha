import {
  assertAmount, assertCurrency, basicAuth, baseUrl, baseUrlProblems, callProvider, fail, mapStatus, noWhitespace, parseJson,
  queryString, scrub, tokenCacheKey, toWholeMajor, urlSignature, verifyUrlSignature, withToken,
} from './http.js';
import { exponent } from '../mode.js';
import type { PaymentProvider, ProviderConfig, ProviderContext, ProviderStatus } from './types.js';

/**
 * Orange Money Web Payment (WebPay) API. Docs: https://developer.orange.com/apis/om-webpay
 * - OAuth2 client credentials: POST https://api.orange.com/oauth/v3/token (Basic client_id:client_secret).
 * - POST /orange-money-webpay/{country}/v1/webpayment -> payment_url, pay_token, notif_token.
 * - POST /orange-money-webpay/{country}/v1/transactionstatus {order_id, amount, pay_token}.
 * In the developer sandbox the country path is "dev" and the currency "OUV" (test unit).
 *
 * The notification (POST notif_url {status, notif_token, txnid}) is not signed and the adapter has no database
 * to compare notif_token with: the notif_url carries an HMAC of our reference and verifyWebhook only reports
 * 'pending' for that reference; the payments module then re-confirms with status() (transactionstatus).
 * providerReference = `${pay_token}|${order_id}|${amount}|${currency}` (everything transactionstatus needs).
 */
const ID = 'orange_money' as const;
const API = { sandbox: 'https://api.orange.com', live: 'https://api.orange.com' };
export const ORANGE_COUNTRIES: Record<string, string> = { ci: 'XOF', sn: 'XOF', ml: 'XOF', bf: 'XOF', cm: 'XAF', gn: 'GNF' };
const CURRENCIES = [...new Set(Object.values(ORANGE_COUNTRIES))];
const STATUS: Record<string, ProviderStatus> = { SUCCESS: 'succeeded', SUCCESSFUL: 'succeeded', FAILED: 'failed', EXPIRED: 'cancelled', CANCELLED: 'cancelled', INITIATED: 'pending', PENDING: 'pending' };

function countryPath(config: ProviderConfig) {
  return config.environment === 'sandbox' ? 'dev' : (config.settings.country ?? '').toLowerCase();
}

async function token(config: ProviderConfig, context: ProviderContext) {
  const form = new URLSearchParams({ grant_type: 'client_credentials' });
  const response = await callProvider(ID, config, context, {
    method: 'POST',
    url: `${baseUrl(config, API)}/oauth/v3/token`,
    headers: { Authorization: basicAuth(config.secrets.client_id ?? '', config.secrets.client_secret ?? '') },
    form,
  });
  const value = response.data?.access_token;
  if (typeof value !== 'string' || !value) fail(ID, 'Orange n’a pas délivré de jeton d’accès.');
  return { token: value, expiresIn: Number(response.data?.expires_in) || 3600 };
}

async function api<T = any>(config: ProviderConfig, context: ProviderContext, path: string, json: unknown) {
  const key = tokenCacheKey(ID, baseUrl(config, API), config.secrets.client_id ?? '', config.secrets.client_secret ?? '');
  return withToken(key, context, () => token(config, context), (value) => callProvider<T>(ID, config, context, {
    method: 'POST',
    url: `${baseUrl(config, API)}/orange-money-webpay/${countryPath(config)}/v1${path}`,
    headers: { Authorization: `Bearer ${value}` },
    json,
    redact: [value],
  }));
}

function notifSecret(config: ProviderConfig) {
  return config.secrets.merchant_key ? `${config.secrets.merchant_key}:${config.secrets.client_secret ?? ''}` : undefined;
}

export function encodeOrangeReference(payToken: string, orderId: string, amount: number, currency: string) {
  return [payToken, orderId, String(amount), currency].join('|');
}

export function decodeOrangeReference(value: string) {
  const [payToken, orderId, amount, currency] = value.split('|');
  if (!payToken || !orderId || !/^\d+$/.test(amount ?? '') || !/^[A-Z]{3}$/.test(currency ?? '')) return null;
  return { payToken, orderId, amount: Number(amount), currency };
}

export const orangeMoney: PaymentProvider = {
  id: ID,
  label: 'Orange Money (Web Payment)',
  countries: ['CI', 'SN', 'ML', 'BF', 'CM', 'GN'],
  currencies: CURRENCIES,
  methods: ['mobile_money'],
  capabilities: { collect: true, payout: false, refund: false, webhooks: 'unsigned' },
  fields: [
    { key: 'client_id', label: 'Client ID (application Orange Developer)', secret: true, required: true },
    { key: 'client_secret', label: 'Client secret', secret: true, required: true },
    { key: 'merchant_key', label: 'Clé marchand (merchant_key)', secret: true, required: true, help: 'Fournie par Orange après souscription Web Payment (8 caractères ou plus).' },
    { key: 'country', label: 'Pays du contrat marchand', secret: false, required: true, options: Object.keys(ORANGE_COUNTRIES), help: 'En bac à sable, le chemin « dev » et la devise de test OUV sont utilisés automatiquement.' },
    { key: 'currency', label: 'Devise de collecte', secret: false, required: true, options: CURRENCIES },
    { key: 'merchant_name', label: 'Nom affiché au client (référence marchand)', secret: false, required: false, placeholder: 'Alpha' },
    { key: 'base_url', label: 'URL d’API personnalisée (tests uniquement)', secret: false, required: false, placeholder: 'https://api.orange.com' },
  ],
  docsUrl: 'https://developer.orange.com/apis/om-webpay',
  validateConfig(config) {
    const problems = [...baseUrlProblems(config), ...noWhitespace(config.secrets.client_id, 'Le Client ID'), ...noWhitespace(config.secrets.merchant_key, 'La clé marchand')];
    const country = config.settings.country;
    const currency = config.settings.currency;
    if (country && !ORANGE_COUNTRIES[country]) problems.push('Pays Orange Money non pris en charge.');
    if (currency && !CURRENCIES.includes(currency)) problems.push(`La devise ${currency} n’est pas disponible avec Orange Money.`);
    else if (country && currency && ORANGE_COUNTRIES[country] && ORANGE_COUNTRIES[country] !== currency) problems.push(`Orange Money ${country.toUpperCase()} encaisse uniquement en ${ORANGE_COUNTRIES[country]}.`);
    const name = config.settings.merchant_name;
    if (name && name.length > 30) problems.push('Le nom affiché au client ne doit pas dépasser 30 caractères.');
    return problems;
  },

  async collect(config, request, context) {
    assertAmount(ID, request.amountMinor);
    assertCurrency(ID, request.currency, CURRENCIES);
    const amount = toWholeMajor(ID, request.amountMinor, request.currency);
    const url = new URL(context.webhookUrl);
    url.searchParams.set('ref', request.reference);
    url.searchParams.set('sig', urlSignature(notifSecret(config) ?? '', 'orange:notif', request.reference));
    const response = await api(config, context, '/webpayment', {
      merchant_key: config.secrets.merchant_key,
      currency: config.environment === 'sandbox' ? 'OUV' : request.currency,
      order_id: request.reference,
      amount,
      return_url: request.returnUrl,
      cancel_url: request.cancelUrl,
      notif_url: url.toString(),
      lang: 'fr',
      reference: (config.settings.merchant_name || 'Alpha').slice(0, 30),
    });
    const data = response.data ?? {};
    if (typeof data.payment_url !== 'string' || typeof data.pay_token !== 'string') fail(ID, 'Orange Money n’a pas renvoyé d’URL de paiement.');
    return {
      kind: 'redirect',
      url: data.payment_url,
      providerReference: encodeOrangeReference(data.pay_token, request.reference, amount, request.currency),
      raw: scrub({ status: data.status, message: data.message }),
    };
  },

  async status(config, kind, providerReference, context) {
    if (kind !== 'collection') fail(ID, 'Orange Money Web Payment ne gère que les encaissements.');
    const decoded = decodeOrangeReference(providerReference);
    if (!decoded) fail(ID, 'Référence Orange Money invalide.');
    const response = await api(config, context, '/transactionstatus', { order_id: decoded.orderId, amount: decoded.amount, pay_token: decoded.payToken });
    const data = response.data ?? {};
    if (data.order_id !== undefined && String(data.order_id) !== decoded.orderId) fail(ID, 'Orange Money a renvoyé une transaction qui ne correspond pas à la commande.');
    const status = mapStatus(data.status, STATUS);
    return {
      status,
      providerReference,
      // Orange does not echo the amount: it is the one bound to pay_token at creation (encoded in the reference).
      amountMinor: decoded.amount * 10 ** exponent(decoded.currency),
      currency: decoded.currency,
      failureReason: status === 'failed' ? 'Paiement Orange Money refusé.' : status === 'cancelled' ? 'Paiement Orange Money expiré ou annulé.' : undefined,
      raw: scrub({ status: data.status, txnid: data.txnid }),
    };
  },

  async verifyWebhook(config, input) {
    const reference = queryString(input, 'ref');
    if (!verifyUrlSignature(notifSecret(config), 'orange:notif', reference, queryString(input, 'sig'))) return null;
    const body = parseJson(input.rawBody);
    const bodyStatus = typeof body?.status === 'string' && /^[A-Z_]{1,20}$/i.test(body.status) ? body.status.toUpperCase() : 'callback';
    // notif_token cannot be checked without storage: report 'pending', the module re-confirms with status().
    return [{ type: 'collection', reference: reference!, status: 'pending', eventId: `orange:${reference}:${bodyStatus}`, raw: scrub({ status: body?.status, txnid: body?.txnid }) }];
  },
};
