import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import type { PaymentProvider, ProviderId, ProviderStatus } from '../server/payments/providers/types.js';

process.env.DATABASE_PATH = ':memory:';
for (const name of ['APP_ORIGIN', 'PUBLIC_API_ORIGIN', 'ALPHA_SECRETS_KEY']) delete process.env[name];
const { app } = await import('../server/app.js');
const { all, db, one, run, transaction } = await import('../server/db.js');
const { balance, ledgerAccounts, ledgerIsBalanced } = await import('../server/payments/ledger.js');
const { readProviderConfig, setProviderFetchForTests } = await import('../server/payments/config.js');
const { registerProvider } = await import('../server/payments/providers/index.js');
const { settleSimulatedPayment, signSimulatorPayload } = await import('../server/payments/providers/simulator.js');
const { refundOrderEscrow, settleSucceededIntent } = await import('../server/payments/escrow.js');
const { runJob } = await import('../server/platform/jobs.js');
const { personalDataHandlers } = await import('../server/platform/privacy.js');

interface Actor { id: string; name: string; email: string; password: string; cookie: string }
interface Resource { id: string }
interface Intent extends Resource {
  status: string; mode: string; provider: string; purpose: string; ref_id: string; order_id: string | null; amount_minor: number;
  amount_base_minor: number; currency: string; redirect_url: string | null; instructions: string; customer_phone_masked: string;
  provider_reference: string | null; review_required: boolean; settlement: string; final: boolean;
}
interface IntentResponse { intent: Intent; redirect_url: string | null; instructions: string; reused: boolean }
interface Budget { funded_cents: number; paid_cents: number; reserved_cents: number; available_cents: number; escrow_cents?: number; refunded_cents?: number; mode?: string }
interface Order extends Resource { status: string; version: number; payment_mode: string; price_cents: number }
interface Refund extends Resource { status: string; attempts: number; last_error: string; provider_reference: string | null; amount_minor: number }

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function waitFor<T>(read: () => T | undefined | false, message: string): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = read();
    if (value) return value;
    await tick();
  }
  throw new Error(`Timed out: ${message}`);
}

/* ------------------------- Fake HTTP payment provider exercised through a fake fetch ------------------------- */
const psp = new Map<string, { status: ProviderStatus; amount: number; currency: string }>();
const pspCalls: string[] = [];
let pspDown = false;
setProviderFetchForTests(async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  assert.equal(url.origin, 'https://psp.example.test', 'no real network call may leave the tests');
  const method = init?.method ?? 'GET';
  pspCalls.push(`${method} ${url.pathname}`);
  if (pspDown) return new Response(JSON.stringify({ error: 'maintenance' }), { status: 503 });
  assert.match(String(new Headers(init?.headers).get('authorization')), /^Bearer tp_/);
  const body = init?.body ? JSON.parse(String(init.body)) as Record<string, string | number> : {};
  if (method === 'POST' && url.pathname === '/charges') {
    const reference = `fk_${body.reference}`;
    if (!psp.has(reference)) psp.set(reference, { status: 'pending', amount: Number(body.amount), currency: String(body.currency) });
    return Response.json({ id: reference, checkout_url: `https://psp.example.test/pay/${reference}` });
  }
  if (method === 'POST' && url.pathname === '/refunds') {
    const reference = `fkre_${body.reference}`;
    psp.set(reference, { status: 'succeeded', amount: Number(body.amount), currency: String(body.currency) });
    return Response.json({ id: reference, status: 'succeeded' });
  }
  const found = /^\/(charges|refunds)\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
  const record = found ? psp.get(found[2]) : undefined;
  if (method === 'GET' && found && record) return Response.json({ id: found[2], status: record.status, amount: record.amount, currency: record.currency });
  return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
});
const testpaySignature = (secret: string, body: string) => createHmac('sha256', secret).update(body).digest('hex');
const testpay: PaymentProvider = {
  id: 'testpay' as ProviderId,
  label: 'TestPay',
  countries: ['*'],
  currencies: ['EUR', 'XAF'],
  methods: ['card', 'mobile_money'],
  capabilities: { collect: true, payout: false, refund: true, webhooks: 'signed' },
  fields: [
    { key: 'api_key', label: 'Clé API', secret: true, required: true },
    { key: 'operator', label: 'Opérateur', secret: false, required: false, options: ['mtn', 'orange'] },
  ],
  docsUrl: 'https://psp.example.test/docs',
  validateConfig: (config) => (config.secrets.api_key ? [] : ['Clé API manquante.']),
  async collect(config, request, context) {
    const response = await context.fetch('https://psp.example.test/charges', {
      method: 'POST',
      headers: { authorization: `Bearer ${config.secrets.api_key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ reference: request.reference, amount: request.amountMinor, currency: request.currency }),
    });
    if (!response.ok) throw new Error(`TestPay HTTP ${response.status}`);
    const data = await response.json() as { id: string; checkout_url: string };
    return { kind: 'redirect', providerReference: data.id, url: data.checkout_url };
  },
  async status(config, kind, providerReference, context) {
    const response = await context.fetch(`https://psp.example.test/${kind === 'refund' ? 'refunds' : 'charges'}/${providerReference}`, {
      headers: { authorization: `Bearer ${config.secrets.api_key}` },
    });
    if (!response.ok) throw new Error(`TestPay HTTP ${response.status}`);
    const data = await response.json() as { status: ProviderStatus; amount: number; currency: string };
    return { status: data.status, providerReference, amountMinor: data.amount, currency: data.currency };
  },
  async refund(config, request, context) {
    const response = await context.fetch('https://psp.example.test/refunds', {
      method: 'POST',
      headers: { authorization: `Bearer ${config.secrets.api_key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ reference: request.reference, charge: request.providerReference, amount: request.amountMinor, currency: request.currency }),
    });
    if (!response.ok) throw new Error(`TestPay HTTP ${response.status}`);
    const data = await response.json() as { id: string; status: ProviderStatus };
    return { status: data.status, providerReference: data.id };
  },
  async verifyWebhook(config, input) {
    const signature = input.headers['x-testpay-signature'];
    if (typeof signature !== 'string' || signature !== testpaySignature(config.secrets.api_key, input.rawBody.toString('utf8'))) return null;
    const payload = JSON.parse(input.rawBody.toString('utf8')) as { id: string; status: ProviderStatus; amount?: number; currency?: string; event_id?: string };
    return [{ type: 'collection', providerReference: payload.id, status: payload.status, amountMinor: payload.amount, currency: payload.currency, eventId: payload.event_id }];
  },
};
registerProvider(testpay);

test('V4 payments core: intents, webhooks, escrow and admin console (sandbox simulator + fake HTTP provider)', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  t.after(async () => {
    setProviderFetchForTests(null);
    for (const name of ['APP_ORIGIN', 'ALPHA_SECRETS_KEY']) delete process.env[name];
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    db.close();
  });
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const base = `${origin}/api`;

  async function api<T>(actor: Actor | null, path: string, expected = 200, method = 'GET', body?: unknown): Promise<T> {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        'X-Alpha-Client': 'web',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(actor?.cookie ? { Cookie: actor.cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    assert.equal(response.status, expected, `${method} ${path}: ${text}`);
    const data = JSON.parse(text) as T;
    if (expected >= 400) assert.equal(typeof (data as { error?: unknown }).error, 'string', 'errors must be actionable JSON');
    const cookie = response.headers.get('set-cookie');
    if (actor && cookie) actor.cookie = cookie.split(';', 1)[0];
    return data;
  }
  async function webhook(provider: string, body: string, headers: Record<string, string>, method = 'POST', query = '') {
    const response = await fetch(`${base}/payments/webhooks/${provider}${query}`, {
      method, headers, ...(method === 'GET' ? {} : { body }),
    });
    return { status: response.status, data: await response.json() as { received?: boolean; events?: number; duplicates?: number; error?: string } };
  }
  const simulatorConfig = () => readProviderConfig('simulator', 'sandbox')!;
  function simulatorWebhook(intent: Intent, status: ProviderStatus, eventId: string) {
    const body = JSON.stringify({ reference: intent.id, provider_reference: intent.provider_reference, status, type: 'collection', event_id: eventId });
    return webhook('simulator', body, { 'content-type': 'application/json', 'x-alpha-simulator-signature': signSimulatorPayload(simulatorConfig(), body) });
  }
  function testpayWebhook(intent: Intent, status: ProviderStatus, eventId: string, amount?: number, secret = 'tp_sandbox_secret_1234') {
    const body = JSON.stringify({ id: intent.provider_reference, status, amount, currency: intent.currency, event_id: eventId });
    return webhook('testpay', body, { 'content-type': 'application/json', 'x-testpay-signature': testpaySignature(secret, body) });
  }
  const journals = (kind: string, refId?: string) => one<{ total: number }>(
    'SELECT COUNT(*) AS total FROM ledger_journals WHERE kind=? AND (? IS NULL OR ref_id=?)', kind, refId ?? null, refId ?? null)!.total;
  const available = (userId: string) => balance(ledgerAccounts.userAvailable(userId), 'sandbox', 'EUR');
  const platformFees = () => balance(ledgerAccounts.platformFees(), 'sandbox', 'EUR');

  function actor(name: string): Actor {
    return { id: '', name, email: `${name.toLowerCase()}@payments.test`, password: 'Alpha-payments-password-2026!', cookie: '' };
  }
  const owner = actor('Owner');
  const tester = actor('Tester');
  const outsider = actor('Outsider');
  const admin = actor('Admin');
  for (const account of [owner, tester, outsider, admin]) {
    account.id = (await api<{ user: Resource }>(account, '/auth/register', 201, 'POST', { name: account.name, email: account.email, password: account.password })).user.id;
  }
  run("UPDATE users SET role='admin' WHERE id=?", admin.id);

  const project = (await api<{ project: Resource }>(owner, '/projects', 201, 'POST', {
    title: 'Payments prototype', summary: 'A public project used by the payments integration tests.', category: 'developer-tools', visibility: 'public',
  })).project;
  const createCampaign = async (title: string, reward: number, slots: number) => (await api<{ campaign: Resource & { payment_mode: string } }>(owner, '/testing/campaigns', 201, 'POST', {
    project_id: project.id, title, description: 'Validate the onboarding flow with a desktop browser and keyboard navigation.',
    reward_cents: reward, slots, deadline: new Date(Date.now() + 7 * 86400000).toISOString(),
  })).campaign;
  const createListing = async (title: string, price: number) => (await api<{ listing: Resource }>(owner, '/marketplace/listings', 201, 'POST', {
    title, description: 'A reusable component with accessible keyboard interactions and documentation.', kind: 'component', price_cents: price,
    license: 'Non-exclusive license for one commercial project.', deliverables: 'Source code archive and complete installation documentation.',
    project_id: project.id,
  })).listing;
  const motivation = { motivation: 'I can test the complete desktop flow and provide reproducible accessibility feedback.' };
  const report = {
    summary: 'The onboarding flow is usable with one keyboard navigation issue.',
    steps: 'Open the dashboard, use Tab to reach the new project button, then press Enter.',
    expected: 'The project creation form receives keyboard focus.',
    observed: 'Focus remains on the dashboard instead of moving to the form.',
    evidence_url: 'https://example.test/evidence',
  };
  async function completeMission(campaignId: string) {
    const application = (await api<{ application: Resource }>(tester, `/testing/campaigns/${campaignId}/applications`, 201, 'POST', motivation)).application;
    const mission = (await api<{ mission: Resource; balance: Budget }>(owner, `/testing/applications/${application.id}/accept`, 201, 'POST', {}));
    await api(tester, `/testing/missions/${mission.mission.id}/start`, 200, 'POST', {});
    await api(tester, `/testing/missions/${mission.mission.id}/report`, 200, 'POST', report);
    return mission;
  }

  let demoCampaignId = '';
  let campaignId = '';
  let campaign2Id = '';
  let fundingIntent: Intent;

  await t.test('demo mode (default) keeps the V3 behaviour and refuses every real-money entry point', async () => {
    assert.equal((await api<{ payment_mode: string }>(null, '/health')).payment_mode, 'demo');
    const demoCampaign = await createCampaign('Demo campaign', 1000, 1);
    demoCampaignId = demoCampaign.id;
    assert.equal(demoCampaign.payment_mode, 'demo');
    const funded = await api<{ balance: Budget; mode: string }>(owner, `/payments/campaigns/${demoCampaignId}/fund`, 200, 'POST', { amount_cents: 1000 });
    assert.equal(funded.mode, 'demo');
    assert.deepEqual(funded.balance, { funded_cents: 1000, paid_cents: 0, reserved_cents: 0, available_cents: 1000 });
    const listing = await createListing('Demo component', 1500);
    const purchase = await api<{ order: Order; mode: string }>(tester, `/marketplace/listings/${listing.id}/buy`, 201, 'POST', {});
    assert.equal(purchase.mode, 'demo');
    assert.equal(purchase.order.payment_mode, 'demo');
    await api(owner, '/payments/intents', 409, 'POST', { purpose: 'campaign_funding', ref_id: demoCampaignId, provider: 'simulator' });
    assert.deepEqual((await api<{ providers: unknown[]; mode: string }>(owner, '/payments/providers/available')).providers, []);
    const hook = await webhook('simulator', '{}', { 'content-type': 'application/json' });
    assert.equal(hook.status, 404);
    assert.equal((await webhook('unknown-psp', '{}', {})).status, 404);
    assert.equal(one<{ total: number }>('SELECT COUNT(*) AS total FROM ledger_entries')!.total, 0);
    assert.equal(ledgerIsBalanced(), true);
  });

  await t.test('only administrators reach the payments console; admin enables the sandbox', async () => {
    await api(null, '/payments/admin/overview', 401);
    await api(owner, '/payments/admin/overview', 403);
    await api(owner, '/payments/admin/mode', 403, 'PUT', { mode: 'sandbox' });
    await api(owner, '/payments/admin/adjustments', 403, 'POST', { mode: 'sandbox', memo: 'Tentative', legs: [] });
    const switched = await api<{ mode: string; previous: string; warnings: string[] }>(admin, '/payments/admin/mode', 200, 'PUT', { mode: 'sandbox' });
    assert.deepEqual(switched, { mode: 'sandbox', previous: 'demo', warnings: [] });
    assert.equal((await api<{ payment_mode: string }>(null, '/health')).payment_mode, 'sandbox');
    assert.ok(one("SELECT id FROM audit_events WHERE action='payments.mode.changed' AND actor_id=?", admin.id));

    await api(admin, '/payments/admin/providers/testpay/sandbox', 400, 'PUT', { enabled: true, settings: {}, secrets: {} });
    await api(admin, '/payments/admin/providers/testpay/sandbox', 400, 'PUT', { enabled: true, settings: { api_key: 'x' }, secrets: {} });
    const saved = await api<{ provider: { enabled: boolean; secrets: Record<string, { configured: boolean; mask: string }> } }>(admin,
      '/payments/admin/providers/testpay/sandbox', 200, 'PUT', { enabled: true, settings: {}, secrets: { api_key: 'tp_sandbox_secret_1234' } });
    assert.equal(saved.provider.enabled, true);
    assert.equal(saved.provider.secrets.api_key.configured, true);
    assert.ok(!JSON.stringify(saved).includes('tp_sandbox_secret_1234'), 'secrets never leave the server');
    const providers = await api<{ providers: { id: string; webhook_url: string; fields: unknown[]; environments: { sandbox: { enabled: boolean }; live: { available: boolean } } }[] }>(admin, '/payments/admin/providers');
    const simulator = providers.providers.find((provider) => provider.id === 'simulator')!;
    assert.equal(simulator.environments.sandbox.enabled, true);
    assert.equal(simulator.environments.live.available, false);
    assert.match(providers.providers.find((provider) => provider.id === 'testpay')!.webhook_url, /\/api\/payments\/webhooks\/testpay$/);
    assert.ok(!JSON.stringify(providers).includes('tp_sandbox_secret_1234'));
    const checkout = await api<{ mode: string; providers: { id: string; methods: { id: string }[]; currencies: string[] }[] }>(owner, '/payments/providers/available?purpose=campaign_funding');
    assert.equal(checkout.mode, 'sandbox');
    assert.deepEqual(checkout.providers.map((provider) => provider.id).sort(), ['simulator', 'testpay']);
    assert.deepEqual(checkout.providers.find((provider) => provider.id === 'simulator')!.currencies, ['EUR', 'XAF', 'XOF'], 'only currencies with an FX rate are offered');
    await api(null, '/payments/providers/available', 401);

    const settings = await api<{ fees: { testing_fee_bps: number } }>(admin, '/payments/admin/settings', 200, 'PUT', { fees: { testing_fee_bps: 500, marketplace_fee_bps: 1500 } });
    assert.equal(settings.fees.testing_fee_bps, 500);
    await api(owner, '/payments/admin/settings', 403, 'PUT', { fees: { testing_fee_bps: 0, marketplace_fee_bps: 0 } });
  });

  await t.test('campaign funding: authorization, simulator checkout, signed webhook, idempotent escrow credit', async () => {
    const created = await createCampaign('Sandbox campaign', 2500, 1);
    campaignId = created.id;
    const input = { purpose: 'campaign_funding', ref_id: campaignId, provider: 'simulator' };
    await api(null, '/payments/intents', 401, 'POST', input);
    await api(outsider, '/payments/intents', 403, 'POST', input);
    await api(tester, '/payments/intents', 403, 'POST', input);
    await api(owner, '/payments/intents', 404, 'POST', { ...input, provider: 'nopsp' });
    await api(owner, '/payments/intents', 400, 'POST', { ...input, currency: 'GBP' });
    await api(owner, '/payments/intents', 400, 'POST', { ...input, amount_base_minor: 2501 });
    await api(owner, `/payments/campaigns/${campaignId}/fund`, 409, 'POST', { amount_cents: 2500 });
    await api(owner, '/payments/intents', 409, 'POST', { ...input, ref_id: demoCampaignId });

    const first = await api<IntentResponse>(owner, '/payments/intents', 201, 'POST', { ...input, idempotency_key: 'fund-sandbox-campaign-1' });
    assert.equal(first.reused, false);
    const again = await api<IntentResponse>(owner, '/payments/intents', 200, 'POST', { ...input, idempotency_key: 'fund-sandbox-campaign-1' });
    assert.equal(again.intent.id, first.intent.id);
    assert.equal(again.reused, true);
    fundingIntent = first.intent;
    assert.equal(fundingIntent.status, 'pending');
    assert.equal(fundingIntent.mode, 'sandbox');
    assert.equal(fundingIntent.amount_minor, 2500);
    assert.equal(fundingIntent.currency, 'EUR');
    assert.equal(first.redirect_url, `/checkout/simulator?reference=${fundingIntent.id}`);

    await api(outsider, `/payments/intents/${fundingIntent.id}`, 404);
    await api(admin, `/payments/intents/${fundingIntent.id}`, 200);
    assert.deepEqual((await api<{ intents: Intent[] }>(outsider, '/payments/intents')).intents, []);
    assert.equal((await api<{ intents: Intent[] }>(owner, `/payments/intents?ref_id=${campaignId}`)).intents.length, 1);
    await api(outsider, `/payments/simulator/${fundingIntent.id}/complete`, 404, 'POST', { outcome: 'succeeded' });
    await api(admin, `/payments/simulator/${fundingIntent.id}/complete`, 403, 'POST', { outcome: 'succeeded' });
    await api(outsider, `/payments/intents/${fundingIntent.id}/cancel`, 404, 'POST', {});
    await api(owner, `/payments/simulator/${fundingIntent.id}/complete`, 400, 'POST', { outcome: 'maybe' });

    const completed = await api<{ intent: Intent }>(owner, `/payments/simulator/${fundingIntent.id}/complete`, 200, 'POST', { outcome: 'succeeded' });
    assert.equal(completed.intent.status, 'succeeded');
    assert.equal(completed.intent.settlement, 'settled');
    assert.equal(completed.intent.final, true);
    assert.equal(balance(ledgerAccounts.campaignEscrow(campaignId), 'sandbox', 'EUR'), 2500);
    assert.equal(journals('campaign.funded', fundingIntent.id), 1);
    const view = await api<{ campaign: { payment_mode: string }; balance: Budget }>(owner, `/testing/campaigns/${campaignId}`);
    assert.equal(view.campaign.payment_mode, 'sandbox');
    assert.equal(view.balance.funded_cents, 2500);
    assert.equal(view.balance.available_cents, 2500);
    assert.equal(view.balance.mode, 'sandbox');
    assert.ok(one("SELECT id FROM notifications WHERE user_id=? AND title='Financement reçu'", owner.id));
    assert.ok(one("SELECT id FROM audit_events WHERE action='payments.campaign.funded' AND target_id=?", campaignId));
    assert.equal(one<{ total: number }>("SELECT COUNT(*) AS total FROM transactions WHERE campaign_id=?", campaignId)!.total, 0, 'no demo transaction for real funds');

    // Same signed event delivered again (provider retry) and the same outcome replayed: still one credit.
    const replay = await simulatorWebhook(fundingIntent, 'succeeded', `simevt_${fundingIntent.id}_succeeded`);
    assert.equal(replay.status, 200);
    assert.equal(replay.data.duplicates, 1);
    await api(owner, `/payments/simulator/${fundingIntent.id}/complete`, 200, 'POST', { outcome: 'succeeded' });
    assert.equal(journals('campaign.funded', fundingIntent.id), 1);
    await api(owner, '/payments/intents', 409, 'POST', input);

    // Invalid or missing signatures are rejected before anything is recorded.
    const events = one<{ total: number }>('SELECT COUNT(*) AS total FROM payment_webhook_events')!.total;
    const body = JSON.stringify({ reference: fundingIntent.id, provider_reference: fundingIntent.provider_reference, status: 'succeeded', event_id: 'forged' });
    assert.equal((await webhook('simulator', body, { 'content-type': 'application/json', 'x-alpha-simulator-signature': 'deadbeef' })).status, 401);
    assert.equal((await webhook('simulator', body, { 'content-type': 'application/json' })).status, 401);
    assert.equal((await webhook('simulator', '', {}, 'GET', `?reference=${fundingIntent.id}&status=succeeded`)).status, 401);
    assert.equal((await webhook('testpay', body, { 'x-testpay-signature': testpaySignature('wrong-secret', body) })).status, 401);
    assert.equal(one<{ total: number }>('SELECT COUNT(*) AS total FROM payment_webhook_events')!.total, events);
    assert.equal(ledgerIsBalanced(), true);
  });

  await t.test('mission acceptance pays the tester from escrow minus the configured fee', async () => {
    const { mission, balance: selection } = await completeMission(campaignId);
    assert.equal(selection.reserved_cents, 2500);
    assert.equal(selection.available_cents, 0);
    await api(tester, `/testing/missions/${mission.id}/accept`, 403, 'POST', {});
    const accepted = await api<{ mission: { status: string } }>(owner, `/testing/missions/${mission.id}/accept`, 200, 'POST', {});
    assert.equal(accepted.mission.status, 'paid');
    assert.equal(available(tester.id), 2375);
    assert.equal(platformFees(), 125);
    assert.equal(balance(ledgerAccounts.campaignEscrow(campaignId), 'sandbox', 'EUR'), 0);
    assert.equal(journals('mission.paid', mission.id), 1);
    const repeated = await api<{ status: string; mode: string }>(owner, `/payments/missions/${mission.id}/pay`, 200, 'POST', {});
    assert.deepEqual(repeated, { status: 'paid', mode: 'sandbox' });
    await api(outsider, `/payments/missions/${mission.id}/pay`, 403, 'POST', {});
    assert.equal(journals('mission.paid', mission.id), 1);
    assert.equal(one<{ total: number }>("SELECT COUNT(*) AS total FROM transactions WHERE mission_id=?", mission.id)!.total, 0);
    const balances = await api<{ balances: { mode: string; currency: string; available_minor: number }[] }>(tester, '/payments/balances');
    assert.deepEqual(balances.balances, [{ mode: 'sandbox', currency: 'EUR', available_minor: 2375 }]);
    const budget = (await api<{ balance: Budget }>(owner, `/testing/campaigns/${campaignId}`)).balance;
    assert.equal(budget.paid_cents, 2500);
    assert.ok(one("SELECT id FROM notifications WHERE user_id=? AND title='Récompense créditée'", tester.id));
    assert.equal(ledgerIsBalanced(), true);
  });

  await t.test('mobile money intents store a masked phone; concurrent confirmations settle exactly once', async () => {
    campaign2Id = (await createCampaign('Concurrent campaign', 1000, 2)).id;
    await api(owner, '/payments/intents', 400, 'POST', { purpose: 'campaign_funding', ref_id: campaign2Id, provider: 'simulator', method: 'mobile_money' });
    const created = await api<IntentResponse>(owner, '/payments/intents', 201, 'POST', {
      purpose: 'campaign_funding', ref_id: campaign2Id, provider: 'simulator', method: 'mobile_money', phone: '+237 6 70 00 00 01', operator: 'mtn',
    });
    assert.equal(created.redirect_url, null);
    assert.match(created.instructions, /simulée/);
    assert.equal(created.intent.amount_minor, 2000);
    assert.equal(created.intent.customer_phone_masked, '+237•••••••01');
    assert.ok(!JSON.stringify(one('SELECT * FROM payment_intents WHERE id=?', created.intent.id)).includes('670000001'), 'full phone numbers are never stored');
    const intent = created.intent;
    assert.equal(settleSimulatedPayment(intent.provider_reference!, 'succeeded'), true);
    const results = await Promise.all([
      simulatorWebhook(intent, 'succeeded', 'concurrent-1'),
      simulatorWebhook(intent, 'succeeded', 'concurrent-2'),
      simulatorWebhook(intent, 'succeeded', 'concurrent-1'),
      api<{ intent: Intent }>(owner, `/payments/intents/${intent.id}/refresh`, 200, 'POST', {}),
      api<{ intent: Intent }>(admin, `/payments/admin/intents/${intent.id}/reconcile`, 200, 'POST', {}),
      api<{ intent: Intent }>(owner, `/payments/simulator/${intent.id}/complete`, 200, 'POST', { outcome: 'succeeded' }),
      Promise.resolve(transaction(() => settleSucceededIntent(intent.id, 'test'))),
    ]);
    assert.ok(results.slice(0, 3).every((result) => (result as { status: number }).status === 200));
    assert.equal(journals('campaign.funded', intent.id), 1);
    assert.equal(balance(ledgerAccounts.campaignEscrow(campaign2Id), 'sandbox', 'EUR'), 2000);
    assert.equal((await api<{ intent: Intent }>(owner, `/payments/intents/${intent.id}`)).intent.status, 'succeeded');
    assert.equal(ledgerIsBalanced(), true);
  });

  await t.test('fake HTTP provider: redirect, provider outage, failed webhook retry and amount mismatch never credits', async () => {
    const campaign3 = (await createCampaign('HTTP provider campaign', 3000, 1)).id;
    const input = { purpose: 'campaign_funding', ref_id: campaign3, provider: 'testpay' };
    pspDown = true;
    await api(owner, '/payments/intents', 502, 'POST', input);
    assert.equal(one<{ status: string }>("SELECT status FROM payment_intents WHERE ref_id=? AND provider='testpay'", campaign3)!.status, 'failed');
    pspDown = false;

    const mismatch = (await api<IntentResponse>(owner, '/payments/intents', 201, 'POST', input));
    assert.equal(mismatch.redirect_url, `https://psp.example.test/pay/fk_${mismatch.intent.id}`);
    assert.ok(pspCalls.includes('POST /charges'));
    // The provider API reports that only 1,00 € was paid while the webhook claims the full amount.
    psp.set(mismatch.intent.provider_reference!, { status: 'succeeded', amount: 100, currency: 'EUR' });
    const delivered = await testpayWebhook(mismatch.intent, 'succeeded', 'evt-mismatch', 3000);
    assert.equal(delivered.status, 200);
    const blocked = (await api<{ intent: Intent }>(owner, `/payments/intents/${mismatch.intent.id}`)).intent;
    assert.equal(blocked.status, 'failed');
    assert.equal(blocked.review_required, true);
    assert.equal(blocked.settlement, 'none');
    assert.equal(balance(ledgerAccounts.campaignEscrow(campaign3), 'sandbox', 'EUR'), 0);
    assert.equal(journals('campaign.funded', mismatch.intent.id), 0);
    assert.ok(one("SELECT id FROM notifications WHERE user_id=? AND kind='payments_alert'", admin.id), 'admins are alerted');
    await api(owner, `/payments/intents/${mismatch.intent.id}/refresh`, 200, 'POST', {});
    assert.equal(journals('campaign.funded', mismatch.intent.id), 0);
    const review = await api<{ intents: { id: string }[] }>(admin, '/payments/admin/intents?review=1');
    assert.deepEqual(review.intents.map((item) => item.id), [mismatch.intent.id]);

    const intent = (await api<IntentResponse>(owner, '/payments/intents', 201, 'POST', input)).intent;
    pspDown = true;
    await api(owner, `/payments/intents/${intent.id}/refresh`, 502, 'POST', {});
    assert.equal(one<{ attempts: number }>('SELECT attempts FROM payment_intents WHERE id=?', intent.id)!.attempts, 1);
    psp.set(intent.provider_reference!, { status: 'succeeded', amount: 3000, currency: 'EUR' });
    const failedDelivery = await testpayWebhook(intent, 'succeeded', 'evt-outage', 3000);
    assert.equal(failedDelivery.status, 200, 'webhooks are acknowledged even when processing fails');
    const failedEvent = one<{ status: string; error: string }>("SELECT status,error FROM payment_webhook_events WHERE provider='testpay' AND event_key='id:evt-outage'")!;
    assert.equal(failedEvent.status, 'failed');
    assert.match(failedEvent.error, /503/);
    assert.equal(balance(ledgerAccounts.campaignEscrow(campaign3), 'sandbox', 'EUR'), 0);
    const overview = await api<{ alerts: { failed_webhooks: number; review_required: number } }>(admin, '/payments/admin/overview');
    assert.equal(overview.alerts.failed_webhooks, 1);
    assert.equal(overview.alerts.review_required, 1);
    pspDown = false;
    const retried = await testpayWebhook(intent, 'succeeded', 'evt-outage', 3000);
    assert.equal(retried.data.duplicates, 0, 'failed events are processed again when the provider retries');
    assert.equal(balance(ledgerAccounts.campaignEscrow(campaign3), 'sandbox', 'EUR'), 3000);
    assert.equal(one<{ status: string }>("SELECT status FROM payment_webhook_events WHERE event_key='id:evt-outage'")!.status, 'processed');
    assert.equal((await testpayWebhook(intent, 'succeeded', 'evt-outage', 3000)).data.duplicates, 1);
    assert.equal(journals('campaign.funded', intent.id), 1);
    const detail = await api<{ webhooks: unknown[]; journals: { kind: string }[] }>(admin, `/payments/admin/intents/${intent.id}`);
    assert.equal(detail.webhooks.length, 1);
    assert.deepEqual(detail.journals.map((journal) => journal.kind), ['campaign.funded']);
    assert.equal(ledgerIsBalanced(), true);
  });

  await t.test('marketplace: purchase through an intent, delivery, acceptance releases the escrow to the seller', async () => {
    const listing = await createListing('Sandbox component', 4900);
    await api(tester, `/marketplace/listings/${listing.id}/buy`, 409, 'POST', {});
    await api(owner, '/payments/intents', 403, 'POST', { purpose: 'order_purchase', ref_id: listing.id, provider: 'simulator' });
    await api(tester, '/payments/intents', 400, 'POST', { purpose: 'order_purchase', ref_id: listing.id, provider: 'simulator', amount_base_minor: 100 });
    const intent = (await api<IntentResponse>(tester, '/payments/intents', 201, 'POST', { purpose: 'order_purchase', ref_id: listing.id, provider: 'simulator' })).intent;
    assert.equal(intent.amount_minor, 4900);
    assert.equal(one<{ total: number }>('SELECT COUNT(*) AS total FROM orders WHERE listing_id=?', listing.id)!.total, 0, 'no order before payment');
    const failed = await api<IntentResponse>(tester, '/payments/intents', 201, 'POST', { purpose: 'order_purchase', ref_id: listing.id, provider: 'simulator' });
    assert.equal(one<{ status: string }>('SELECT status FROM payment_intents WHERE id=?', intent.id)!.status, 'cancelled', 'a new attempt supersedes the previous one');
    const refused = await api<{ intent: Intent }>(tester, `/payments/simulator/${failed.intent.id}/complete`, 200, 'POST', { outcome: 'failed' });
    assert.equal(refused.intent.status, 'failed');
    assert.equal(one<{ total: number }>('SELECT COUNT(*) AS total FROM orders WHERE listing_id=?', listing.id)!.total, 0);

    const paid = (await api<IntentResponse>(tester, '/payments/intents', 201, 'POST', { purpose: 'order_purchase', ref_id: listing.id, provider: 'simulator' })).intent;
    const settled = (await api<{ intent: Intent }>(tester, `/payments/simulator/${paid.id}/complete`, 200, 'POST', { outcome: 'succeeded' })).intent;
    assert.ok(settled.order_id);
    const orderId = settled.order_id!;
    const order = await api<{ order: Order; mode: string }>(tester, `/marketplace/orders/${orderId}`);
    assert.equal(order.order.status, 'paid');
    assert.equal(order.order.payment_mode, 'sandbox');
    assert.equal(order.mode, 'sandbox');
    await api(outsider, `/marketplace/orders/${orderId}`, 404);
    assert.equal(balance(ledgerAccounts.orderEscrow(orderId), 'sandbox', 'EUR'), 4900);
    await api(tester, '/payments/intents', 409, 'POST', { purpose: 'order_purchase', ref_id: listing.id, provider: 'simulator' });
    const delivered = await api<{ order: Order }>(owner, `/marketplace/orders/${orderId}/deliver`, 200, 'POST', {
      version: order.order.version, delivery_text: 'Private delivery: archive reference sandbox-component-v1.',
    });
    const sellerBefore = available(owner.id);
    const feesBefore = platformFees();
    for (let attempt = 0; attempt < 2; attempt++) {
      const completed = await api<{ order: Order; mode: string }>(tester, `/marketplace/orders/${orderId}/complete`, 200, 'POST', { version: delivered.order.version });
      assert.equal(completed.order.status, 'completed');
    }
    assert.equal(available(owner.id) - sellerBefore, 4165);
    assert.equal(platformFees() - feesBefore, 735);
    assert.equal(balance(ledgerAccounts.orderEscrow(orderId), 'sandbox', 'EUR'), 0);
    assert.equal(journals('order.released', orderId), 1);
    assert.equal(one<{ total: number }>('SELECT COUNT(*) AS total FROM transactions WHERE order_id=?', orderId)!.total, 0);
    await api(tester, `/marketplace/orders/${orderId}/dispute`, 409, 'POST', { reason: 'The delivered archive does not match the description.' });
    assert.throws(() => transaction(() => refundOrderEscrow(orderId, admin.id, 'Trop tard')), /Aucun montant remboursable/);
    assert.equal(ledgerIsBalanced(), true);
  });

  await t.test('refundOrderEscrow (disputes) refunds the buyer; provider refunds are retried', async () => {
    const listing = await createListing('Refunded component', 3000);
    const intent = (await api<IntentResponse>(tester, '/payments/intents', 201, 'POST', { purpose: 'order_purchase', ref_id: listing.id, provider: 'testpay' })).intent;
    psp.set(intent.provider_reference!, { status: 'succeeded', amount: 3000, currency: 'EUR' });
    assert.equal((await testpayWebhook(intent, 'succeeded', 'evt-order-refund')).status, 200);
    const orderId = one<{ order_id: string }>('SELECT order_id FROM payment_intents WHERE id=?', intent.id)!.order_id;
    assert.ok(orderId);
    assert.equal(balance(ledgerAccounts.orderEscrow(orderId), 'sandbox', 'EUR'), 3000);

    const demoOrder = one<{ id: string }>("SELECT id FROM orders WHERE payment_mode='demo' LIMIT 1")!.id;
    assert.throws(() => transaction(() => refundOrderEscrow(demoOrder, admin.id, 'Démo')), /démonstration/);
    pspDown = true;
    transaction(() => refundOrderEscrow(orderId, admin.id, 'Litige : livraison non conforme'));
    assert.equal(one<{ status: string }>('SELECT status FROM orders WHERE id=?', orderId)!.status, 'refunded');
    assert.equal(balance(ledgerAccounts.orderEscrow(orderId), 'sandbox', 'EUR'), 0);
    assert.equal(journals('order.refunded', orderId), 1);
    const pending = await waitFor(() => {
      const row = one<Refund>('SELECT * FROM refunds WHERE order_id=?', orderId);
      return row && row.last_error ? row : undefined;
    }, 'refund attempt recorded');
    assert.equal(pending.status, 'pending');
    assert.equal(pending.attempts, 1);
    assert.equal(pending.amount_minor, 3000);
    assert.throws(() => transaction(() => refundOrderEscrow(orderId, admin.id, 'Deuxième fois')), /Aucun montant remboursable/);
    await api(owner, `/payments/admin/refunds/${pending.id}/retry`, 403, 'POST', {});
    pspDown = false;
    const retried = await api<{ refund: Refund }>(admin, `/payments/admin/refunds/${pending.id}/retry`, 200, 'POST', {});
    assert.equal(retried.refund.status, 'succeeded');
    assert.equal(retried.refund.provider_reference, `fkre_${pending.id}`);
    await api(admin, `/payments/admin/refunds/${pending.id}/retry`, 409, 'POST', {});
    assert.ok(one("SELECT id FROM notifications WHERE user_id=? AND title='Remboursement effectué'", tester.id));
    assert.ok(one("SELECT id FROM audit_events WHERE action='payments.order.refunded' AND target_id=?", orderId));
    assert.equal(ledgerIsBalanced(), true);
  });

  await t.test('closing a campaign refunds only the unreserved escrow; reserved rewards are still paid', async () => {
    const { mission } = await completeMission(campaign2Id);
    await api(outsider, `/testing/campaigns/${campaign2Id}/close`, 403, 'POST', {});
    await api(owner, `/payments/campaigns/${campaign2Id}/refund`, 409, 'POST', {});
    const closed = await api<{ campaign: { status: string }; balance: Budget; refund: { refunded_cents: number } }>(owner, `/testing/campaigns/${campaign2Id}/close`, 200, 'POST', { reason: 'Une seule place utilisée.' });
    assert.equal(closed.campaign.status, 'closed');
    assert.equal(closed.refund.refunded_cents, 1000);
    assert.equal(closed.balance.reserved_cents, 1000);
    assert.equal(closed.balance.refunded_cents, 1000);
    assert.equal(balance(ledgerAccounts.campaignEscrow(campaign2Id), 'sandbox', 'EUR'), 1000);
    assert.equal(journals('campaign.refunded', campaign2Id), 1);
    const refund = await waitFor(() => one<Refund>("SELECT * FROM refunds WHERE campaign_id=? AND status='succeeded'", campaign2Id), 'campaign refund processed');
    assert.equal(refund.amount_minor, 1000);
    await api(owner, `/testing/campaigns/${campaign2Id}/close`, 409, 'POST', {});
    await api(owner, `/payments/campaigns/${campaign2Id}/refund`, 409, 'POST', {});
    await api(owner, '/payments/intents', 409, 'POST', { purpose: 'campaign_funding', ref_id: campaign2Id, provider: 'simulator' });
    const testerBefore = available(tester.id);
    await api(owner, `/testing/missions/${mission.id}/accept`, 200, 'POST', {});
    assert.equal(available(tester.id) - testerBefore, 950);
    assert.equal(balance(ledgerAccounts.campaignEscrow(campaign2Id), 'sandbox', 'EUR'), 0);
    assert.equal(ledgerIsBalanced(), true);
  });

  await t.test('payments.reconcile re-checks pending intents with status() and expires stale ones', async () => {
    const campaign4 = (await createCampaign('Reconciled campaign', 500, 1)).id;
    const stale = (await api<IntentResponse>(owner, '/payments/intents', 201, 'POST', { purpose: 'campaign_funding', ref_id: campaign4, provider: 'simulator' })).intent;
    run("UPDATE payment_intents SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?", stale.id);
    assert.equal(await runJob('payments.reconcile'), true);
    assert.equal(one<{ status: string }>('SELECT status FROM payment_intents WHERE id=?', stale.id)!.status, 'expired');
    assert.ok(one("SELECT id FROM notifications WHERE user_id=? AND title='Paiement expiré'", owner.id));

    const late = (await api<IntentResponse>(owner, '/payments/intents', 201, 'POST', { purpose: 'campaign_funding', ref_id: campaign4, provider: 'simulator' })).intent;
    assert.equal(settleSimulatedPayment(late.provider_reference!, 'succeeded'), true);
    run("UPDATE payment_intents SET next_check_at='2000-01-01T00:00:00.000Z' WHERE id=?", late.id);
    await runJob('payments.reconcile');
    assert.equal(one<{ status: string }>('SELECT status FROM payment_intents WHERE id=?', late.id)!.status, 'succeeded');
    assert.equal(balance(ledgerAccounts.campaignEscrow(campaign4), 'sandbox', 'EUR'), 500);
    assert.equal(ledgerIsBalanced(), true);
  });

  await t.test('admin console: overview, listings, settings guards and balanced manual adjustments', async () => {
    const overview = await api<{ mode: string; ledger_balanced: boolean; escrow: { total: number }[]; platform_fees: { total: number }[]; live_problems: string[] }>(admin, '/payments/admin/overview');
    assert.equal(overview.mode, 'sandbox');
    assert.equal(overview.ledger_balanced, true);
    assert.ok(overview.escrow.length > 0);
    assert.equal(overview.platform_fees[0].total, platformFees());
    assert.ok(overview.live_problems.length >= 1);
    const listed = await api<{ intents: { id: string }[]; total: number }>(admin, '/payments/admin/intents?status=succeeded&purpose=order_purchase');
    assert.equal(listed.total, 2);
    assert.ok((await api<{ events: unknown[] }>(admin, '/payments/admin/webhooks?provider=testpay')).events.length >= 3);
    assert.equal((await api<{ refunds: unknown[] }>(admin, '/payments/admin/refunds?status=succeeded')).refunds.length, 2);
    await api(admin, '/payments/admin/settings', 409, 'PUT', { base_currency: 'XAF' });
    const fx = await api<{ fx: Record<string, number> }>(admin, '/payments/admin/settings', 200, 'PUT', { fx: { USD: 1.08 } });
    assert.equal(fx.fx.USD, 1.08);
    const checkout = await api<{ providers: { id: string; currencies: string[] }[] }>(owner, '/payments/providers/available');
    assert.deepEqual(checkout.providers.find((provider) => provider.id === 'simulator')!.currencies, ['EUR', 'XAF', 'XOF', 'USD']);
    const fxCampaign = (await createCampaign('FX campaign', 1000, 1)).id;
    const usd = (await api<IntentResponse>(owner, '/payments/intents', 201, 'POST', { purpose: 'campaign_funding', ref_id: fxCampaign, provider: 'simulator', currency: 'USD' })).intent;
    assert.deepEqual([usd.amount_base_minor, usd.amount_minor, usd.currency], [1000, 1080, 'USD']);
    const xaf = (await api<IntentResponse>(owner, '/payments/intents', 201, 'POST', { purpose: 'campaign_funding', ref_id: fxCampaign, provider: 'simulator', currency: 'XAF' })).intent;
    assert.deepEqual([xaf.amount_minor, xaf.currency], [6560, 'XAF']);
    assert.equal((await api<{ intent: Intent }>(owner, `/payments/intents/${xaf.id}/cancel`, 200, 'POST', {})).intent.status, 'cancelled');

    await api(admin, '/payments/admin/adjustments', 400, 'POST', { mode: 'sandbox', memo: 'Correction de test', legs: [
      { account: 'platform:adjustments', amount_minor: -100 }, { account: `user:${tester.id}:available`, amount_minor: 50 }] });
    await api(admin, '/payments/admin/adjustments', 400, 'POST', { mode: 'sandbox', memo: 'Correction de test', legs: [
      { account: 'not-an-account', amount_minor: -100 }, { account: `user:${tester.id}:available`, amount_minor: 100 }] });
    await api(admin, '/payments/admin/adjustments', 400, 'POST', { mode: 'sandbox', legs: [
      { account: 'platform:adjustments', amount_minor: -100 }, { account: `user:${tester.id}:available`, amount_minor: 100 }] });
    const before = available(tester.id);
    const adjustment = await api<{ journal_id: string; ref_id: string; ledger_balanced: boolean }>(admin, '/payments/admin/adjustments', 201, 'POST', {
      mode: 'sandbox', memo: 'Geste commercial après incident', legs: [
        { account: 'platform:adjustments', amount_minor: -100 }, { account: `user:${tester.id}:available`, amount_minor: 100 }] });
    assert.equal(adjustment.ledger_balanced, true);
    assert.equal(available(tester.id) - before, 100);
    assert.ok(one("SELECT id FROM audit_events WHERE action='payments.ledger.adjustment' AND target_id=?", adjustment.ref_id));
    const listedJournals = await api<{ journals: { kind: string; entries: unknown[] }[]; ledger_balanced: boolean }>(admin, '/payments/admin/journals?kind=adjustment');
    assert.equal(listedJournals.journals.length, 1);
    assert.equal(listedJournals.journals[0].entries.length, 2);
  });

  await t.test('switching to live requires the typed confirmation, HTTPS, a secrets key and a valid live provider', async () => {
    await api(admin, '/payments/admin/mode', 400, 'PUT', { mode: 'live' });
    await api(admin, '/payments/admin/mode', 400, 'PUT', { mode: 'live', confirmation: 'activer le mode reel' });
    const refused = await api<{ error: string }>(admin, '/payments/admin/mode', 409, 'PUT', { mode: 'live', confirmation: 'ACTIVER LE MODE RÉEL' });
    assert.match(refused.error, /HTTPS/);
    assert.match(refused.error, /ALPHA_SECRETS_KEY/);
    await api(admin, '/payments/admin/providers/simulator/live', 400, 'PUT', { enabled: true, settings: {}, secrets: {} });
    process.env.APP_ORIGIN = 'https://alpha.example.test';
    process.env.ALPHA_SECRETS_KEY = 'ab'.repeat(32);
    const noProvider = await api<{ error: string }>(admin, '/payments/admin/mode', 409, 'PUT', { mode: 'live', confirmation: 'ACTIVER LE MODE RÉEL' });
    assert.match(noProvider.error, /prestataire/);
    await api(admin, '/payments/admin/providers/testpay/live', 200, 'PUT', { enabled: true, settings: {}, secrets: { api_key: 'tp_live_secret_9876' } });
    await api(owner, '/payments/admin/mode', 403, 'PUT', { mode: 'live', confirmation: 'ACTIVER LE MODE RÉEL' });
    const live = await api<{ mode: string; warnings: string[] }>(admin, '/payments/admin/mode', 200, 'PUT', { mode: 'live', confirmation: 'ACTIVER LE MODE RÉEL' });
    assert.equal(live.mode, 'live');
    assert.ok(live.warnings.some((warning) => warning.includes('séquestre')), 'sandbox escrow is reported when leaving the sandbox');
    assert.equal((await api<{ payment_mode: string }>(null, '/health')).payment_mode, 'live');
    const checkout = await api<{ providers: { id: string }[] }>(owner, '/payments/providers/available');
    assert.deepEqual(checkout.providers.map((provider) => provider.id), ['testpay']);
    const campaign5 = (await createCampaign('Live campaign', 700, 1)).id;
    await api(owner, '/payments/intents', 409, 'POST', { purpose: 'campaign_funding', ref_id: campaign5, provider: 'simulator' });
    await api(owner, '/payments/intents', 409, 'POST', { purpose: 'campaign_funding', ref_id: campaignId, provider: 'testpay' });
    assert.equal((await simulatorWebhook(fundingIntent, 'succeeded', 'live-sim')).status, 404, 'sandbox webhooks are refused in live');
    const back = await api<{ mode: string; warnings: string[] }>(admin, '/payments/admin/mode', 200, 'PUT', { mode: 'sandbox' });
    assert.deepEqual(back, { mode: 'sandbox', previous: 'live', warnings: [] });
    delete process.env.APP_ORIGIN;
    delete process.env.ALPHA_SECRETS_KEY;
  });

  await t.test('personal data export and erasure keep financial records but scrub contact data', async () => {
    const handler = personalDataHandlers().find(([name]) => name === 'payments')![1];
    const exported = await handler.export(owner.id) as { intents: Intent[]; refunds: unknown[] };
    assert.ok(exported.intents.length >= 8);
    assert.ok(exported.intents.some((intent) => intent.customer_phone_masked === '+237•••••••01'));
    assert.ok(exported.refunds.length >= 1);
    await handler.erase(owner.id);
    assert.equal(one<{ total: number }>("SELECT COUNT(*) AS total FROM payment_intents WHERE user_id=? AND customer_phone_masked<>''", owner.id)!.total, 0);
    assert.ok(one<{ total: number }>("SELECT COUNT(*) AS total FROM payment_intents WHERE user_id=? AND settlement='settled'", owner.id)!.total >= 4);
    assert.equal(ledgerIsBalanced(), true);
  });

  await t.test('back to demo: V3 flows are unchanged and real-money entry points close again', async () => {
    const switched = await api<{ mode: string; warnings: string[] }>(admin, '/payments/admin/mode', 200, 'PUT', { mode: 'demo' });
    assert.equal(switched.mode, 'demo');
    assert.ok(switched.warnings.length >= 1);
    const campaign = await createCampaign('Demo again', 800, 1);
    const funded = await api<{ balance: Budget; mode: string }>(owner, `/payments/campaigns/${campaign.id}/fund`, 200, 'POST', { amount_cents: 800 });
    assert.equal(funded.mode, 'demo');
    assert.deepEqual(funded.balance, { funded_cents: 800, paid_cents: 0, reserved_cents: 0, available_cents: 800 });
    const listing = await createListing('Demo again component', 1200);
    const purchase = await api<{ order: Order; mode: string }>(tester, `/marketplace/listings/${listing.id}/buy`, 201, 'POST', {});
    assert.equal(purchase.mode, 'demo');
    assert.equal(one<{ total: number }>("SELECT COUNT(*) AS total FROM transactions WHERE order_id=? AND kind='purchase' AND mode='demo'", purchase.order.id)!.total, 1);
    await api(owner, '/payments/intents', 409, 'POST', { purpose: 'campaign_funding', ref_id: campaign.id, provider: 'simulator' });
    assert.equal((await simulatorWebhook(fundingIntent, 'succeeded', 'demo-sim')).status, 404);
    const campaigns = await api<{ campaigns: { id: string; payment_mode: string }[] }>(owner, '/payments/campaigns');
    assert.equal(campaigns.campaigns.find((item) => item.id === campaignId)!.payment_mode, 'sandbox');
    assert.equal(campaigns.campaigns.find((item) => item.id === campaign.id)!.payment_mode, 'demo');
    assert.equal(all('SELECT id FROM ledger_journals WHERE mode=?', 'demo').length, 0);
    assert.equal(ledgerIsBalanced(), true);
  });
});
