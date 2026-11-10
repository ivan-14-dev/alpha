import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import type { CollectRequest, PaymentProvider, ProviderConfig, ProviderContext, WebhookInput } from '../server/payments/providers/types.js';

process.env.DATABASE_PATH = ':memory:';
const { listProviders, getProvider } = await import('../server/payments/providers/index.js');
const { ProviderError } = await import('../server/payments/providers/types.js');
const http = await import('../server/payments/providers/http.js');
const { exponent } = await import('../server/payments/mode.js');
const { toStripeAmount } = await import('../server/payments/providers/stripe.js');
const { mtnReferenceId } = await import('../server/payments/providers/mtn-momo.js');
const { run } = await import('../server/db.js');
const { saveProviderConfig } = await import('../server/payments/config.js');

// ---------------------------------------------------------------------------------------------
// Fake fetch: records every request and answers canned JSON. Nothing leaves the machine.
// ---------------------------------------------------------------------------------------------

const NOW = new Date('2026-11-10T12:00:00Z');
const NOW_S = Math.floor(NOW.getTime() / 1000);

interface Call { url: string; method: string; headers: Record<string, string>; body: string; json(): any; form(): URLSearchParams }
type Reply = { status?: number; json?: unknown; text?: string; throws?: Error };
interface Route { method?: string; url: string | RegExp; reply: Reply | ((call: Call) => Reply); times?: number }

function fake(id: string, routes: Route[], webhookUrl = `https://api.alpha.test/api/payments/webhooks/${id}`) {
  const calls: Call[] = [];
  const unmatched: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init.headers ?? {}) as Record<string, string>)) headers[key.toLowerCase()] = value;
    const body = typeof init.body === 'string' ? init.body : '';
    const call: Call = { url, method, headers, body, json: () => JSON.parse(body), form: () => new URLSearchParams(body) };
    calls.push(call);
    const route = routes.find((item) => (item.times ?? 1) > 0 && (!item.method || item.method === method) && (typeof item.url === 'string' ? url.startsWith(item.url) : item.url.test(url)));
    if (!route) {
      unmatched.push(`${method} ${url}`);
      return new Response('{"message":"unmatched route"}', { status: 418 });
    }
    if (route.times !== undefined) route.times -= 1;
    const reply = typeof route.reply === 'function' ? route.reply(call) : route.reply;
    if (reply.throws) throw reply.throws;
    const text = reply.text ?? (reply.json === undefined ? '' : JSON.stringify(reply.json));
    return new Response(text === '' ? null : text, { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const context: ProviderContext = { fetch: fetchImpl, now: () => NOW, webhookUrl };
  return { calls, unmatched, context, last: () => calls[calls.length - 1] };
}

function provider(id: string): PaymentProvider {
  const found = getProvider(id);
  assert.ok(found, `provider ${id} registered`);
  return found;
}

function cfg(id: string, environment: 'sandbox' | 'live', settings: Record<string, string>, secrets: Record<string, string>): ProviderConfig {
  return { id: id as ProviderConfig['id'], environment, settings, secrets };
}

const collectRequest = (over: Partial<CollectRequest> = {}): CollectRequest => ({
  reference: 'pay_ref_001',
  amountMinor: 5000,
  currency: 'XAF',
  description: 'Mission Alpha',
  customer: { name: 'Awa Diallo', email: 'awa@example.test', phone: '+237677123456' },
  returnUrl: 'https://alpha.test/pay/return',
  cancelUrl: 'https://alpha.test/pay/cancel',
  ...over,
});

const hook = (body: string | object, headers: Record<string, string> = {}, query: Record<string, unknown> = {}, method = 'POST'): WebhookInput => ({
  method,
  headers,
  rawBody: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
  query,
});

const queryOf = (url: string) => Object.fromEntries(new URL(url).searchParams);
const hmac = (secret: string, payload: string, encoding: 'hex' | 'base64' = 'hex') => createHmac('sha256', secret).update(payload).digest(encoding);

async function providerError(promise: Promise<unknown>) {
  try { await promise; }
  catch (error) {
    assert.ok(error instanceof ProviderError, `expected ProviderError, got ${String(error)}`);
    return error;
  }
  assert.fail('expected a ProviderError');
}

function assertNoLeak(message: string, values: string[]) {
  for (const value of values) assert.ok(!message.includes(value), `error message leaks "${value}": ${message}`);
}

// ---------------------------------------------------------------------------------------------
// Registry & shared helpers
// ---------------------------------------------------------------------------------------------

test('registry exposes the simulator and the 7 real adapters with coherent metadata', () => {
  const ids = listProviders().map((item) => item.id);
  assert.deepEqual(ids, ['simulator', 'stripe', 'flutterwave', 'campay', 'mtn_momo', 'orange_money', 'wave', 'kratos_pay']);
  for (const item of listProviders()) {
    const keys = item.fields.map((field) => field.key);
    assert.equal(new Set(keys).size, keys.length, `${item.id}: unique field keys`);
    if (item.id !== 'simulator') assert.match(item.docsUrl, /^https:\/\//);
    assert.ok(item.label && item.countries.length && item.currencies.length && item.methods.length, item.id);
    for (const currency of item.currencies) assert.doesNotThrow(() => exponent(currency), `${item.id}: exponent(${currency})`);
    const currencyField = item.fields.find((field) => field.key === 'currency');
    assert.ok(currencyField, `${item.id}: currency field`);
    if (item.id !== 'simulator') {
      assert.equal(currencyField.required, true);
      for (const option of currencyField.options ?? []) assert.ok(item.currencies.includes(option), `${item.id}: ${option}`);
      assert.equal(typeof item.payout === 'function', item.capabilities.payout, `${item.id}: payout capability`);
      assert.equal(typeof item.refund === 'function', item.capabilities.refund, `${item.id}: refund capability`);
      assert.ok(item.fields.some((field) => field.secret && field.required), `${item.id}: has a required secret`);
      // Every adapter lets tests/self-hosted mocks override the API host.
      assert.ok(keys.includes('base_url'), `${item.id}: base_url override`);
      assert.deepEqual(item.validateConfig(cfg(item.id, 'sandbox', {}, {})), [], `${item.id}: empty config only reports via required fields`);
    }
  }
});

test('amount helpers convert minor units exactly (EUR 2 decimals, XAF/XOF 0 decimals)', () => {
  assert.equal(http.toMajorString(1250, 'EUR'), '12.50');
  assert.equal(http.toMajorString(5, 'EUR'), '0.05');
  assert.equal(http.toMajorString(5000, 'XAF'), '5000');
  assert.equal(http.toMajorNumber(1999, 'EUR'), 19.99);
  assert.equal(http.fromMajor('12.5', 'EUR'), 1250);
  assert.equal(http.fromMajor(19.99, 'EUR'), 1999);
  assert.equal(http.fromMajor('5000', 'XAF'), 5000);
  assert.equal(http.fromMajor('abc', 'EUR'), undefined);
  assert.equal(http.fromMajor('10', 'OUV'), undefined);
  assert.equal(toStripeAmount(1250, 'EUR'), 1250);
  assert.equal(toStripeAmount(5000, 'XAF'), 5000);
  assert.equal(http.toWholeMajor('campay', 5000, 'XAF'), 5000);
  assert.throws(() => http.toWholeMajor('campay', 1250, 'EUR'), /montants entiers/);
  assert.throws(() => http.rescale('stripe', 1001, 1, 0), ProviderError);
});

test('phone and operator helpers normalise numbers without echoing them', () => {
  assert.equal(http.msisdn('campay', '6 77 12 34 56', 'CM'), '237677123456');
  assert.equal(http.msisdn('campay', '+237 690 00 00 00'), '237690000000');
  assert.equal(http.msisdn('wave', '0022177 123 45 67'), '221771234567');
  assert.equal(http.cameroonOperator('237677123456'), 'mtn');
  assert.equal(http.cameroonOperator('690000000'), 'orange');
  assert.equal(http.cameroonOperator('237655000000'), 'orange');
  assert.equal(http.normalizeOperator('Orange Money'), 'orange');
  assert.equal(http.normalizeOperator('MTN-MoMo'), 'mtn');
  try { http.msisdn('campay', '12ab'); assert.fail('should throw'); }
  catch (error) { assert.ok(error instanceof ProviderError); assert.ok(!error.message.includes('12ab')); }
  const masked = http.sanitizeText('Invalid number +237 677 12 34 56 for awa@example.test using Bearer abc.def key sk_test_SECRET', ['sk_test_SECRET']);
  assertNoLeak(masked, ['677', 'awa@example.test', 'abc.def', 'sk_test_SECRET']);
});

test('callProvider: retryable on 5xx/429/network, non-retryable 4xx, sanitized messages, 401 token refresh', async () => {
  const config = cfg('stripe', 'sandbox', {}, { secret_key: 'sk_test_LEAKME123' });
  const f = fake('stripe', [
    { url: 'https://x.test/503', reply: { status: 503, json: { message: 'down' } } },
    { url: 'https://x.test/429', reply: { status: 429, json: {} } },
    { url: 'https://x.test/net', reply: { throws: new TypeError('fetch failed') } },
    { url: 'https://x.test/timeout', reply: { throws: Object.assign(new Error('timeout'), { name: 'TimeoutError' }) } },
    { url: 'https://x.test/400', reply: { status: 400, json: { error: { message: 'Bad key sk_test_LEAKME123 for +237677123456' } } } },
    { url: 'https://x.test/html', reply: { status: 200, text: '<html>oops</html>' } },
  ]);
  for (const path of ['503', '429', 'net', 'timeout']) {
    const error = await providerError(http.callProvider('stripe', config, f.context, { url: `https://x.test/${path}` }));
    assert.equal(error.retryable, true, path);
  }
  const bad = await providerError(http.callProvider('stripe', config, f.context, { url: 'https://x.test/400' }));
  assert.equal(bad.retryable, false);
  assert.equal(bad.httpStatus, 400);
  assertNoLeak(bad.message, ['sk_test_LEAKME123', '677123456']);
  assert.match(bad.message, /HTTP 400/);
  const html = await providerError(http.callProvider('stripe', config, f.context, { url: 'https://x.test/html' }));
  assert.equal(html.retryable, false);

  let fetched = 0;
  const g = fake('stripe', [
    { url: 'https://x.test/op', times: 1, reply: { status: 401, json: { message: 'expired' } } },
    { url: 'https://x.test/op', reply: (call) => ({ json: { auth: call.headers.authorization } }) },
  ]);
  http.clearProviderTokenCache();
  const fetcher = async () => ({ token: `tok-${++fetched}`, expiresIn: 3600 });
  const result = await http.withToken('k', g.context, fetcher, (tokenValue) => http.callProvider('stripe', config, g.context, { url: 'https://x.test/op', headers: { authorization: tokenValue } }));
  assert.equal(result.data.auth, 'tok-2');
  assert.equal(fetched, 2);
  await http.withToken('k', g.context, fetcher, async () => 'cached');
  assert.equal(fetched, 2, 'token reused from cache');
});

test('config.ts integration: saveProviderConfig runs adapter validation', () => {
  run("INSERT INTO users(id,name,email,password_hash) VALUES ('admin-pp','Admin','admin-pp@example.test','x')");
  assert.throws(() => saveProviderConfig('stripe', 'sandbox', { enabled: true, settings: { currency: 'EUR' }, secrets: { secret_key: 'sk_live_abc', webhook_secret: 'whsec_abc' } }, 'admin-pp'), /clé de test/);
  assert.throws(() => saveProviderConfig('mtn_momo', 'sandbox', { enabled: true, settings: { currency: 'XAF', target_environment: 'nowhere' }, secrets: {} }, 'admin-pp'), /valeur non autorisée/);
  const saved = saveProviderConfig('stripe', 'sandbox', { enabled: true, settings: { currency: 'EUR' }, secrets: { secret_key: 'sk_test_abc', webhook_secret: 'whsec_abc' } }, 'admin-pp');
  assert.ok(saved);
});

// ---------------------------------------------------------------------------------------------
// Stripe
// ---------------------------------------------------------------------------------------------

const STRIPE = cfg('stripe', 'sandbox', { currency: 'EUR' }, { secret_key: 'sk_test_51abcDEF', webhook_secret: 'whsec_testSecret123' });

function stripeSignature(body: string, secret = 'whsec_testSecret123', timestamp = NOW_S) {
  return `t=${timestamp},v1=${hmac(secret, `${timestamp}.${body}`)}`;
}

test('stripe: checkout session request (form, idempotency, cents vs zero-decimal XAF) and status mapping', async () => {
  const f = fake('stripe', [
    { method: 'POST', url: 'https://api.stripe.com/v1/checkout/sessions', reply: { json: { id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1', status: 'open' } } },
    { method: 'GET', url: 'https://api.stripe.com/v1/checkout/sessions/cs_paid', reply: { json: { id: 'cs_paid', status: 'complete', payment_status: 'paid', amount_total: 1250, currency: 'eur' } } },
    { method: 'GET', url: 'https://api.stripe.com/v1/checkout/sessions/cs_expired', reply: { json: { id: 'cs_expired', status: 'expired', payment_status: 'unpaid', amount_total: 5000, currency: 'xaf' } } },
    { method: 'GET', url: 'https://api.stripe.com/v1/checkout/sessions/cs_open', reply: { json: { id: 'cs_open', status: 'open', payment_status: 'unpaid', amount_total: 1250, currency: 'eur' } } },
  ]);
  const stripe = provider('stripe');
  const result = await stripe.collect(STRIPE, collectRequest({ amountMinor: 1250, currency: 'EUR', method: 'card' }), f.context);
  assert.deepEqual({ kind: result.kind, ref: result.providerReference }, { kind: 'redirect', ref: 'cs_test_1' });
  const call = f.last();
  assert.equal(call.headers.authorization, 'Bearer sk_test_51abcDEF');
  assert.equal(call.headers['idempotency-key'], 'alpha-collect-pay_ref_001');
  assert.equal(call.headers['content-type'], 'application/x-www-form-urlencoded');
  const form = call.form();
  assert.equal(form.get('mode'), 'payment');
  assert.equal(form.get('line_items[0][price_data][unit_amount]'), '1250');
  assert.equal(form.get('line_items[0][price_data][currency]'), 'eur');
  assert.equal(form.get('client_reference_id'), 'pay_ref_001');
  assert.equal(form.get('payment_method_types[0]'), 'card');
  assert.equal(form.get('customer_email'), 'awa@example.test');

  await stripe.collect(cfg('stripe', 'sandbox', { currency: 'XAF' }, STRIPE.secrets), collectRequest({ amountMinor: 5000, currency: 'XAF' }), f.context);
  assert.equal(f.last().form().get('line_items[0][price_data][unit_amount]'), '5000', 'XAF is zero-decimal in Stripe');

  const paid = await stripe.status(STRIPE, 'collection', 'cs_paid', f.context);
  assert.deepEqual([paid.status, paid.amountMinor, paid.currency], ['succeeded', 1250, 'EUR']);
  assert.match(f.last().url, /expand%5B%5D=payment_intent|expand\[\]=payment_intent/);
  const expired = await stripe.status(STRIPE, 'collection', 'cs_expired', f.context);
  assert.deepEqual([expired.status, expired.amountMinor, expired.currency], ['cancelled', 5000, 'XAF']);
  assert.equal((await stripe.status(STRIPE, 'collection', 'cs_open', f.context)).status, 'pending');
  assert.deepEqual(f.unmatched, []);
});

test('stripe: Connect transfer payouts and refunds', async () => {
  const f = fake('stripe', [
    { method: 'POST', url: 'https://api.stripe.com/v1/transfers', reply: { json: { id: 'tr_1', amount: 4000, currency: 'eur', reversed: false, destination: 'acct_123' } } },
    { method: 'GET', url: 'https://api.stripe.com/v1/transfers/tr_rev', reply: { json: { id: 'tr_rev', amount: 4000, amount_reversed: 4000, currency: 'eur', reversed: true } } },
    { method: 'GET', url: 'https://api.stripe.com/v1/checkout/sessions/cs_paid', reply: { json: { id: 'cs_paid', payment_intent: 'pi_123' } } },
    { method: 'POST', url: 'https://api.stripe.com/v1/refunds', reply: { json: { id: 're_1', status: 'succeeded', amount: 500, currency: 'eur' } } },
    { method: 'GET', url: 'https://api.stripe.com/v1/refunds/re_1', reply: { json: { id: 're_1', status: 'pending', amount: 500, currency: 'eur' } } },
  ]);
  const stripe = provider('stripe');
  const payoutRequest = { reference: 'po_1', amountMinor: 4000, currency: 'EUR', description: 'Versement mission', recipient: { name: 'Awa', accountId: 'acct_123' } };
  const payout = await stripe.payout!(STRIPE, payoutRequest, f.context);
  assert.deepEqual([payout.status, payout.providerReference], ['succeeded', 'tr_1']);
  assert.equal(f.last().headers['idempotency-key'], 'alpha-payout-po_1');
  assert.equal(f.last().form().get('destination'), 'acct_123');
  assert.equal(f.last().form().get('amount'), '4000');
  await providerError(stripe.payout!(STRIPE, { ...payoutRequest, recipient: { name: 'Awa' } }, f.context));
  assert.equal((await stripe.status(STRIPE, 'payout', 'tr_rev', f.context)).status, 'failed');

  const refund = await stripe.refund!(STRIPE, { reference: 'rf_1', providerReference: 'cs_paid', amountMinor: 500, currency: 'EUR', reason: 'Annulation' }, f.context);
  assert.deepEqual([refund.status, refund.providerReference], ['succeeded', 're_1']);
  assert.equal(f.last().form().get('payment_intent'), 'pi_123');
  assert.equal(f.last().form().get('amount'), '500');
  assert.equal(f.last().headers['idempotency-key'], 'alpha-refund-rf_1');
  const refundStatus = await stripe.status(STRIPE, 'refund', 're_1', f.context);
  assert.deepEqual([refundStatus.status, refundStatus.amountMinor], ['pending', 500]);
});

test('stripe: webhook signature (valid, multiple v1, wrong secret, tampered body, expired timestamp)', async () => {
  const stripe = provider('stripe');
  const f = fake('stripe', []);
  const body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs_paid', client_reference_id: 'pay_ref_001', payment_status: 'paid', status: 'complete', amount_total: 1250, currency: 'eur' } } });
  const events = await stripe.verifyWebhook(STRIPE, hook(body, { 'Stripe-Signature': stripeSignature(body) }), f.context);
  assert.deepEqual(events?.map((event) => [event.type, event.reference, event.providerReference, event.status, event.amountMinor, event.eventId]), [['collection', 'pay_ref_001', 'cs_paid', 'succeeded', 1250, 'evt_1']]);
  const multi = `t=${NOW_S},v1=${'0'.repeat(64)},v1=${hmac('whsec_testSecret123', `${NOW_S}.${body}`)}`;
  assert.equal((await stripe.verifyWebhook(STRIPE, hook(body, { 'stripe-signature': multi }), f.context))?.length, 1);
  assert.equal(await stripe.verifyWebhook(STRIPE, hook(body, { 'stripe-signature': stripeSignature(body, 'whsec_other') }), f.context), null);
  assert.equal(await stripe.verifyWebhook(STRIPE, hook(body.replace('1250', '125000'), { 'stripe-signature': stripeSignature(body) }), f.context), null);
  assert.equal(await stripe.verifyWebhook(STRIPE, hook(body, { 'stripe-signature': stripeSignature(body, undefined, NOW_S - 600) }), f.context), null);
  assert.equal(await stripe.verifyWebhook(STRIPE, hook(body, {}), f.context), null);
  const other = JSON.stringify({ id: 'evt_2', type: 'customer.created', data: { object: {} } });
  assert.deepEqual(await stripe.verifyWebhook(STRIPE, hook(other, { 'stripe-signature': stripeSignature(other) }), f.context), []);
});

test('stripe: validateConfig checks key formats against the environment', () => {
  const stripe = provider('stripe');
  assert.deepEqual(stripe.validateConfig(STRIPE), []);
  assert.match(stripe.validateConfig(cfg('stripe', 'sandbox', { currency: 'EUR' }, { secret_key: 'sk_live_abc', webhook_secret: 'whsec_x' })).join(), /clé de test/);
  assert.match(stripe.validateConfig(cfg('stripe', 'live', { currency: 'EUR' }, { secret_key: 'sk_test_abc', webhook_secret: 'whsec_x' })).join(), /clé live/);
  assert.match(stripe.validateConfig(cfg('stripe', 'live', {}, { secret_key: 'pk_live_abc' })).join(), /sk_test_/);
  assert.match(stripe.validateConfig(cfg('stripe', 'live', {}, { webhook_secret: 'abc' })).join(), /whsec_/);
  assert.match(stripe.validateConfig(cfg('stripe', 'live', { currency: 'UGX' }, {})).join(), /UGX/);
  assert.match(stripe.validateConfig(cfg('stripe', 'live', { base_url: 'http://evil.test' }, {})).join(), /HTTPS/);
  assert.deepEqual(stripe.validateConfig(cfg('stripe', 'live', { currency: 'XOF' }, { secret_key: 'rk_live_abc', webhook_secret: 'whsec_x' })), []);
});

// ---------------------------------------------------------------------------------------------
// Flutterwave
// ---------------------------------------------------------------------------------------------

const FLW = cfg('flutterwave', 'sandbox', { currency: 'XAF' }, { secret_key: 'FLWSECK_TEST-abc123def-X', secret_hash: 'flw-hash-0123456789abcdef' });

test('flutterwave: hosted payment in MAJOR units, verify by tx_ref, status mapping', async () => {
  const f = fake('flutterwave', [
    { method: 'POST', url: 'https://api.flutterwave.com/v3/payments', reply: { json: { status: 'success', data: { link: 'https://checkout.flutterwave.com/v3/hosted/pay/abc' } } } },
    { method: 'GET', url: 'https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=pay_ok', reply: { json: { status: 'success', data: { id: 42, tx_ref: 'pay_ok', status: 'successful', amount: 5000, currency: 'XAF' } } } },
    { method: 'GET', url: 'https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=pay_eur', reply: { json: { status: 'success', data: { id: 43, tx_ref: 'pay_eur', status: 'successful', amount: 12.5, currency: 'EUR' } } } },
    { method: 'GET', url: 'https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=pay_ko', reply: { json: { status: 'success', data: { id: 44, tx_ref: 'pay_ko', status: 'failed', amount: 5000, currency: 'XAF', processor_response: 'Insufficient funds' } } } },
    { method: 'GET', url: 'https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=pay_none', reply: { status: 400, json: { status: 'error', message: 'No transaction was found for this id' } } },
  ]);
  const flw = provider('flutterwave');
  const result = await flw.collect(FLW, collectRequest({ method: 'mobile_money' }), f.context);
  assert.deepEqual([result.kind, result.providerReference], ['redirect', 'pay_ref_001']);
  const call = f.last();
  assert.equal(call.headers.authorization, 'Bearer FLWSECK_TEST-abc123def-X');
  const body = call.json();
  assert.equal(body.amount, 5000, 'XAF major units');
  assert.equal(body.currency, 'XAF');
  assert.equal(body.tx_ref, 'pay_ref_001');
  assert.equal(body.payment_options, 'mobilemoneyfranco');
  assert.equal(body.redirect_url, 'https://alpha.test/pay/return');
  await flw.collect(cfg('flutterwave', 'sandbox', { currency: 'EUR' }, FLW.secrets), collectRequest({ amountMinor: 1250, currency: 'EUR', method: 'card' }), f.context);
  assert.equal(f.last().json().amount, 12.5, 'EUR in major units (decimal)');
  assert.equal(f.last().json().payment_options, 'card');

  const ok = await flw.status(FLW, 'collection', 'pay_ok', f.context);
  assert.deepEqual([ok.status, ok.amountMinor, ok.currency], ['succeeded', 5000, 'XAF']);
  const eur = await flw.status(FLW, 'collection', 'pay_eur', f.context);
  assert.deepEqual([eur.status, eur.amountMinor, eur.currency], ['succeeded', 1250, 'EUR']);
  assert.equal((await flw.status(FLW, 'collection', 'pay_ko', f.context)).status, 'failed');
  assert.equal((await flw.status(FLW, 'collection', 'pay_none', f.context)).status, 'pending');
  assert.deepEqual(f.unmatched, []);
});

test('flutterwave: mobile money transfers and refunds', async () => {
  const f = fake('flutterwave', [
    { method: 'POST', url: 'https://api.flutterwave.com/v3/transfers', reply: { json: { status: 'success', data: { id: 9001, status: 'NEW', reference: 'po_1', amount: 10000, currency: 'XOF' } } } },
    { method: 'GET', url: 'https://api.flutterwave.com/v3/transfers/9001', reply: { json: { status: 'success', data: { id: 9001, status: 'SUCCESSFUL', amount: 10000, currency: 'XOF' } } } },
    { method: 'GET', url: 'https://api.flutterwave.com/v3/transfers/9002', reply: { json: { status: 'success', data: { id: 9002, status: 'FAILED', amount: 10000, currency: 'XOF', complete_message: 'Account resolve failed' } } } },
    { method: 'GET', url: 'https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=pay_ok', reply: { json: { status: 'success', data: { id: 42, tx_ref: 'pay_ok', status: 'successful', amount: 5000, currency: 'XAF' } } } },
    { method: 'POST', url: 'https://api.flutterwave.com/v3/transactions/42/refund', reply: { json: { status: 'success', data: { id: 77, status: 'completed', amount_refunded: 2000 } } } },
    { method: 'GET', url: 'https://api.flutterwave.com/v3/refunds/77', reply: { json: { status: 'success', data: { id: 77, status: 'completed', amount_refunded: 2000, currency: 'XAF' } } } },
  ]);
  const flw = provider('flutterwave');
  const payout = await flw.payout!(cfg('flutterwave', 'sandbox', { currency: 'XOF' }, FLW.secrets), { reference: 'po_1', amountMinor: 10000, currency: 'XOF', description: 'Versement', recipient: { name: 'Koffi', phone: '07 07 12 34 56', country: 'CI', operator: 'orange' } }, f.context);
  assert.deepEqual([payout.status, payout.providerReference], ['pending', '9001']);
  const body = f.last().json();
  assert.deepEqual([body.account_bank, body.account_number, body.amount, body.currency, body.reference], ['orangemoney', '2250707123456', 10000, 'XOF', 'po_1']);
  assert.equal((await flw.status(FLW, 'payout', '9001', f.context)).status, 'succeeded');
  const failed = await flw.status(FLW, 'payout', '9002', f.context);
  assert.equal(failed.status, 'failed');
  assert.match(failed.failureReason ?? '', /Account resolve failed/);

  const refund = await flw.refund!(FLW, { reference: 'rf_1', providerReference: 'pay_ok', amountMinor: 2000, currency: 'XAF', reason: 'Annulation' }, f.context);
  assert.deepEqual([refund.status, refund.providerReference], ['succeeded', '77']);
  assert.equal(f.last().json().amount, 2000);
  assert.equal((await flw.status(FLW, 'refund', '77', f.context)).amountMinor, 2000);
  assert.deepEqual(f.unmatched, []);
});

test('flutterwave: verif-hash webhook (valid, wrong hash, missing, body HMAC variant, tampered body)', async () => {
  const flw = provider('flutterwave');
  const f = fake('flutterwave', []);
  const body = JSON.stringify({ event: 'charge.completed', data: { id: 42, tx_ref: 'pay_ref_001', status: 'successful', amount: 5000, currency: 'XAF' } });
  const events = await flw.verifyWebhook(FLW, hook(body, { 'verif-hash': 'flw-hash-0123456789abcdef' }), f.context);
  assert.deepEqual(events?.map((event) => [event.type, event.reference, event.status, event.amountMinor, event.currency]), [['collection', 'pay_ref_001', 'succeeded', 5000, 'XAF']]);
  assert.equal(await flw.verifyWebhook(FLW, hook(body, { 'verif-hash': 'wrong-hash-0123456789' }), f.context), null);
  assert.equal(await flw.verifyWebhook(FLW, hook(body, {}), f.context), null);
  const signature = hmac('flw-hash-0123456789abcdef', body, 'base64');
  assert.equal((await flw.verifyWebhook(FLW, hook(body, { 'flutterwave-signature': signature }), f.context))?.length, 1);
  assert.equal(await flw.verifyWebhook(FLW, hook(body.replace('5000', '50'), { 'flutterwave-signature': signature }), f.context), null);
  const transfer = JSON.stringify({ event: 'transfer.completed', data: { id: 9001, reference: 'po_1', status: 'FAILED', amount: 10000, currency: 'XOF' } });
  const payoutEvents = await flw.verifyWebhook(FLW, hook(transfer, { 'verif-hash': 'flw-hash-0123456789abcdef' }), f.context);
  assert.deepEqual(payoutEvents?.map((event) => [event.type, event.reference, event.providerReference, event.status]), [['payout', 'po_1', '9001', 'failed']]);
});

test('flutterwave: validateConfig', () => {
  const flw = provider('flutterwave');
  assert.deepEqual(flw.validateConfig(FLW), []);
  assert.match(flw.validateConfig(cfg('flutterwave', 'sandbox', {}, { secret_key: 'FLWSECK-live123-X' })).join(), /FLWSECK_TEST-/);
  assert.match(flw.validateConfig(cfg('flutterwave', 'live', {}, { secret_key: 'FLWSECK_TEST-abc-X' })).join(), /live/);
  assert.match(flw.validateConfig(cfg('flutterwave', 'live', {}, { secret_key: 'sk_live_x' })).join(), /FLWSECK/);
  assert.match(flw.validateConfig(cfg('flutterwave', 'live', {}, { secret_hash: 'short' })).join(), /16 caractères/);
  assert.match(flw.validateConfig(cfg('flutterwave', 'live', { payment_options: 'card; drop' }, {})).join(), /payment_options/);
});

test('phone helper keeps the significant leading zero of 10-digit plans (CI, BJ)', () => {
  assert.equal(http.msisdn('wave', '07 07 12 34 56', 'CI'), '2250707123456');
  assert.equal(http.msisdn('mtn_momo', '01 97 12 34 56', 'BJ'), '2290197123456');
  assert.equal(http.msisdn('wave', '77 123 45 67', 'SN'), '221771234567');
});

// ---------------------------------------------------------------------------------------------
// CamPay
// ---------------------------------------------------------------------------------------------

const CAMPAY = cfg('campay', 'sandbox', { currency: 'XAF' }, { app_username: 'alpha-app-user', app_password: 'campay-pass-123', webhook_key: 'campay-webhook-key-123' });
const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function jwt(claims: Record<string, unknown>, key = 'campay-webhook-key-123', alg = 'HS256') {
  const head = b64url({ alg, typ: 'JWT' });
  const payload = b64url(claims);
  return `${head}.${payload}.${createHmac('sha256', key).update(`${head}.${payload}`).digest('base64url')}`;
}

test('campay: token auth, USSD collect (XAF whole units), payment link, status, withdraw', async () => {
  http.clearProviderTokenCache();
  const f = fake('campay', [
    { method: 'POST', url: 'https://demo.campay.net/api/token/', reply: { json: { token: 'campay-token-1', expires_in: 3600 } } },
    { method: 'POST', url: 'https://demo.campay.net/api/collect/', reply: { json: { reference: 'cp-ref-1', ussd_code: '*126#', operator: 'MTN' } } },
    { method: 'POST', url: 'https://demo.campay.net/api/get_payment_link/', reply: { json: { link: 'https://demo.campay.net/pay/abc', reference: 'cp-ref-2' } } },
    { method: 'GET', url: 'https://demo.campay.net/api/transaction/cp-ref-1/', reply: { json: { reference: 'cp-ref-1', status: 'SUCCESSFUL', amount: 5000, currency: 'XAF', operator: 'MTN' } } },
    { method: 'GET', url: 'https://demo.campay.net/api/transaction/cp-ko/', reply: { json: { reference: 'cp-ko', status: 'FAILED', amount: 5000, currency: 'XAF', code: 'ER201' } } },
    { method: 'GET', url: 'https://demo.campay.net/api/transaction/cp-unknown/', reply: { status: 404, json: { message: 'Not found' } } },
    { method: 'POST', url: 'https://demo.campay.net/api/withdraw/', reply: { json: { reference: 'cp-wd-1', status: 'PENDING' } } },
  ]);
  const campay = provider('campay');
  const result = await campay.collect(CAMPAY, collectRequest({ customer: { name: 'Awa', email: 'awa@example.test', phone: '677 12 34 56' } }), f.context);
  assert.equal(result.kind, 'pending_approval');
  assert.equal(result.providerReference, 'cp-ref-1');
  if (result.kind === 'pending_approval') {
    assert.match(result.instructions, /5000 XAF/);
    assert.ok(!result.instructions.includes('677'), 'instructions never echo the phone number');
  }
  const [tokenCall, collectCall] = f.calls;
  assert.deepEqual(tokenCall.json(), { username: 'alpha-app-user', password: 'campay-pass-123' });
  assert.equal(collectCall.headers.authorization, 'Token campay-token-1');
  assert.deepEqual(collectCall.json(), { amount: '5000', currency: 'XAF', from: '237677123456', description: 'Mission Alpha', external_reference: 'pay_ref_001' });

  const link = await campay.collect(CAMPAY, collectRequest({ reference: 'pay_ref_002', customer: { name: 'Awa', email: 'awa@example.test' } }), f.context);
  assert.deepEqual([link.kind, link.providerReference], ['redirect', 'cp-ref-2']);
  assert.equal(f.last().json().redirect_url, 'https://alpha.test/pay/return');
  assert.equal(f.calls.filter((call) => call.url.endsWith('/token/')).length, 1, 'token cached');

  const ok = await campay.status(CAMPAY, 'collection', 'cp-ref-1', f.context);
  assert.deepEqual([ok.status, ok.amountMinor, ok.currency], ['succeeded', 5000, 'XAF']);
  assert.equal((await campay.status(CAMPAY, 'collection', 'cp-ko', f.context)).status, 'failed');
  assert.equal((await campay.status(CAMPAY, 'collection', 'cp-unknown', f.context)).status, 'pending');

  const payout = await campay.payout!(CAMPAY, { reference: 'po_1', amountMinor: 3000, currency: 'XAF', description: 'Versement', recipient: { name: 'Awa', phone: '690000000' } }, f.context);
  assert.deepEqual([payout.status, payout.providerReference], ['pending', 'cp-wd-1']);
  assert.deepEqual(f.last().json(), { amount: '3000', currency: 'XAF', to: '237690000000', description: 'Versement', external_reference: 'po_1' });
  assert.equal(campay.refund, undefined);
  await providerError(campay.collect(CAMPAY, collectRequest({ currency: 'EUR', amountMinor: 1250 }), f.context));
  assert.deepEqual(f.unmatched, []);
});

test('campay: expired token is refreshed once on 401', async () => {
  http.clearProviderTokenCache();
  let issued = 0;
  const f = fake('campay', [
    { method: 'POST', url: 'https://demo.campay.net/api/token/', reply: () => ({ json: { token: `tok-${++issued}`, expires_in: 3600 } }) },
    { method: 'GET', url: 'https://demo.campay.net/api/transaction/cp-ref-1/', times: 1, reply: { status: 401, json: { detail: 'Invalid token.' } } },
    { method: 'GET', url: 'https://demo.campay.net/api/transaction/cp-ref-1/', reply: { json: { reference: 'cp-ref-1', status: 'PENDING', amount: 5000, currency: 'XAF' } } },
  ]);
  const status = await provider('campay').status(CAMPAY, 'collection', 'cp-ref-1', f.context);
  assert.equal(status.status, 'pending');
  assert.equal(issued, 2);
  assert.equal(f.last().headers.authorization, 'Token tok-2');
});

test('campay: callback JWT signature (valid, wrong key, tampered params, expired, alg none)', async () => {
  const campay = provider('campay');
  const f = fake('campay', []);
  const params = { status: 'SUCCESSFUL', reference: 'cp-ref-1', amount: '5000', currency: 'XAF', operator: 'MTN', endpoint: 'collect', external_reference: 'pay_ref_001' };
  const good = jwt({ reference: 'cp-ref-1', exp: NOW_S + 300 });
  const events = await campay.verifyWebhook(CAMPAY, hook('', {}, { ...params, signature: good }, 'GET'), f.context);
  assert.deepEqual(events?.map((event) => [event.type, event.reference, event.providerReference, event.status, event.amountMinor]), [['collection', 'pay_ref_001', 'cp-ref-1', 'succeeded', 5000]]);
  const withdraw = await campay.verifyWebhook(CAMPAY, hook(JSON.stringify({ ...params, endpoint: 'withdraw', signature: good }), { 'content-type': 'application/json' }), f.context);
  assert.equal(withdraw?.[0].type, 'payout');
  assert.equal(await campay.verifyWebhook(CAMPAY, hook('', {}, { ...params, signature: jwt({ reference: 'cp-ref-1' }, 'other-key') }, 'GET'), f.context), null);
  assert.equal(await campay.verifyWebhook(CAMPAY, hook('', {}, { ...params, reference: 'cp-other', signature: good }, 'GET'), f.context), null, 'claims bound to the reference');
  assert.equal(await campay.verifyWebhook(CAMPAY, hook('', {}, { ...params, signature: `${good.slice(0, -2)}xx` }, 'GET'), f.context), null);
  assert.equal(await campay.verifyWebhook(CAMPAY, hook('', {}, { ...params, signature: jwt({ reference: 'cp-ref-1', exp: NOW_S - 3600 }) }, 'GET'), f.context), null, 'expired');
  const none = `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ reference: 'cp-ref-1' })}.`;
  assert.equal(await campay.verifyWebhook(CAMPAY, hook('', {}, { ...params, signature: none }, 'GET'), f.context), null);
  assert.equal(await campay.verifyWebhook(CAMPAY, hook('', {}, params, 'GET'), f.context), null, 'missing signature');
});

test('campay: validateConfig', () => {
  const campay = provider('campay');
  assert.deepEqual(campay.validateConfig(CAMPAY), []);
  assert.match(campay.validateConfig(cfg('campay', 'sandbox', { currency: 'EUR' }, {})).join(), /EUR/);
  assert.match(campay.validateConfig(cfg('campay', 'sandbox', {}, { webhook_key: 'short' })).join(), /trop courte/);
});

// ---------------------------------------------------------------------------------------------
// MTN MoMo
// ---------------------------------------------------------------------------------------------

const MTN_SECRETS = {
  collection_subscription_key: '0123456789abcdef0123456789abcdef',
  collection_api_user: '3f1c2a4e-1b2c-4d5e-8f90-123456789abc',
  collection_api_key: 'mtn-collection-key-123',
};
const MTN_DISB = {
  disbursement_subscription_key: 'fedcba9876543210fedcba9876543210',
  disbursement_api_user: '9a8b7c6d-1b2c-4d5e-8f90-abcdefabcdef',
  disbursement_api_key: 'mtn-disbursement-key-456',
};
const MTN = cfg('mtn_momo', 'sandbox', { target_environment: 'sandbox', currency: 'EUR' }, { ...MTN_SECRETS, ...MTN_DISB });
const MTN_LIVE = cfg('mtn_momo', 'live', { target_environment: 'mtncameroon', currency: 'XAF' }, MTN_SECRETS);

test('mtn_momo: token + requesttopay headers (Basic, subscription key, X-Reference-Id, target env, signed callback)', async () => {
  http.clearProviderTokenCache();
  const f = fake('mtn_momo', [
    { method: 'POST', url: 'https://sandbox.momodeveloper.mtn.com/collection/token/', reply: { json: { access_token: 'mtn-access-1', token_type: 'access_token', expires_in: 3600 } } },
    { method: 'POST', url: 'https://sandbox.momodeveloper.mtn.com/collection/v1_0/requesttopay', reply: { status: 202 } },
    { method: 'POST', url: 'https://momoapi.momo.africa/collection/token/', reply: { json: { access_token: 'mtn-live-1', expires_in: 3600 } } },
    { method: 'POST', url: 'https://momoapi.momo.africa/collection/v1_0/requesttopay', times: 1, reply: { status: 202 } },
    { method: 'POST', url: 'https://momoapi.momo.africa/collection/v1_0/requesttopay', reply: { status: 409, json: { code: 'RESOURCE_ALREADY_EXIST' } } },
  ]);
  const mtn = provider('mtn_momo');
  const result = await mtn.collect(MTN, collectRequest({ amountMinor: 1250, currency: 'EUR', customer: { name: 'Test', email: 't@example.test', phone: '+46733123450' } }), f.context);
  assert.equal(result.kind, 'pending_approval');
  const [tokenCall, payCall] = f.calls;
  assert.equal(tokenCall.headers.authorization, `Basic ${Buffer.from(`${MTN_SECRETS.collection_api_user}:${MTN_SECRETS.collection_api_key}`).toString('base64')}`);
  assert.equal(tokenCall.headers['ocp-apim-subscription-key'], MTN_SECRETS.collection_subscription_key);
  assert.equal(tokenCall.headers['x-target-environment'], 'sandbox');
  assert.equal(payCall.headers.authorization, 'Bearer mtn-access-1');
  assert.equal(payCall.headers['x-target-environment'], 'sandbox');
  assert.equal(payCall.headers['ocp-apim-subscription-key'], MTN_SECRETS.collection_subscription_key);
  assert.match(payCall.headers['x-reference-id'], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(result.providerReference, payCall.headers['x-reference-id']);
  assert.equal(mtnReferenceId(MTN, 'collection', 'pay_ref_001'), result.providerReference, 'deterministic reference id (idempotent retries)');
  const callback = new URL(payCall.headers['x-callback-url']);
  assert.equal(`${callback.origin}${callback.pathname}`, 'https://api.alpha.test/api/payments/webhooks/mtn_momo');
  assert.deepEqual([callback.searchParams.get('kind'), callback.searchParams.get('ref')], ['collection', 'pay_ref_001']);
  assert.deepEqual(payCall.json(), {
    amount: '12.50', currency: 'EUR', externalId: 'pay_ref_001',
    payer: { partyIdType: 'MSISDN', partyId: '46733123450' }, payerMessage: 'Mission Alpha', payeeNote: 'pay_ref_001',
  });

  const live = await mtn.collect(MTN_LIVE, collectRequest({ customer: { name: 'Awa', email: 'awa@example.test', phone: '677123456' } }), f.context);
  const liveCall = f.last();
  assert.equal(liveCall.headers['x-target-environment'], 'mtncameroon');
  assert.deepEqual([liveCall.json().amount, liveCall.json().currency, liveCall.json().payer.partyId], ['5000', 'XAF', '237677123456']);
  const retry = await mtn.collect(MTN_LIVE, collectRequest({ customer: { name: 'Awa', email: 'awa@example.test', phone: '677123456' } }), f.context);
  assert.equal(retry.providerReference, live.providerReference, '409 on retry keeps the same transaction');
  await providerError(mtn.collect(MTN_LIVE, collectRequest({ currency: 'EUR', amountMinor: 1250 }), f.context));
  assert.deepEqual(f.unmatched, []);
});

test('mtn_momo: status mapping, disbursement transfer and refund', async () => {
  http.clearProviderTokenCache();
  const f = fake('mtn_momo', [
    { method: 'POST', url: 'https://sandbox.momodeveloper.mtn.com/collection/token/', reply: { json: { access_token: 'mtn-access-1', expires_in: 3600 } } },
    { method: 'POST', url: 'https://sandbox.momodeveloper.mtn.com/disbursement/token/', reply: { json: { access_token: 'mtn-disb-1', expires_in: 3600 } } },
    { method: 'GET', url: 'https://sandbox.momodeveloper.mtn.com/collection/v1_0/requesttopay/ok', reply: { json: { amount: '12.50', currency: 'EUR', status: 'SUCCESSFUL', externalId: 'pay_ref_001', financialTransactionId: '123' } } },
    { method: 'GET', url: 'https://sandbox.momodeveloper.mtn.com/collection/v1_0/requesttopay/rejected', reply: { json: { amount: '12.50', currency: 'EUR', status: 'FAILED', reason: 'APPROVAL_REJECTED' } } },
    { method: 'GET', url: 'https://sandbox.momodeveloper.mtn.com/collection/v1_0/requesttopay/ko', reply: { json: { amount: '12.50', currency: 'EUR', status: 'FAILED', reason: { code: 'PAYER_NOT_FOUND', message: 'x' } } } },
    { method: 'GET', url: 'https://sandbox.momodeveloper.mtn.com/collection/v1_0/requesttopay/wait', reply: { json: { amount: '12.50', currency: 'EUR', status: 'PENDING' } } },
    { method: 'GET', url: 'https://sandbox.momodeveloper.mtn.com/collection/v1_0/requesttopay/missing', reply: { status: 404, json: { code: 'RESOURCE_NOT_FOUND' } } },
    { method: 'POST', url: 'https://sandbox.momodeveloper.mtn.com/disbursement/v1_0/transfer', reply: { status: 202 } },
    { method: 'GET', url: 'https://sandbox.momodeveloper.mtn.com/disbursement/v1_0/transfer/', reply: { json: { amount: '40.00', currency: 'EUR', status: 'SUCCESSFUL' } } },
    { method: 'POST', url: 'https://sandbox.momodeveloper.mtn.com/disbursement/v1_0/refund', reply: { status: 202 } },
  ]);
  const mtn = provider('mtn_momo');
  const ok = await mtn.status(MTN, 'collection', 'ok', f.context);
  assert.deepEqual([ok.status, ok.amountMinor, ok.currency], ['succeeded', 1250, 'EUR']);
  assert.equal((await mtn.status(MTN, 'collection', 'rejected', f.context)).status, 'cancelled');
  assert.equal((await mtn.status(MTN, 'collection', 'ko', f.context)).status, 'failed');
  assert.equal((await mtn.status(MTN, 'collection', 'wait', f.context)).status, 'pending');
  assert.equal((await mtn.status(MTN, 'collection', 'missing', f.context)).status, 'pending');

  const payout = await mtn.payout!(MTN, { reference: 'po_1', amountMinor: 4000, currency: 'EUR', description: 'Versement', recipient: { name: 'Test', phone: '+46733123450' } }, f.context);
  assert.equal(payout.status, 'pending');
  const transferCall = f.last();
  assert.equal(transferCall.headers.authorization, 'Bearer mtn-disb-1');
  assert.equal(transferCall.headers['ocp-apim-subscription-key'], MTN_DISB.disbursement_subscription_key);
  assert.equal(transferCall.headers['x-reference-id'], payout.providerReference);
  assert.deepEqual(transferCall.json().payee, { partyIdType: 'MSISDN', partyId: '46733123450' });
  assert.equal(transferCall.json().amount, '40.00');
  assert.equal(new URL(transferCall.headers['x-callback-url']).searchParams.get('kind'), 'payout');
  assert.equal((await mtn.status(MTN, 'payout', payout.providerReference, f.context)).amountMinor, 4000);

  const refund = await mtn.refund!(MTN, { reference: 'rf_1', providerReference: 'ok', amountMinor: 1250, currency: 'EUR', reason: 'Annulation' }, f.context);
  assert.equal(refund.status, 'pending');
  assert.equal(f.last().json().referenceIdToRefund, 'ok');
  assert.equal(f.calls.filter((call) => call.url.endsWith('/disbursement/token/')).length, 1);

  const noDisbursement = cfg('mtn_momo', 'sandbox', MTN.settings, MTN_SECRETS);
  const error = await providerError(mtn.payout!(noDisbursement, { reference: 'po_2', amountMinor: 4000, currency: 'EUR', description: 'x', recipient: { name: 'T', phone: '+46733123450' } }, f.context));
  assert.match(error.message, /Disbursement/);
  assert.deepEqual(f.unmatched, []);
});

test('mtn_momo: unsigned callbacks are bound by an URL HMAC and only report pending', async () => {
  http.clearProviderTokenCache();
  const f = fake('mtn_momo', [
    { method: 'POST', url: 'https://sandbox.momodeveloper.mtn.com/collection/token/', reply: { json: { access_token: 't', expires_in: 3600 } } },
    { method: 'POST', url: 'https://sandbox.momodeveloper.mtn.com/collection/v1_0/requesttopay', reply: { status: 202 } },
  ]);
  const mtn = provider('mtn_momo');
  const result = await mtn.collect(MTN, collectRequest({ amountMinor: 1250, currency: 'EUR', customer: { name: 'T', email: 't@example.test', phone: '+46733123450' } }), f.context);
  const query = queryOf(f.last().headers['x-callback-url']);
  const body = JSON.stringify({ externalId: 'pay_ref_001', amount: '12.50', currency: 'EUR', status: 'SUCCESSFUL' });
  const events = await mtn.verifyWebhook(MTN, hook(body, {}, query, 'PUT'), f.context);
  assert.deepEqual(events?.map((event) => [event.type, event.reference, event.providerReference, event.status]), [['collection', 'pay_ref_001', result.providerReference, 'pending']]);
  assert.equal(events?.[0].amountMinor, undefined, 'unsigned body amounts are never trusted');
  assert.equal(await mtn.verifyWebhook(MTN, hook(body, {}, { ...query, ref: 'pay_ref_999' }, 'PUT'), f.context), null, 'tampered reference');
  assert.equal(await mtn.verifyWebhook(MTN, hook(body, {}, { ...query, sig: 'A'.repeat(32) }, 'PUT'), f.context), null, 'invalid signature');
  assert.equal(await mtn.verifyWebhook(MTN, hook(body, {}, { ...query, kind: 'payout' }, 'PUT'), f.context), null, 'kind bound to the key');
  assert.equal(await mtn.verifyWebhook(MTN, hook(body, {}, {}, 'PUT'), f.context), null);

  const local = fake('mtn_momo', [
    { method: 'POST', url: 'https://sandbox.momodeveloper.mtn.com/collection/token/', reply: { json: { access_token: 't', expires_in: 3600 } } },
    { method: 'POST', url: 'https://sandbox.momodeveloper.mtn.com/collection/v1_0/requesttopay', reply: { status: 202 } },
  ], 'http://localhost:8787/api/payments/webhooks/mtn_momo');
  await mtn.collect(MTN, collectRequest({ amountMinor: 1250, currency: 'EUR', customer: { name: 'T', email: 't@example.test', phone: '+46733123450' } }), local.context);
  assert.equal(local.last().headers['x-callback-url'], undefined, 'no non-HTTPS callback sent to MTN');
});

test('mtn_momo: validateConfig (target environment, currency, credentials)', () => {
  const mtn = provider('mtn_momo');
  assert.deepEqual(mtn.validateConfig(MTN), []);
  assert.deepEqual(mtn.validateConfig(MTN_LIVE), []);
  assert.match(mtn.validateConfig(cfg('mtn_momo', 'sandbox', { target_environment: 'mtncameroon' }, {})).join(), /sandbox/);
  assert.match(mtn.validateConfig(cfg('mtn_momo', 'live', { target_environment: 'sandbox' }, {})).join(), /production/);
  assert.match(mtn.validateConfig(cfg('mtn_momo', 'live', { target_environment: 'mtncameroon', currency: 'XOF' }, {})).join(), /XAF/);
  assert.match(mtn.validateConfig(cfg('mtn_momo', 'sandbox', {}, { collection_api_user: 'not-a-uuid' })).join(), /UUID/);
  assert.deepEqual(mtn.validateConfig(cfg('mtn_momo', 'live', {}, { collection_api_user: 'user_12345' })), [], 'One API credentials are not UUIDs');
  assert.match(mtn.validateConfig(cfg('mtn_momo', 'live', {}, { disbursement_api_user: 'user_1' })).join(), /trois identifiants/);
});

// ---------------------------------------------------------------------------------------------
// Orange Money WebPay
// ---------------------------------------------------------------------------------------------

const ORANGE_SECRETS = { client_id: 'orange-client-id', client_secret: 'orange-client-secret', merchant_key: 'merchant-key-1234' };
const ORANGE = cfg('orange_money', 'sandbox', { country: 'ci', currency: 'XOF' }, ORANGE_SECRETS);
const ORANGE_LIVE = cfg('orange_money', 'live', { country: 'cm', currency: 'XAF', merchant_name: 'Alpha Cameroun' }, ORANGE_SECRETS);

test('orange_money: OAuth token, webpayment (dev/OUV in sandbox, whole units), reference encoding, status mapping', async () => {
  http.clearProviderTokenCache();
  const statuses: Record<string, string> = { 'tok-ok': 'SUCCESS', 'tok-ko': 'FAILED', 'tok-exp': 'EXPIRED', 'tok-wait': 'INITIATED' };
  const f = fake('orange_money', [
    { method: 'POST', url: 'https://api.orange.com/oauth/v3/token', reply: { json: { token_type: 'Bearer', access_token: 'orange-access-1', expires_in: '7776000' } } },
    { method: 'POST', url: /\/v1\/webpayment$/, reply: { status: 201, json: { status: 201, message: 'OK', pay_token: 'tok-ok', payment_url: 'https://mpayment.orange-money.com/pay/tok-ok', notif_token: 'notif-1' } } },
    { method: 'POST', url: /\/v1\/transactionstatus$/, reply: (call) => ({ status: 201, json: { status: statuses[call.json().pay_token], order_id: call.json().order_id, txnid: 'MP1' } }) },
  ]);
  const orange = provider('orange_money');
  const result = await orange.collect(ORANGE, collectRequest({ currency: 'XOF' }), f.context);
  assert.deepEqual([result.kind, result.providerReference], ['redirect', 'tok-ok|pay_ref_001|5000|XOF']);
  const [tokenCall, payCall] = f.calls;
  assert.equal(tokenCall.headers.authorization, `Basic ${Buffer.from('orange-client-id:orange-client-secret').toString('base64')}`);
  assert.equal(tokenCall.form().get('grant_type'), 'client_credentials');
  assert.equal(payCall.url, 'https://api.orange.com/orange-money-webpay/dev/v1/webpayment');
  assert.equal(payCall.headers.authorization, 'Bearer orange-access-1');
  const body = payCall.json();
  assert.deepEqual([body.merchant_key, body.currency, body.order_id, body.amount, body.lang], ['merchant-key-1234', 'OUV', 'pay_ref_001', 5000, 'fr']);
  assert.equal(new URL(body.notif_url).searchParams.get('ref'), 'pay_ref_001');

  await orange.collect(ORANGE_LIVE, collectRequest(), f.context);
  assert.equal(f.last().url, 'https://api.orange.com/orange-money-webpay/cm/v1/webpayment');
  assert.deepEqual([f.last().json().currency, f.last().json().amount, f.last().json().reference], ['XAF', 5000, 'Alpha Cameroun']);

  const ok = await orange.status(ORANGE, 'collection', 'tok-ok|pay_ref_001|5000|XOF', f.context);
  assert.deepEqual([ok.status, ok.amountMinor, ok.currency], ['succeeded', 5000, 'XOF']);
  assert.deepEqual(f.last().json(), { order_id: 'pay_ref_001', amount: 5000, pay_token: 'tok-ok' });
  assert.equal(f.last().url, 'https://api.orange.com/orange-money-webpay/dev/v1/transactionstatus');
  assert.equal((await orange.status(ORANGE, 'collection', 'tok-ko|pay_ref_001|5000|XOF', f.context)).status, 'failed');
  assert.equal((await orange.status(ORANGE, 'collection', 'tok-exp|pay_ref_001|5000|XOF', f.context)).status, 'cancelled');
  assert.equal((await orange.status(ORANGE, 'collection', 'tok-wait|pay_ref_001|5000|XOF', f.context)).status, 'pending');
  await providerError(orange.status(ORANGE, 'collection', 'garbage', f.context));
  assert.equal(f.calls.filter((call) => call.url.endsWith('/oauth/v3/token')).length, 1, 'token cached');
  assert.equal(orange.payout, undefined);
  assert.equal(orange.refund, undefined);
  assert.deepEqual(f.unmatched, []);
});

test('orange_money: notification bound to the reference by URL HMAC, reported as pending', async () => {
  http.clearProviderTokenCache();
  const f = fake('orange_money', [
    { method: 'POST', url: 'https://api.orange.com/oauth/v3/token', reply: { json: { access_token: 'a', expires_in: 3600 } } },
    { method: 'POST', url: /\/v1\/webpayment$/, reply: { status: 201, json: { pay_token: 'tok-ok', payment_url: 'https://pay.test/x', notif_token: 'n' } } },
  ]);
  const orange = provider('orange_money');
  await orange.collect(ORANGE, collectRequest({ currency: 'XOF' }), f.context);
  const query = queryOf(f.last().json().notif_url);
  const body = { status: 'SUCCESS', notif_token: 'n', txnid: 'MP1' };
  const events = await orange.verifyWebhook(ORANGE, hook(body, {}, query), f.context);
  assert.deepEqual(events?.map((event) => [event.type, event.reference, event.status]), [['collection', 'pay_ref_001', 'pending']]);
  assert.equal(await orange.verifyWebhook(ORANGE, hook(body, {}, { ...query, ref: 'pay_other' }), f.context), null);
  assert.equal(await orange.verifyWebhook(ORANGE, hook(body, {}, { ...query, sig: 'x'.repeat(32) }), f.context), null);
  assert.equal(await orange.verifyWebhook(cfg('orange_money', 'sandbox', ORANGE.settings, { ...ORANGE_SECRETS, merchant_key: 'rotated-key-999' }), hook(body, {}, query), f.context), null);
});

test('orange_money: validateConfig', () => {
  const orange = provider('orange_money');
  assert.deepEqual(orange.validateConfig(ORANGE), []);
  assert.deepEqual(orange.validateConfig(ORANGE_LIVE), []);
  assert.match(orange.validateConfig(cfg('orange_money', 'live', { country: 'cm', currency: 'XOF' }, {})).join(), /XAF/);
  assert.match(orange.validateConfig(cfg('orange_money', 'live', { merchant_name: 'x'.repeat(31) }, {})).join(), /30 caractères/);
});

// ---------------------------------------------------------------------------------------------
// Wave
// ---------------------------------------------------------------------------------------------

const WAVE = cfg('wave', 'live', { currency: 'XOF', country: 'SN' }, { api_key: 'wave_sn_prod_ABCdef123', webhook_secret: 'wave_sn_WHS_secret0123456789' });

function waveSignature(body: string, secret = 'wave_sn_WHS_secret0123456789', timestamp = NOW_S) {
  return `t=${timestamp},v1=${hmac(secret, `${timestamp}${body}`)}`;
}

test('wave: checkout session (amount string, XOF), optional request signing, status mapping', async () => {
  const sessions: Record<string, object> = {
    'cos-ok': { id: 'cos-ok', amount: '5000', currency: 'XOF', checkout_status: 'complete', payment_status: 'succeeded' },
    'cos-exp': { id: 'cos-exp', amount: '5000', currency: 'XOF', checkout_status: 'expired', payment_status: 'processing' },
    'cos-wait': { id: 'cos-wait', amount: '5000', currency: 'XOF', checkout_status: 'open', payment_status: 'processing' },
  };
  const f = fake('wave', [
    { method: 'POST', url: 'https://api.wave.com/v1/checkout/sessions', reply: { json: { id: 'cos-1', wave_launch_url: 'https://pay.wave.com/c/cos-1', checkout_status: 'open' } } },
    { method: 'GET', url: /\/v1\/checkout\/sessions\/cos-/, reply: (call) => ({ json: sessions[call.url.split('/').pop()!] }) },
  ]);
  const wave = provider('wave');
  const result = await wave.collect(WAVE, collectRequest({ currency: 'XOF' }), f.context);
  assert.deepEqual([result.kind, result.providerReference], ['redirect', 'cos-1']);
  const call = f.last();
  assert.equal(call.headers.authorization, 'Bearer wave_sn_prod_ABCdef123');
  assert.equal(call.headers['idempotency-key'], 'alpha-collect-pay_ref_001');
  assert.equal(call.headers['wave-signature'], undefined);
  assert.deepEqual(call.json(), { amount: '5000', currency: 'XOF', success_url: 'https://alpha.test/pay/return', error_url: 'https://alpha.test/pay/cancel', client_reference: 'pay_ref_001' });

  const signed = cfg('wave', 'live', WAVE.settings, { ...WAVE.secrets, signing_secret: 'wave_sn_AKS_signing123' });
  await wave.collect(signed, collectRequest({ currency: 'XOF' }), f.context);
  const signedCall = f.last();
  assert.equal(signedCall.headers['wave-signature'], `t=${NOW_S},v1=${hmac('wave_sn_AKS_signing123', `${NOW_S}${signedCall.body}`)}`);

  const ok = await wave.status(WAVE, 'collection', 'cos-ok', f.context);
  assert.deepEqual([ok.status, ok.amountMinor, ok.currency], ['succeeded', 5000, 'XOF']);
  assert.equal((await wave.status(WAVE, 'collection', 'cos-exp', f.context)).status, 'cancelled');
  assert.equal((await wave.status(WAVE, 'collection', 'cos-wait', f.context)).status, 'pending');
  await providerError(wave.collect(WAVE, collectRequest({ currency: 'EUR', amountMinor: 1250 }), f.context));
  assert.deepEqual(f.unmatched, []);
});

test('wave: payouts (idempotency-key, E.164 mobile) and full refunds only', async () => {
  const f = fake('wave', [
    { method: 'POST', url: 'https://api.wave.com/v1/payout', reply: { json: { id: 'pt-1', currency: 'XOF', receive_amount: '10000', status: 'processing', client_reference: 'po_1' } } },
    { method: 'GET', url: 'https://api.wave.com/v1/payout/pt-1', reply: { json: { id: 'pt-1', currency: 'XOF', receive_amount: '10000', status: 'reversed' } } },
    { method: 'GET', url: 'https://api.wave.com/v1/checkout/sessions/cos-ok', reply: { json: { id: 'cos-ok', amount: '5000', currency: 'XOF', checkout_status: 'complete', payment_status: 'succeeded' } } },
    { method: 'POST', url: 'https://api.wave.com/v1/checkout/sessions/cos-ok/refund', reply: { status: 200 } },
  ]);
  const wave = provider('wave');
  const payout = await wave.payout!(WAVE, { reference: 'po_1', amountMinor: 10000, currency: 'XOF', description: 'Versement mission', recipient: { name: 'Moussa', phone: '77 123 45 67' } }, f.context);
  assert.deepEqual([payout.status, payout.providerReference], ['pending', 'pt-1']);
  assert.equal(f.last().headers['idempotency-key'], 'alpha-payout-po_1');
  assert.deepEqual(f.last().json(), { currency: 'XOF', receive_amount: '10000', name: 'Moussa', mobile: '+221771234567', client_reference: 'po_1', payment_reason: 'Versement mission' });
  const reversed = await wave.status(WAVE, 'payout', 'pt-1', f.context);
  assert.deepEqual([reversed.status, reversed.amountMinor], ['failed', 10000]);

  const refund = await wave.refund!(WAVE, { reference: 'rf_1', providerReference: 'cos-ok', amountMinor: 5000, currency: 'XOF', reason: 'Annulation' }, f.context);
  assert.deepEqual([refund.status, refund.providerReference], ['succeeded', 'cos-ok']);
  assert.equal(f.last().url, 'https://api.wave.com/v1/checkout/sessions/cos-ok/refund');
  const partial = await providerError(wave.refund!(WAVE, { reference: 'rf_2', providerReference: 'cos-ok', amountMinor: 2000, currency: 'XOF', reason: 'Partiel' }, f.context));
  assert.match(partial.message, /intégral/);
  assert.deepEqual(f.unmatched, []);
});

test('wave: Wave-Signature webhook (t + body, no dot), shared secret strategy, invalid/tampered/expired', async () => {
  const wave = provider('wave');
  const f = fake('wave', []);
  const body = JSON.stringify({ id: 'AE_ijzo7oGgrlM6', type: 'checkout.session.completed', data: { id: 'cos-ok', amount: '5000', currency: 'XOF', checkout_status: 'complete', payment_status: 'succeeded', client_reference: 'pay_ref_001' } });
  const events = await wave.verifyWebhook(WAVE, hook(body, { 'Wave-Signature': waveSignature(body) }), f.context);
  assert.deepEqual(events?.map((event) => [event.type, event.reference, event.providerReference, event.status, event.amountMinor, event.eventId]), [['collection', 'pay_ref_001', 'cos-ok', 'succeeded', 5000, 'AE_ijzo7oGgrlM6']]);
  const stripeStyle = `t=${NOW_S},v1=${hmac('wave_sn_WHS_secret0123456789', `${NOW_S}.${body}`)}`;
  assert.equal(await wave.verifyWebhook(WAVE, hook(body, { 'wave-signature': stripeStyle }), f.context), null);
  assert.equal(await wave.verifyWebhook(WAVE, hook(body, { 'wave-signature': waveSignature(body, 'wrong-secret') }), f.context), null);
  assert.equal(await wave.verifyWebhook(WAVE, hook(body.replace('5000', '50000'), { 'wave-signature': waveSignature(body) }), f.context), null);
  assert.equal(await wave.verifyWebhook(WAVE, hook(body, { 'wave-signature': waveSignature(body, undefined, NOW_S - 301) }), f.context), null);
  const failed = JSON.stringify({ id: 'AE_2', type: 'checkout.session.payment_failed', data: { id: 'cos-ko', amount: '5000', currency: 'XOF', client_reference: 'pay_ref_002', payment_status: 'processing' } });
  assert.equal((await wave.verifyWebhook(WAVE, hook(failed, { 'wave-signature': waveSignature(failed) }), f.context))?.[0].status, 'failed');

  const shared = cfg('wave', 'live', { ...WAVE.settings, webhook_auth: 'shared_secret' }, WAVE.secrets);
  assert.equal((await wave.verifyWebhook(shared, hook(body, { authorization: 'Bearer wave_sn_WHS_secret0123456789' }), f.context))?.length, 1);
  assert.equal(await wave.verifyWebhook(shared, hook(body, { authorization: 'Bearer nope' }), f.context), null);
  assert.equal(await wave.verifyWebhook(shared, hook(body, { 'wave-signature': waveSignature(body) }), f.context), null);
});

test('wave: validateConfig', () => {
  const wave = provider('wave');
  assert.deepEqual(wave.validateConfig(WAVE), []);
  assert.match(wave.validateConfig(cfg('wave', 'sandbox', {}, { api_key: 'wave_sn_prod_abc' })).join(), /production/);
  assert.match(wave.validateConfig(cfg('wave', 'live', {}, { api_key: 'sk_live_abc' })).join(), /wave_/);
  assert.match(wave.validateConfig(cfg('wave', 'live', { aggregated_merchant_id: 'xyz' }, {})).join(), /am-/);
  assert.match(wave.validateConfig(cfg('wave', 'live', { currency: 'XAF' }, {})).join(), /XAF/);
});

// ---------------------------------------------------------------------------------------------
// Kratos Pay
// ---------------------------------------------------------------------------------------------

const KRATOS = cfg('kratos_pay', 'live', { currency: 'XAF' }, { public_key: 'pk_live_kratos123', webhook_secret: 'kratos-webhook-secret-123' });
const KRATOS_BASE = 'https://dev-aggregator-api.kratospay.com';

test('kratos_pay: payin request shape (X-MoK-Public-Key, idempotency, XAF integer, operator inference), payout, status', async () => {
  const f = fake('kratos_pay', [
    { method: 'POST', url: `${KRATOS_BASE}/api/v1/live/payin`, reply: (call) => ({ json: { status: 'PENDING', reference: call.json().reference, amount: call.json().amount, currency: 'XAF', transaction_id: 'TX-1' } }) },
    { method: 'POST', url: `${KRATOS_BASE}/api/v1/sandbox/payin`, reply: { json: { status: 'PENDING', reference: 'pay_ref_001' } } },
    { method: 'POST', url: `${KRATOS_BASE}/api/v1/live/payout`, reply: { json: { status: 'SUCCESS', reference: 'po_1', amount: 3000, currency: 'XAF' } } },
    { method: 'GET', url: `${KRATOS_BASE}/api/v1/live/transactions/pay_ref_001`, reply: { json: { status: 'SUCCESS', reference: 'pay_ref_001', amount: 5000, currency: 'XAF' } } },
    { method: 'GET', url: `${KRATOS_BASE}/api/v1/live/transactions/pay_ko`, reply: { json: { data: { status: 'FAILED', reference: 'pay_ko', amount: 5000, currency: 'XAF', gatewayMessage: 'Solde insuffisant' } } } },
    { method: 'GET', url: `${KRATOS_BASE}/api/v1/live/transactions/pay_unknown`, reply: { status: 404, json: { message: 'not found' } } },
    { method: 'GET', url: `${KRATOS_BASE}/custom/payin/pay_ref_001/status`, reply: { json: { status: 'PENDING', reference: 'pay_ref_001' } } },
  ]);
  const kratos = provider('kratos_pay');
  const result = await kratos.collect(KRATOS, collectRequest({ customer: { name: 'Awa', email: 'awa@example.test', phone: '690000000' } }), f.context);
  assert.deepEqual([result.kind, result.providerReference], ['pending_approval', 'pay_ref_001']);
  const call = f.last();
  assert.equal(call.headers['x-mok-public-key'], 'pk_live_kratos123');
  assert.equal(call.headers['idempotency-key'], 'alpha-payin-pay_ref_001');
  assert.deepEqual(call.json(), { amount: 5000, currency: 'XAF', phoneNumber: '237690000000', operator: 'orange_money_cm', reference: 'pay_ref_001', description: 'Mission Alpha' });
  await kratos.collect(KRATOS, collectRequest({ reference: 'pay_ref_003', customer: { name: 'A', email: 'a@example.test', phone: '+237655000000' }, operator: 'mtn' }), f.context);
  assert.equal(f.last().json().operator, 'mtn_momo_cm', 'explicit operator wins over number prefix');
  await kratos.collect(KRATOS, collectRequest({ reference: 'pay_ref_004', customer: { name: 'A', email: 'a@example.test', phone: '677123456' } }), f.context);
  assert.equal(f.last().json().operator, 'mtn_momo_cm');
  await kratos.collect(cfg('kratos_pay', 'sandbox', KRATOS.settings, KRATOS.secrets), collectRequest(), f.context);
  assert.equal(f.last().url, `${KRATOS_BASE}/api/v1/sandbox/payin`, 'sandbox never hits the live path by default');

  const payout = await kratos.payout!(KRATOS, { reference: 'po_1', amountMinor: 3000, currency: 'XAF', description: 'Versement', recipient: { name: 'Awa', phone: '690000000' } }, f.context);
  assert.deepEqual([payout.status, payout.providerReference], ['succeeded', 'po_1']);
  assert.equal(f.last().headers['idempotency-key'], 'alpha-payout-po_1');
  assert.equal(f.last().json().phoneNumber, '237690000000');

  const ok = await kratos.status(KRATOS, 'collection', 'pay_ref_001', f.context);
  assert.deepEqual([ok.status, ok.amountMinor, ok.currency], ['succeeded', 5000, 'XAF']);
  const ko = await kratos.status(KRATOS, 'collection', 'pay_ko', f.context);
  assert.equal(ko.status, 'failed');
  assert.match(ko.failureReason ?? '', /Solde insuffisant/);
  assert.equal((await kratos.status(KRATOS, 'collection', 'pay_unknown', f.context)).status, 'pending');
  const custom = cfg('kratos_pay', 'live', { ...KRATOS.settings, status_path: '/custom/{kind}/{reference}/status' }, KRATOS.secrets);
  assert.equal((await kratos.status(custom, 'collection', 'pay_ref_001', f.context)).status, 'pending');
  assert.equal(kratos.refund, undefined);
  assert.deepEqual(f.unmatched, []);
});

test('kratos_pay: FAILED payin is a non-retryable error without personal data', async () => {
  const f = fake('kratos_pay', [
    { method: 'POST', url: `${KRATOS_BASE}/api/v1/live/payin`, reply: { json: { status: 'FAILED', reference: 'pay_ref_001', gatewayMessage: 'Numéro 237690000000 inconnu' } } },
  ]);
  const error = await providerError(provider('kratos_pay').collect(KRATOS, collectRequest({ customer: { name: 'A', email: 'a@example.test', phone: '690000000' } }), f.context));
  assert.equal(error.retryable, false);
  assertNoLeak(error.message, ['690000000']);
  await providerError(provider('kratos_pay').collect(KRATOS, collectRequest({ customer: { name: 'A', email: 'a@example.test', phone: '620000000' } }), f.context));
});

test('kratos_pay: HMAC webhook (hex, base64, sha256= prefix, custom header, invalid, tampered, expired t=)', async () => {
  const kratos = provider('kratos_pay');
  const f = fake('kratos_pay', []);
  const secret = 'kratos-webhook-secret-123';
  const body = JSON.stringify({ event: 'payin.updated', data: { transaction_id: 'TX-1', reference: 'pay_ref_001', status: 'SUCCESS', amount: 5000, currency: 'XAF' } });
  const events = await kratos.verifyWebhook(KRATOS, hook(body, { 'X-MoK-Signature': hmac(secret, body) }), f.context);
  assert.deepEqual(events?.map((event) => [event.type, event.reference, event.status, event.amountMinor, event.currency]), [['collection', 'pay_ref_001', 'succeeded', 5000, 'XAF']]);
  assert.equal((await kratos.verifyWebhook(KRATOS, hook(body, { 'x-mok-signature': hmac(secret, body, 'base64') }), f.context))?.length, 1);
  assert.equal((await kratos.verifyWebhook(KRATOS, hook(body, { 'x-mok-signature': `sha256=${hmac(secret, body)}` }), f.context))?.length, 1);
  assert.equal(await kratos.verifyWebhook(KRATOS, hook(body, { 'x-mok-signature': hmac('wrong', body) }), f.context), null);
  assert.equal(await kratos.verifyWebhook(KRATOS, hook(body.replace('SUCCESS', 'FAILED'), { 'x-mok-signature': hmac(secret, body) }), f.context), null);
  assert.equal(await kratos.verifyWebhook(KRATOS, hook(body, {}), f.context), null);
  const timestamped = (t: number) => `t=${t},v1=${hmac(secret, `${t}.${body}`)}`;
  assert.equal((await kratos.verifyWebhook(KRATOS, hook(body, { 'x-mok-signature': timestamped(NOW_S) }), f.context))?.length, 1);
  assert.equal(await kratos.verifyWebhook(KRATOS, hook(body, { 'x-mok-signature': timestamped(NOW_S - 3600) }), f.context), null, 'expired');
  const custom = cfg('kratos_pay', 'live', { ...KRATOS.settings, webhook_signature_header: 'X-Kratos-Signature' }, KRATOS.secrets);
  assert.equal((await kratos.verifyWebhook(custom, hook(body, { 'x-kratos-signature': hmac(secret, body) }), f.context))?.length, 1);
  const payout = JSON.stringify({ event: 'payout.updated', data: { reference: 'po_1', status: 'FAILED', amount: 3000, currency: 'XAF' } });
  assert.deepEqual((await kratos.verifyWebhook(KRATOS, hook(payout, { 'x-mok-signature': hmac(secret, payout) }), f.context))?.map((event) => [event.type, event.status]), [['payout', 'failed']]);
});

test('kratos_pay: validateConfig', () => {
  const kratos = provider('kratos_pay');
  assert.deepEqual(kratos.validateConfig(KRATOS), []);
  assert.match(kratos.validateConfig(cfg('kratos_pay', 'live', { api_path: '/api/v1/sandbox' }, {})).join(), /bac à sable/);
  assert.match(kratos.validateConfig(cfg('kratos_pay', 'live', { status_path: '/api/v1/live/tx' }, {})).join(), /\{reference\}/);
  assert.match(kratos.validateConfig(cfg('kratos_pay', 'live', { webhook_signature_header: 'bad header' }, {})).join(), /en-tête/);
  assert.match(kratos.validateConfig(cfg('kratos_pay', 'live', {}, { webhook_secret: 'short' })).join(), /trop court/);
});

// ---------------------------------------------------------------------------------------------
// Cross-adapter guarantees: 503 is retryable, 4xx messages never leak secrets or phone numbers
// ---------------------------------------------------------------------------------------------

const ALL: Array<{ id: string; config: ProviderConfig; request: CollectRequest; tokenRoutes: Route[] }> = [
  { id: 'stripe', config: STRIPE, request: collectRequest({ amountMinor: 1250, currency: 'EUR' }), tokenRoutes: [] },
  { id: 'flutterwave', config: FLW, request: collectRequest(), tokenRoutes: [] },
  { id: 'campay', config: CAMPAY, request: collectRequest(), tokenRoutes: [{ url: 'https://demo.campay.net/api/token/', reply: { json: { token: 'campay-session-token', expires_in: 3600 } } }] },
  { id: 'mtn_momo', config: MTN_LIVE, request: collectRequest(), tokenRoutes: [{ url: 'https://momoapi.momo.africa/collection/token/', reply: { json: { access_token: 'mtn-session-token', expires_in: 3600 } } }] },
  { id: 'orange_money', config: ORANGE, request: collectRequest({ currency: 'XOF' }), tokenRoutes: [{ url: 'https://api.orange.com/oauth/v3/token', reply: { json: { access_token: 'orange-session-token', expires_in: 3600 } } }] },
  { id: 'wave', config: WAVE, request: collectRequest({ currency: 'XOF', customer: { name: 'A', email: 'a@example.test', phone: '+221771234567' } }), tokenRoutes: [] },
  { id: 'kratos_pay', config: KRATOS, request: collectRequest(), tokenRoutes: [] },
];

test('every adapter: 503 / network failure on collect is a retryable ProviderError', async () => {
  for (const item of ALL) {
    for (const reply of [{ status: 503, json: { message: 'Service Unavailable' } }, { throws: new TypeError('fetch failed') }] as Reply[]) {
      http.clearProviderTokenCache();
      const f = fake(item.id, [...item.tokenRoutes, { url: /.*/, reply }]);
      const error = await providerError(provider(item.id).collect(item.config, item.request, f.context));
      assert.equal(error.retryable, true, `${item.id}: retryable`);
      assert.equal(error.provider, item.id);
    }
  }
});

test('every adapter: provider 4xx/401 messages never contain secrets, tokens or phone numbers', async () => {
  for (const item of ALL) {
    http.clearProviderTokenCache();
    const secrets = Object.values(item.config.secrets);
    const sessionTokens = item.tokenRoutes.map((route) => String((route.reply as { json: { token?: string; access_token?: string } }).json.token ?? (route.reply as { json: { access_token?: string } }).json.access_token));
    const echo = `Rejected ${secrets.join(' ')} for 237677123456 / +221771234567 with ${sessionTokens.join(' ')}`;
    const f = fake(item.id, [...item.tokenRoutes, { url: /.*/, reply: { status: 400, json: { message: echo, error: { message: echo } } } }]);
    const error = await providerError(provider(item.id).collect(item.config, item.request, f.context));
    assert.equal(error.retryable, false, `${item.id}: 400 not retryable`);
    assertNoLeak(error.message, [...secrets, ...sessionTokens, '677123456', '771234567']);

    http.clearProviderTokenCache();
    const g = fake(item.id, [...item.tokenRoutes, { url: /.*/, reply: { status: 401, json: { message: echo } } }]);
    const auth = await providerError(provider(item.id).collect(item.config, item.request, g.context));
    assert.equal(auth.retryable, false);
    assertNoLeak(auth.message, [...secrets, ...sessionTokens, '677123456']);
  }
});
