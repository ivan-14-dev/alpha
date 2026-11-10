import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

process.env.DATABASE_PATH = ':memory:';
const { app } = await import('../server/app.js');
const { all, one, run, transaction } = await import('../server/db.js');
const { setSetting } = await import('../server/platform/settings.js');
const { unseal } = await import('../server/platform/secrets.js');
const { runJob } = await import('../server/platform/jobs.js');
const { personalDataHandlers } = await import('../server/platform/privacy.js');
const { riskLevel } = await import('../server/platform/guards.js');
const { postJournal, balance, ledgerAccounts, ledgerIsBalanced } = await import('../server/payments/ledger.js');
const { payoutFromBase } = await import('../server/payments/mode.js');
const { saveProviderConfig } = await import('../server/payments/config.js');
const { registerProvider, getProvider } = await import('../server/payments/providers/index.js');
const { payoutWebhookHint, handlePayoutWebhook } = await import('../server/compliance/withdrawals.js');
const { csvCell } = await import('../server/compliance/util.js');
const { splitTax } = await import('../server/compliance/invoices.js');
type ProviderStatus = import('../server/payments/providers/types.js').ProviderStatus;

interface Actor { name: string; email: string; id: string; cookie: string }
interface Call { status: number; data: any; text: string; response: Response }

const MODE = 'sandbox';
const EUR = 'EUR';
const year = new Date().getUTCFullYear();
const today = new Date().toISOString().slice(0, 10);

test('V4 compliance: wallet, KYC, payout methods, withdrawals, invoices', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  async function call(actor: Actor | null, path: string, options: { method?: string; body?: unknown; expected?: number } = {}): Promise<Call> {
    const headers: Record<string, string> = { 'X-Alpha-Client': 'web', Origin: 'http://127.0.0.1:5173' };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (actor) headers.Cookie = actor.cookie;
    const response = await fetch(`${base}${path}`, { method: options.method ?? 'GET', headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
    const text = await response.text();
    let data: any = text;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    if (options.expected !== undefined) assert.equal(response.status, options.expected, `${options.method ?? 'GET'} ${path} -> ${response.status} ${text.slice(0, 400)}`);
    return { status: response.status, data, text, response };
  }

  async function register(name: string): Promise<Actor> {
    const email = `${name.toLowerCase()}@compliance.test`;
    const response = await fetch(`${base}/auth/register`, {
      method: 'POST', headers: { 'X-Alpha-Client': 'web', Origin: 'http://127.0.0.1:5173', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password: 'Correct-Horse-Battery-42', accept_terms: true }),
    });
    const text = await response.text();
    assert.equal(response.status, 201, text);
    const cookie = response.headers.getSetCookie().map((item) => item.split(';')[0]).find((item) => item.startsWith('alpha_session='));
    assert.ok(cookie, 'session cookie');
    return { name, email, id: (JSON.parse(text) as { user: { id: string } }).user.id, cookie };
  }

  const admin = await register('Admin');
  const admin2 = await register('Reviewer');
  const alice = await register('Alice');
  const bob = await register('Bob');
  const carol = await register('Carol');
  const dave = await register('Dave');
  const erin = await register('Erin');
  const gina = await register('Gina');
  run("UPDATE users SET role='admin' WHERE id IN (?,?)", admin.id, admin2.id);
  if (!all<{ name: string }>('PRAGMA table_info(users)').some((column) => column.name === 'email_verified_at')) run('ALTER TABLE users ADD COLUMN email_verified_at TEXT');
  run('UPDATE users SET email_verified_at=NULL');
  for (const actor of [admin, admin2, alice, bob, dave, erin, gina]) run('UPDATE users SET email_verified_at=? WHERE id=?', new Date().toISOString(), actor.id);

  const available = (userId: string) => balance(ledgerAccounts.userAvailable(userId), MODE, EUR);
  const inFlight = () => balance(ledgerAccounts.withdrawalsInFlight(), MODE, EUR);
  const notifications = (userId: string, kind: string) => one<{ count: number }>('SELECT COUNT(*) AS count FROM notifications WHERE user_id=? AND kind=?', userId, kind)!.count;
  const audits = (action: string) => one<{ count: number }>('SELECT COUNT(*) AS count FROM audit_events WHERE action=?', action)!.count;
  const withdrawal = (withdrawalId: string) => one<any>('SELECT * FROM withdrawals WHERE id=?', withdrawalId);
  const journalKinds = (withdrawalId: string) => all<{ kind: string }>("SELECT kind FROM ledger_journals WHERE ref_type='withdrawal' AND ref_id=? ORDER BY rowid", withdrawalId).map((item) => item.kind);
  const expectedInitial = (userId: string) => (riskLevel(userId) === 'high' ? 'on_hold' : 'approved');

  // Payment intents come from payments-core (migration 007); the fallback keeps this suite independent.
  if (!one("SELECT 1 FROM sqlite_master WHERE type='table' AND name='payment_intents'")) {
    run(`CREATE TABLE payment_intents (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, purpose TEXT NOT NULL, ref_type TEXT NOT NULL, ref_id TEXT NOT NULL,
      mode TEXT NOT NULL, provider TEXT NOT NULL, provider_reference TEXT, amount_base_minor INTEGER NOT NULL, base_currency TEXT NOT NULL,
      amount_minor INTEGER NOT NULL, currency TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'created', failure_reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  }
  const intentColumns = new Set(all<{ name: string }>('PRAGMA table_info(payment_intents)').map((column) => column.name));
  let sequence = 0;
  /** Funds a campaign (payer) then pays a mission to `payee`: reward minus the platform fee lands on the available balance. */
  function credit(payerId: string, payeeId: string, reward: number, fee: number) {
    sequence += 1;
    const intentId = `pi-test-${sequence}`;
    const campaignId = `campaign-test-${sequence}`;
    const values: Record<string, string | number> = {
      id: intentId, user_id: payerId, purpose: 'campaign_funding', ref_type: 'campaign', ref_id: campaignId, mode: MODE, provider: 'simulator',
      provider_reference: `sim_${intentId}`, amount_base_minor: reward, base_currency: EUR, amount_minor: reward, currency: EUR, status: 'succeeded',
      idempotency_key: `intent-key-${intentId}`, expires_at: new Date(Date.now() + 3600_000).toISOString(),
    };
    const keys = Object.keys(values).filter((key) => intentColumns.has(key));
    run(`INSERT INTO payment_intents(${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map((key) => values[key]));
    postJournal({
      idempotencyKey: `campaign.funded:${intentId}`, kind: 'campaign.funded', mode: MODE, currency: EUR, refType: 'payment_intent', refId: intentId,
      memo: 'Financement de campagne (test)', actorId: payerId,
      legs: [{ account: ledgerAccounts.provider('simulator'), amountMinor: -reward }, { account: ledgerAccounts.campaignEscrow(campaignId), amountMinor: reward }],
    });
    postJournal({
      idempotencyKey: `mission.paid:mission-test-${sequence}`, kind: 'mission.paid', mode: MODE, currency: EUR, refType: 'mission', refId: `mission-test-${sequence}`,
      memo: 'Mission validée (test)',
      legs: [
        { account: ledgerAccounts.campaignEscrow(campaignId), amountMinor: -reward },
        { account: ledgerAccounts.userAvailable(payeeId), amountMinor: reward - fee },
        { account: ledgerAccounts.platformFees(), amountMinor: fee },
      ],
      nonNegative: [ledgerAccounts.campaignEscrow(campaignId)],
    });
  }

  let fileSequence = 0;
  function kycDocument(ownerId: string, scanStatus = 'clean', purpose = 'kyc_document') {
    fileSequence += 1;
    const fileId = `kyc-file-${fileSequence}`;
    run(`INSERT INTO files(id,owner_id,purpose,original_name,mime_type,size_bytes,sha256,storage_key,encrypted,scan_status)
      VALUES (?,?,?,?,?,?,?,?,1,?)`, fileId, ownerId, purpose, `piece-${fileSequence}.pdf`, 'application/pdf', 2048, 'a'.repeat(64), `test/kyc/${fileId}`, scanStatus);
    return fileId;
  }

  const address = { line1: '12 rue de la Paix', postal_code: '75002', city: 'Paris', region: 'Île-de-France' };
  const momo = (phone: string, extra: Record<string, unknown> = {}) => ({
    kind: 'mobile_money', details: { phone, operator: 'mtn', account_name: 'Titulaire Test' }, country: 'CM', currency: 'XAF', ...extra,
  });

  await t.test('demo mode: explicit wallet payload, no ledger, withdrawals refused', async () => {
    const wallet = await call(alice, '/compliance/wallet', { expected: 200 });
    assert.equal(wallet.data.mode, 'demo');
    assert.equal(wallet.data.balances, null);
    assert.deepEqual(wallet.data.movements, []);
    assert.match(wallet.data.notice, /démonstration/);
    assert.equal(wallet.data.can_withdraw, false);
    assert.equal(wallet.data.kyc.status, 'none');
    const refused = await call(alice, '/compliance/withdrawals', { method: 'POST', body: { amount_minor: 2000, payout_method_id: 'nothing' }, expected: 409 });
    assert.match(refused.data.error, /démonstration/);
  });

  await t.test('authorization: anonymous 401, members cannot reach the admin API', async () => {
    for (const path of ['/compliance/wallet', '/compliance/kyc', '/compliance/payout-methods', '/compliance/withdrawals', '/compliance/invoices']) {
      await call(null, path, { expected: 401 });
    }
    for (const path of ['/compliance/admin/summary', '/compliance/admin/kyc', '/compliance/admin/withdrawals', '/compliance/admin/settings', '/compliance/admin/invoices',
      `/compliance/admin/exports/journals.csv?from=${today}&to=${today}`]) {
      await call(alice, path, { expected: 403 });
    }
    await call(alice, `/compliance/admin/kyc/${alice.id}/approve`, { method: 'POST', body: {}, expected: 403 });
    await call(alice, '/compliance/admin/settings/limits', { method: 'PUT', body: {}, expected: 403 });
    const summary = await call(admin, '/compliance/admin/summary', { expected: 200 });
    assert.equal(summary.data.mode, 'demo');
    assert.ok(summary.data.issuer_problems.length > 0);
  });

  setSetting('payments.mode', MODE, admin.id);

  await t.test('KYC: draft, document checks, submission, rejection then approval', async () => {
    assert.equal((await call(alice, '/compliance/kyc', { expected: 200 })).data.status, 'none');
    const foreign = kycDocument(bob.id);
    await call(alice, '/compliance/kyc', { method: 'PUT', body: { document_file_ids: [foreign] }, expected: 400 });
    const wrongPurpose = kycDocument(alice.id, 'clean', 'message_attachment');
    await call(alice, '/compliance/kyc', { method: 'PUT', body: { document_file_ids: [wrongPurpose] }, expected: 400 });
    await call(alice, '/compliance/kyc', { method: 'PUT', body: { country: 'France' }, expected: 400 });

    const draft = await call(alice, '/compliance/kyc', { method: 'PUT', expected: 200, body: { legal_name: 'Alice <img src=x onerror=alert(1)> Martin', country: 'cm', date_of_birth: '1990-05-01' } });
    assert.equal(draft.data.status, 'draft');
    assert.equal(draft.data.country, 'CM');
    const missing = await call(alice, '/compliance/kyc/submit', { method: 'POST', body: {}, expected: 400 });
    assert.match(missing.data.error, /adresse/);
    await call(alice, '/compliance/kyc', { method: 'PUT', body: { address }, expected: 200 });
    const noDocument = await call(alice, '/compliance/kyc/submit', { method: 'POST', body: {}, expected: 400 });
    assert.match(noDocument.data.error, /pièce d’identité/);

    const scanning = kycDocument(alice.id, 'pending');
    await call(alice, '/compliance/kyc', { method: 'PUT', body: { document_file_ids: [scanning] }, expected: 200 });
    await call(alice, '/compliance/kyc/submit', { method: 'POST', body: {}, expected: 409 });
    run("UPDATE files SET scan_status='infected' WHERE id=?", scanning);
    await call(alice, '/compliance/kyc/submit', { method: 'POST', body: {}, expected: 400 });

    const passport = kycDocument(alice.id);
    await call(alice, '/compliance/kyc', { method: 'PUT', body: { document_file_ids: [passport, passport] }, expected: 400 });
    await call(alice, '/compliance/kyc', { method: 'PUT', body: { document_file_ids: [passport] }, expected: 200 });
    const sealed = one<{ address_sealed: string }>('SELECT address_sealed FROM kyc_profiles WHERE user_id=?', alice.id)!.address_sealed;
    assert.ok(!sealed.includes('rue de la Paix'), 'address is sealed at rest');
    const submitted = await call(alice, '/compliance/kyc/submit', { method: 'POST', body: {}, expected: 200 });
    assert.equal(submitted.data.status, 'submitted');
    assert.deepEqual({ ...one<{ resource_type: string; resource_id: string }>('SELECT resource_type,resource_id FROM files WHERE id=?', passport) }, { resource_type: 'kyc', resource_id: alice.id });
    await call(alice, '/compliance/kyc', { method: 'PUT', body: { legal_name: 'Autre' }, expected: 409 });

    const queue = await call(admin, '/compliance/admin/kyc', { expected: 200 });
    assert.ok(queue.data.profiles.some((item: any) => item.user_id === alice.id && item.document_count === 1));
    const detail = await call(admin, `/compliance/admin/kyc/${alice.id}`, { expected: 200 });
    assert.equal(detail.data.documents[0].download_url, `/api/files/${passport}/download`);
    assert.equal(detail.data.address.city, 'Paris');
    assert.equal(audits('compliance.kyc_viewed'), 1);
    await call(admin, `/compliance/admin/kyc/${admin.id}/approve`, { method: 'POST', body: {}, expected: 403 });
    await call(admin, `/compliance/admin/kyc/${alice.id}/reject`, { method: 'POST', body: { reason: 'x' }, expected: 400 });

    const rejected = await call(admin, `/compliance/admin/kyc/${alice.id}/reject`, { method: 'POST', body: { reason: 'Document illisible, merci de le renvoyer.' }, expected: 200 });
    assert.equal(rejected.data.status, 'rejected');
    assert.equal(notifications(alice.id, 'compliance.kyc_rejected'), 1);
    assert.equal(audits('compliance.kyc_rejected'), 1);
    const reopened = await call(alice, '/compliance/kyc', { expected: 200 });
    assert.equal(reopened.data.rejection_reason, 'Document illisible, merci de le renvoyer.');
    assert.equal(reopened.data.editable, true);
    await call(alice, '/compliance/kyc', { method: 'PUT', body: { date_of_birth: '1990-05-02' }, expected: 200 });
    await call(alice, '/compliance/kyc/submit', { method: 'POST', body: {}, expected: 200 });
    const approved = await call(admin, `/compliance/admin/kyc/${alice.id}/approve`, { method: 'POST', body: { level: 'basic', note: 'Pièce conforme' }, expected: 200 });
    assert.equal(approved.data.status, 'approved');
    await call(admin, `/compliance/admin/kyc/${alice.id}/approve`, { method: 'POST', body: {}, expected: 409 });
    assert.equal(notifications(alice.id, 'compliance.kyc_approved'), 1);
    assert.equal((await call(alice, '/compliance/kyc', { expected: 200 })).data.editable, false);

    // Minors cannot submit.
    await call(gina, '/compliance/kyc', { method: 'PUT', expected: 200, body: { legal_name: 'Gina Jeune', country: 'FR', date_of_birth: `${year - 10}-01-01`, address, document_file_ids: [kycDocument(gina.id)] } });
    const minor = await call(gina, '/compliance/kyc/submit', { method: 'POST', body: {}, expected: 400 });
    assert.match(minor.data.error, /majeures/);
  });

  let aliceMomo = '';
  await t.test('payout methods: validation, sealing, masking, default and deletion', async () => {
    await call(alice, '/compliance/payout-methods', { method: 'POST', body: momo('0670000001'), expected: 400 });
    await call(alice, '/compliance/payout-methods', { method: 'POST', body: { ...momo('+237670000001'), details: { phone: '+237670000001', operator: 'unknown', account_name: 'Alice' } }, expected: 400 });
    const created = await call(alice, '/compliance/payout-methods', { method: 'POST', body: momo('+237 6 70 00 00 01', { label: 'Mon MoMo' }), expected: 201 });
    aliceMomo = created.data.id;
    assert.equal(created.data.display_mask, 'MTN MoMo ••••0001');
    assert.equal(created.data.is_default, true);
    assert.equal(created.data.payout_available, true);
    assert.ok(!created.text.includes('670000001'), 'API never returns the full number');
    const stored = one<{ details_sealed: string; fingerprint: string }>('SELECT details_sealed,fingerprint FROM payout_methods WHERE id=?', aliceMomo)!;
    assert.ok(!stored.details_sealed.includes('670000001') && !stored.fingerprint.includes('670000001'));
    assert.equal(JSON.parse(unseal(stored.details_sealed, `payout:${aliceMomo}`)).phone, '+237670000001');
    assert.throws(() => unseal(stored.details_sealed, 'payout:other'));
    await call(alice, '/compliance/payout-methods', { method: 'POST', body: momo('+237670000001'), expected: 409 });
    assert.equal(notifications(alice.id, 'compliance.payout_method_added'), 1);

    await call(alice, '/compliance/payout-methods', { method: 'POST', expected: 400, body: { kind: 'bank_account', details: { account_holder: 'Alice Martin', iban: 'FR7630006000011234567890188' }, country: 'FR', currency: 'EUR' } });
    const bank = await call(alice, '/compliance/payout-methods', { method: 'POST', expected: 201, body: { kind: 'bank_account', details: { account_holder: 'Alice Martin', iban: 'FR76 3000 6000 0112 3456 7890 189', bic: 'AGRIFRPP' }, country: 'FR', currency: 'EUR' } });
    assert.equal(bank.data.display_mask, 'FR76 •••• 0189');
    assert.equal(bank.data.is_default, false);
    assert.equal(bank.data.payout_available, false, 'the sandbox simulator does not pay bank accounts');
    await call(alice, '/compliance/payout-methods', { method: 'POST', expected: 400, body: { kind: 'stripe_connect', details: { account_id: 'acc_123456789' }, country: 'FR', currency: 'EUR' } });
    if (getProvider('stripe')?.capabilities.payout) {
      const stripe = await call(alice, '/compliance/payout-methods', { method: 'POST', expected: 201, body: { kind: 'stripe_connect', details: { account_id: 'acct_1234567890ABCD' }, country: 'FR', currency: 'EUR' } });
      assert.equal(stripe.data.display_mask, 'acct_••••ABCD');
      assert.equal(stripe.data.provider, 'stripe');
      await call(alice, `/compliance/payout-methods/${stripe.data.id}`, { method: 'DELETE', expected: 204 });
    }

    const promoted = await call(alice, `/compliance/payout-methods/${bank.data.id}/default`, { method: 'POST', body: {}, expected: 200 });
    assert.equal(promoted.data.is_default, true);
    await call(bob, `/compliance/payout-methods/${bank.data.id}`, { method: 'PATCH', body: { label: 'Volé' }, expected: 404 });
    await call(bob, `/compliance/payout-methods/${bank.data.id}`, { method: 'DELETE', expected: 404 });
    await call(alice, `/compliance/payout-methods/${bank.data.id}`, { method: 'DELETE', expected: 204 });
    assert.equal(one<{ details_sealed: string }>('SELECT details_sealed FROM payout_methods WHERE id=?', bank.data.id)!.details_sealed, '', 'details destroyed on deletion');
    const list = await call(alice, '/compliance/payout-methods', { expected: 200 });
    assert.deepEqual(list.data.payout_methods.map((item: any) => [item.id, item.is_default]), [[aliceMomo, true]]);
  });

  await t.test('wallet in sandbox mode reads balances and movements from the ledger', async () => {
    credit(bob.id, alice.id, 101000, 1000);
    const wallet = await call(alice, '/compliance/wallet', { expected: 200 });
    assert.equal(wallet.data.mode, MODE);
    assert.equal(wallet.data.base_currency, EUR);
    assert.deepEqual(wallet.data.balances, { available_minor: 100000, pending_minor: 0, in_flight_minor: 0, currency: EUR });
    assert.equal(wallet.data.movements[0].kind, 'mission.paid');
    assert.equal(wallet.data.movements[0].label, 'Récompense de mission');
    assert.equal(wallet.data.movements[0].amount_minor, 100000);
    assert.equal(wallet.data.kyc.status, 'approved');
    assert.equal(wallet.data.can_withdraw, true);
    assert.equal(wallet.data.limits.without_kyc_remaining_minor, null);
    assert.equal(wallet.data.limits.daily_remaining_minor, 100000);
  });

  let paidWithdrawal = '';
  await t.test('withdrawal happy path through the compliance.payouts job', async () => {
    await call(alice, '/compliance/withdrawals', { method: 'POST', body: { amount_minor: 500, payout_method_id: aliceMomo }, expected: 400 });
    const created = await call(alice, '/compliance/withdrawals', { method: 'POST', body: { amount_minor: 5000, payout_method_id: aliceMomo, idempotency_key: 'alice-first-withdrawal' }, expected: 201 });
    paidWithdrawal = created.data.id;
    assert.equal(created.data.status, expectedInitial(alice.id));
    if (created.data.status === 'on_hold') await call(admin, `/compliance/admin/withdrawals/${paidWithdrawal}/approve`, { method: 'POST', body: {}, expected: 200 });
    assert.equal(created.data.currency, 'XAF');
    assert.equal(created.data.amount_minor, payoutFromBase(5000, 'XAF'));
    assert.equal(created.data.method.display_mask, 'MTN MoMo ••••0001');
    assert.equal(created.data.risk_level, undefined, 'risk details stay internal');
    assert.equal(available(alice.id), 95000);
    assert.equal(inFlight(), 5000);
    assert.deepEqual(journalKinds(paidWithdrawal), ['withdrawal.requested']);

    const replay = await call(alice, '/compliance/withdrawals', { method: 'POST', body: { amount_minor: 5000, payout_method_id: aliceMomo, idempotency_key: 'alice-first-withdrawal' }, expected: 200 });
    assert.equal(replay.data.id, paidWithdrawal);
    await call(alice, '/compliance/withdrawals', { method: 'POST', body: { amount_minor: 6000, payout_method_id: aliceMomo, idempotency_key: 'alice-first-withdrawal' }, expected: 409 });
    assert.equal(available(alice.id), 95000, 'replays never debit twice');
    await call(alice, `/compliance/payout-methods/${aliceMomo}`, { method: 'DELETE', expected: 409 });

    assert.equal(await runJob('compliance.payouts'), true);
    const paid = withdrawal(paidWithdrawal);
    assert.equal(paid.status, 'paid');
    assert.equal(paid.provider, 'simulator');
    assert.equal(paid.attempts, 1);
    assert.equal(paid.payout_reference, paidWithdrawal, 'the withdrawal id is the idempotent provider reference');
    assert.match(paid.provider_reference, /^simpo_/);
    assert.deepEqual(journalKinds(paidWithdrawal), ['withdrawal.requested', 'withdrawal.paid']);
    assert.equal(inFlight(), 0);
    assert.equal(available(alice.id), 95000);
    assert.ok(one<{ verified_at: string | null }>('SELECT verified_at FROM payout_methods WHERE id=?', aliceMomo)!.verified_at);
    assert.equal(notifications(alice.id, 'compliance.withdrawal_paid'), 1);
    await call(alice, `/compliance/withdrawals/${paidWithdrawal}/cancel`, { method: 'POST', body: {}, expected: 409 });
    const history = await call(alice, '/compliance/withdrawals', { expected: 200 });
    assert.equal(history.data.withdrawals[0].status, 'paid');
    assert.equal(history.data.withdrawals[0].can_cancel, false);
    assert.ok(ledgerIsBalanced());
  });

  await t.test('preconditions: email verification, balance, minimum, KYC threshold, limits', async () => {
    const carolMethod = await call(carol, '/compliance/payout-methods', { method: 'POST', body: momo('+237670000003'), expected: 201 });
    credit(bob.id, carol.id, 6000, 1000);
    const unverified = await call(carol, '/compliance/withdrawals', { method: 'POST', body: { amount_minor: 2000, payout_method_id: carolMethod.data.id }, expected: 403 });
    assert.match(unverified.data.error, /adresse e-mail/);

    const ginaMethod = await call(gina, '/compliance/payout-methods', { method: 'POST', body: momo('+237670000007'), expected: 201 });
    credit(bob.id, gina.id, 3000, 1000);
    const poor = await call(gina, '/compliance/withdrawals', { method: 'POST', body: { amount_minor: 5000, payout_method_id: ginaMethod.data.id }, expected: 409 });
    assert.match(poor.data.error, /Solde insuffisant/);
    assert.equal(one<{ count: number }>('SELECT COUNT(*) AS count FROM withdrawals WHERE user_id=?', gina.id)!.count, 0, 'nothing is written on failure');
    assert.equal(available(gina.id), 2000);
    await call(gina, '/compliance/withdrawals', { method: 'POST', body: { amount_minor: 2000, payout_method_id: aliceMomo }, expected: 404 });

    const erinMethod = await call(erin, '/compliance/payout-methods', { method: 'POST', body: momo('+237670000005'), expected: 201 });
    credit(bob.id, erin.id, 31000, 1000);
    const blocked = await call(erin, '/compliance/withdrawals', { method: 'POST', body: { amount_minor: 16000, payout_method_id: erinMethod.data.id }, expected: 403 });
    assert.match(blocked.data.error, /Vérification d’identité requise/);
    const small = await call(erin, '/compliance/withdrawals', { method: 'POST', body: { amount_minor: 10000, payout_method_id: erinMethod.data.id }, expected: 201 });
    assert.equal(small.data.status, expectedInitial(erin.id));
    const wallet = await call(erin, '/compliance/wallet', { expected: 200 });
    assert.equal(wallet.data.limits.without_kyc_remaining_minor, 5000);
    await call(erin, '/compliance/withdrawals', { method: 'POST', body: { amount_minor: 6000, payout_method_id: erinMethod.data.id }, expected: 403 });

    const settings = await call(admin, '/compliance/admin/settings', { expected: 200 });
    const limits = settings.data.limits.value;
    await call(admin, '/compliance/admin/settings/limits', { method: 'PUT', body: { ...limits, min_withdrawal_minor: 600000 }, expected: 400 });
    await call(admin, '/compliance/admin/settings/unknown', { method: 'PUT', body: {}, expected: 404 });
    const used = (await call(alice, '/compliance/wallet', { expected: 200 })).data.limits.daily_used_minor;
    assert.equal(used, 5000);
    await call(admin, '/compliance/admin/settings/limits', { method: 'PUT', body: { ...limits, daily_limit_minor: used + 2000 }, expected: 200 });
    assert.equal(audits('compliance.settings_updated'), 1);
    const daily = await call(alice, '/compliance/withdrawals', { method: 'POST', body: { amount_minor: 3000, payout_method_id: aliceMomo }, expected: 409 });
    assert.match(daily.data.error, /Plafond journalier/);
    await call(admin, '/compliance/admin/settings/limits', { method: 'PUT', body: { ...limits, monthly_limit_minor: used + 2000, daily_limit_minor: used + 2000 }, expected: 200 });
    const monthly = await call(alice, '/compliance/withdrawals', { method: 'POST', body: { amount_minor: 2500, payout_method_id: aliceMomo }, expected: 409 });
    assert.match(monthly.data.error, /Plafond (journalier|mensuel)/);
    await call(admin, '/compliance/admin/settings/limits', { method: 'PUT', body: limits, expected: 200 });
    assert.equal(available(alice.id), 95000);
  });

  await t.test('manual review: on_hold above the threshold, admin approval, rejection reverses funds, user cancel', async () => {
    const held = await call(alice, '/compliance/withdrawals', { method: 'POST', body: { amount_minor: 60000, payout_method_id: aliceMomo }, expected: 201 });
    assert.equal(held.data.status, 'on_hold');
    assert.equal(notifications(alice.id, 'compliance.withdrawal_on_hold') >= 1, true);
    assert.equal(available(alice.id), 35000);
    const queue = await call(admin, '/compliance/admin/withdrawals', { expected: 200 });
    const queued = queue.data.withdrawals.find((item: any) => item.id === held.data.id);
    assert.match(queued.hold_reason, /seuil de revue manuelle/);
    assert.equal(queued.kyc_status, 'approved');
    await call(alice, `/compliance/admin/withdrawals/${held.data.id}/reject`, { method: 'POST', body: { reason: 'Justificatif manquant' }, expected: 403 });
    const rejected = await call(admin2, `/compliance/admin/withdrawals/${held.data.id}/reject`, { method: 'POST', body: { reason: 'Justificatif d’origine des fonds manquant' }, expected: 200 });
    assert.equal(rejected.data.status, 'rejected');
    assert.equal(available(alice.id), 95000);
    assert.deepEqual(journalKinds(held.data.id), ['withdrawal.requested', 'withdrawal.rejected']);
    assert.equal(audits('compliance.withdrawal_rejected'), 1);
    assert.equal(notifications(alice.id, 'compliance.withdrawal_rejected'), 1);
    await call(admin, `/compliance/admin/withdrawals/${held.data.id}/approve`, { method: 'POST', body: {}, expected: 409 });
    const mine = await call(alice, '/compliance/withdrawals', { expected: 200 });
    assert.equal(mine.data.withdrawals.find((item: any) => item.id === held.data.id).review_note, 'Justificatif d’origine des fonds manquant');

    const second = await call(alice, '/compliance/withdrawals', { method: 'POST', body: { amount_minor: 55000, payout_method_id: aliceMomo }, expected: 201 });
    assert.equal(second.data.status, 'on_hold');
    await runJob('compliance.payouts');
    assert.equal(withdrawal(second.data.id).status, 'on_hold', 'held withdrawals are never paid by the job');
    const approved = await call(admin, `/compliance/admin/withdrawals/${second.data.id}/approve`, { method: 'POST', body: { note: 'Origine des fonds vérifiée' }, expected: 200 });
    assert.equal(approved.data.status, 'approved');
    assert.equal(audits('compliance.withdrawal_approved'), 1);
    await runJob('compliance.payouts');
    assert.equal(withdrawal(second.data.id).status, 'paid');
    assert.equal(available(alice.id), 40000);

    const third = await call(alice, '/compliance/withdrawals', { method: 'POST', body: { amount_minor: 3000, payout_method_id: aliceMomo }, expected: 201 });
    await call(bob, `/compliance/withdrawals/${third.data.id}/cancel`, { method: 'POST', body: {}, expected: 404 });
    const cancelled = await call(alice, `/compliance/withdrawals/${third.data.id}/cancel`, { method: 'POST', body: {}, expected: 200 });
    assert.equal(cancelled.data.status, 'cancelled');
    assert.deepEqual(journalKinds(third.data.id), ['withdrawal.requested', 'withdrawal.cancelled']);
    assert.equal(available(alice.id), 40000);
    await call(alice, `/compliance/withdrawals/${third.data.id}/cancel`, { method: 'POST', body: {}, expected: 409 });
    assert.equal(inFlight(), one<{ total: number }>("SELECT COALESCE(SUM(amount_base_minor),0) AS total FROM withdrawals WHERE status IN ('requested','on_hold','approved','processing')")!.total);
    assert.ok(ledgerIsBalanced());
  });

  await t.test('provider failures: retries with backoff, refund after the last attempt, unknown outcome held, pending re-checked', async () => {
    let behaviour: 'fail' | 'throw' | 'pending' = 'fail';
    const references: string[] = [];
    const outcomes = new Map<string, ProviderStatus>();
    registerProvider({
      id: 'test_failing' as never, label: 'Prestataire de test', countries: ['*'], currencies: ['EUR', 'XAF'], methods: ['mobile_money'],
      capabilities: { collect: false, payout: true, refund: false, webhooks: 'none' }, fields: [], docsUrl: 'https://example.test/docs',
      validateConfig: () => [],
      collect: async () => { throw new Error('collecte non prise en charge'); },
      status: async (_config, _kind, providerReference) => ({ status: outcomes.get(providerReference) ?? 'pending', providerReference }),
      payout: async (_config, request) => {
        references.push(request.reference);
        if (behaviour === 'throw') throw new Error('ECONNRESET');
        if (behaviour === 'pending') return { status: 'pending', providerReference: `tp_${request.reference}` };
        return { status: 'failed', providerReference: `tp_${request.reference}`, failureReason: 'Numéro de mobile money inconnu' };
      },
      verifyWebhook: async () => [],
    });
    saveProviderConfig('test_failing', MODE, { enabled: true, settings: {}, secrets: {} }, admin.id);
    await call(admin, '/compliance/admin/settings/payout_retry', { method: 'PUT', body: { max_attempts: 2, base_delay_seconds: 60, status_check_seconds: 60 }, expected: 200 });
    const method = await call(dave, '/compliance/payout-methods', { method: 'POST', body: momo('+237670000009', { provider: 'test_failing' }), expected: 201 });
    assert.equal(method.data.provider, 'test_failing');
    credit(bob.id, dave.id, 10000, 1000);

    // Declined twice: new reference per attempt, then failed with funds back.
    const first = await call(dave, '/compliance/withdrawals', { method: 'POST', body: { amount_minor: 3000, payout_method_id: method.data.id }, expected: 201 });
    if (first.data.status === 'on_hold') await call(admin, `/compliance/admin/withdrawals/${first.data.id}/approve`, { method: 'POST', body: {}, expected: 200 });
    await runJob('compliance.payouts');
    let row = withdrawal(first.data.id);
    assert.equal(row.status, 'approved');
    assert.equal(row.attempts, 1);
    assert.equal(row.failure_reason, 'Numéro de mobile money inconnu');
    assert.ok(Date.parse(row.next_attempt_at) > Date.now() + 30_000, 'backoff delay');
    await runJob('compliance.payouts');
    assert.equal(withdrawal(first.data.id).attempts, 1, 'no attempt before the backoff delay');
    await call(dave, `/compliance/admin/withdrawals/${first.data.id}/retry`, { method: 'POST', body: {}, expected: 403 });
    await call(admin, `/compliance/admin/withdrawals/${first.data.id}/retry`, { method: 'POST', body: {}, expected: 200 });
    await runJob('compliance.payouts');
    row = withdrawal(first.data.id);
    assert.equal(row.status, 'failed');
    assert.equal(row.attempts, 2);
    assert.deepEqual(references, [first.data.id, `${first.data.id}-r1`]);
    assert.deepEqual(journalKinds(first.data.id), ['withdrawal.requested', 'withdrawal.failed']);
    assert.equal(available(dave.id), 9000);
    assert.equal(notifications(dave.id, 'compliance.withdrawal_failed'), 1);
    await call(admin, `/compliance/admin/withdrawals/${first.data.id}/retry`, { method: 'POST', body: {}, expected: 409 });

    // Unknown outcome (network error): same reference, then held for reconciliation WITHOUT refund.
    behaviour = 'throw';
    references.length = 0;
    const second = await call(dave, '/compliance/withdrawals', { method: 'POST', body: { amount_minor: 3000, payout_method_id: method.data.id }, expected: 201 });
    if (second.data.status === 'on_hold') await call(admin, `/compliance/admin/withdrawals/${second.data.id}/approve`, { method: 'POST', body: {}, expected: 200 });
    await runJob('compliance.payouts');
    await call(admin, `/compliance/admin/withdrawals/${second.data.id}/retry`, { method: 'POST', body: {}, expected: 200 });
    await runJob('compliance.payouts');
    row = withdrawal(second.data.id);
    assert.equal(row.status, 'on_hold');
    assert.match(row.hold_reason, /inconnu/);
    assert.deepEqual(references, [second.data.id, second.data.id], 'unknown outcomes are retried with the same idempotent reference');
    assert.equal(available(dave.id), 6000, 'no refund while the provider outcome is unknown');
    await call(admin, `/compliance/admin/withdrawals/${second.data.id}/reject`, { method: 'POST', body: { reason: 'Versement non reçu selon le prestataire' }, expected: 200 });
    assert.equal(available(dave.id), 9000);

    // Pending payout: re-checked with status('payout') after a webhook hint.
    behaviour = 'pending';
    const third = await call(dave, '/compliance/withdrawals', { method: 'POST', body: { amount_minor: 3000, payout_method_id: method.data.id }, expected: 201 });
    if (third.data.status === 'on_hold') await call(admin, `/compliance/admin/withdrawals/${third.data.id}/approve`, { method: 'POST', body: {}, expected: 200 });
    await runJob('compliance.payouts');
    row = withdrawal(third.data.id);
    assert.equal(row.status, 'processing');
    assert.equal(row.provider_reference, `tp_${third.data.id}`);
    await call(dave, `/compliance/withdrawals/${third.data.id}/cancel`, { method: 'POST', body: {}, expected: 409 });
    await runJob('compliance.payouts');
    assert.equal(withdrawal(third.data.id).status, 'processing');
    outcomes.set(`tp_${third.data.id}`, 'succeeded');
    payoutWebhookHint(`tp_${third.data.id}`);
    await runJob('compliance.payouts');
    assert.equal(withdrawal(third.data.id).status, 'paid');
    assert.deepEqual(journalKinds(third.data.id), ['withdrawal.requested', 'withdrawal.paid']);
    assert.equal(available(dave.id), 6000);
    assert.equal(balance(ledgerAccounts.provider('test_failing'), MODE, EUR), 3000);

    // Payout webhooks (registered with payments/webhooks.ts): the payload is re-confirmed with provider.status().
    const fourth = await call(dave, '/compliance/withdrawals', { method: 'POST', body: { amount_minor: 3000, payout_method_id: method.data.id }, expected: 201 });
    if (fourth.data.status === 'on_hold') await call(admin, `/compliance/admin/withdrawals/${fourth.data.id}/approve`, { method: 'POST', body: {}, expected: 200 });
    await runJob('compliance.payouts');
    assert.equal(withdrawal(fourth.data.id).status, 'processing');
    await handlePayoutWebhook('test_failing', MODE, { type: 'payout', reference: fourth.data.id, status: 'succeeded' });
    assert.equal(withdrawal(fourth.data.id).status, 'processing', 'a webhook claiming success is not trusted while the provider says pending');
    outcomes.set(`tp_${fourth.data.id}`, 'succeeded');
    await handlePayoutWebhook('simulator', MODE, { type: 'payout', reference: fourth.data.id, status: 'succeeded' });
    await handlePayoutWebhook('test_failing', 'live', { type: 'payout', reference: fourth.data.id, status: 'succeeded' });
    assert.equal(withdrawal(fourth.data.id).status, 'processing', 'events from another provider or mode are ignored');
    await handlePayoutWebhook('test_failing', MODE, { type: 'payout', providerReference: `tp_${fourth.data.id}`, status: 'succeeded' });
    assert.equal(withdrawal(fourth.data.id).status, 'paid');
    assert.deepEqual(journalKinds(fourth.data.id), ['withdrawal.requested', 'withdrawal.paid']);
    assert.equal(available(dave.id), 3000);
    assert.equal(balance(ledgerAccounts.provider('test_failing'), MODE, EUR), 6000);

    await call(admin, '/compliance/admin/settings/payout_retry', { method: 'PUT', body: { max_attempts: 4, base_delay_seconds: 300, status_check_seconds: 300 }, expected: 200 });
    saveProviderConfig('test_failing', MODE, { enabled: false, settings: {}, secrets: {} }, admin.id);
    assert.ok(ledgerIsBalanced());
  });

  let aliceCommission = '';
  await t.test('invoices: issued once per journal, continuous sandbox numbering, VAT split, printable escaped HTML', async () => {
    await call(admin, '/compliance/admin/settings/tax', { method: 'PUT', body: { default_rate_bps: 2000, rates: { CM: 1925 }, prices_include_tax: true, exemption_mention: '' }, expected: 200 });
    await call(admin, '/compliance/admin/settings/issuer', {
      method: 'PUT', expected: 200,
      body: { legal_name: 'Alpha SAS', address: '1 avenue des Tests\n75001 Paris', registration_number: 'RCS Paris 123 456 789', vat_number: 'FR12123456789', legal_form: 'SAS au capital de 1 000 €', email: 'factures@alpha.test', footer: 'Pénalités de retard : 3 fois le taux légal.' },
    });
    assert.equal(await runJob('compliance.invoices'), true);
    const invoices = all<any>('SELECT * FROM invoices ORDER BY sequence');
    const kinds = (kind: string) => invoices.filter((invoice) => invoice.kind === kind).length;
    const journals = (kind: string) => one<{ count: number }>('SELECT COUNT(*) AS count FROM ledger_journals WHERE kind=?', kind)!.count;
    assert.equal(kinds('receipt'), journals('campaign.funded'));
    assert.equal(kinds('commission'), journals('mission.paid'));
    assert.equal(kinds('payout_statement'), journals('withdrawal.paid'));
    assert.deepEqual(invoices.map((invoice) => invoice.sequence), invoices.map((_invoice, index) => index + 1), 'no gap in the numbering');
    assert.equal(invoices[0].number, `ALPHA-SBX-${year}-000001`);
    assert.ok(invoices.every((invoice) => /^ALPHA-SBX-\d{4}-\d{6}$/.test(invoice.number) && invoice.series === 'sandbox'));
    assert.ok(invoices.filter((invoice) => invoice.kind === 'receipt').every((invoice) => invoice.user_id === bob.id), 'receipts go to the payer');

    const commission = invoices.find((invoice) => invoice.kind === 'commission' && invoice.user_id === alice.id);
    aliceCommission = commission.id;
    assert.equal(commission.tax_rate_bps, 1925);
    assert.deepEqual([commission.amount_net_minor, commission.amount_tax_minor, commission.amount_gross_minor], [839, 161, 1000]);
    assert.deepEqual(splitTax(1000, 2000, true), { net: 833, tax: 167 });
    assert.deepEqual(splitTax(1000, 2000, false), { net: 1000, tax: 200 });
    const erinCommission = invoices.find((invoice) => invoice.kind === 'commission' && invoice.user_id === erin.id);
    assert.equal(erinCommission.tax_rate_bps, 2000, 'default rate without a verified country');

    await runJob('compliance.invoices');
    assert.equal(one<{ count: number }>('SELECT COUNT(*) AS count FROM invoices')!.count, invoices.length, 'the job is idempotent');
    assert.throws(() => run("UPDATE invoices SET amount_net_minor=0 WHERE id=?", commission.id), /immutable|immuable/i);
    assert.throws(() => run('DELETE FROM invoices WHERE id=?', commission.id), /immutable|immuable/i);
    credit(bob.id, alice.id, 2000, 200);
    await runJob('compliance.invoices');
    const after = all<{ sequence: number }>('SELECT sequence FROM invoices ORDER BY sequence');
    assert.deepEqual(after.map((invoice) => invoice.sequence), after.map((_invoice, index) => index + 1));
    assert.equal(after.length, invoices.length + 2, 'new journals produce new documents');

    const mine = await call(alice, '/compliance/invoices', { expected: 200 });
    assert.ok(mine.data.invoices.every((invoice: any) => invoice.html_url.startsWith('/api/compliance/invoices/')));
    assert.ok(mine.data.invoices.some((invoice: any) => invoice.kind === 'payout_statement'));
    assert.ok(!mine.data.invoices.some((invoice: any) => invoice.kind === 'receipt'));
    const html = await call(alice, `/compliance/invoices/${commission.id}/html`, { expected: 200 });
    assert.match(html.response.headers.get('content-type') ?? '', /text\/html/);
    assert.match(html.response.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    assert.ok(html.text.includes(commission.number));
    assert.ok(html.text.includes('SPÉCIMEN'));
    assert.ok(html.text.includes('Alpha SAS') && html.text.includes('FR12123456789'));
    assert.ok(html.text.includes('Alice &lt;img src=x onerror=alert(1)&gt; Martin'), 'customer name is escaped');
    assert.ok(!/<script|onerror=alert/i.test(html.text.replace(/&lt;img src=x onerror=alert\(1\)&gt;/g, '')), 'no active content');
    await call(bob, `/compliance/invoices/${commission.id}/html`, { expected: 404 });
    await call(null, `/compliance/invoices/${commission.id}/html`, { expected: 401 });
    await call(admin, `/compliance/invoices/${commission.id}/html`, { expected: 200 });
    assert.equal(audits('compliance.invoice_viewed'), 1);
    const adminList = await call(admin, `/compliance/admin/invoices?from=${today}&to=${today}&kind=commission`, { expected: 200 });
    assert.ok(adminList.data.total >= 4);
    assert.ok(adminList.data.invoices.every((invoice: any) => invoice.kind === 'commission'));
  });

  await t.test('accounting CSV export is admin-only, audited and safe against formula injection', async () => {
    postJournal({
      idempotencyKey: 'adjustment:csv-injection', kind: 'adjustment', mode: MODE, currency: EUR, refType: 'admin', refId: 'csv-injection',
      memo: '=HYPERLINK("http://evil.test","clic")', actorId: admin.id,
      legs: [{ account: ledgerAccounts.adjustments(), amountMinor: -1 }, { account: ledgerAccounts.platformFees(), amountMinor: 1 }],
    });
    assert.equal(csvCell('@SUM(A1)'), `"'@SUM(A1)"`);
    assert.equal(csvCell('-2+3'), `"'-2+3"`);
    assert.equal(csvCell(-42), '-42');
    assert.equal(csvCell('a"b'), '"a""b"');
    await call(admin, `/compliance/admin/exports/journals.csv?from=${today}`, { expected: 400 });
    await call(admin, '/compliance/admin/exports/journals.csv?from=2020-01-01&to=2022-01-01', { expected: 400 });
    await call(admin, `/compliance/admin/exports/journals.csv?from=${today}&to=2020-01-01`, { expected: 400 });
    const csv = await call(admin, `/compliance/admin/exports/journals.csv?from=${today}&to=${today}&mode=sandbox`, { expected: 200 });
    assert.match(csv.response.headers.get('content-type') ?? '', /text\/csv/);
    assert.match(csv.response.headers.get('content-disposition') ?? '', /attachment; filename="alpha-journaux-/);
    const lines = csv.text.replace(/^\ufeff/, '').trim().split('\r\n');
    assert.equal(lines[0], '"journal_id";"date";"type";"mode";"devise";"ref_type";"ref_id";"libelle";"compte";"montant_minor";"documents"');
    assert.ok(csv.text.includes(`"'=HYPERLINK(""http://evil.test"",""clic"")"`));
    assert.ok(!lines.some((line) => line.split(';').some((cell) => /^"?[=+@]/.test(cell))), 'no cell starts with a formula');
    assert.ok(lines.some((line) => line.includes('ALPHA-SBX-')), 'invoice numbers are cross-referenced');
    assert.equal(lines.length - 1, one<{ count: number }>("SELECT COUNT(*) AS count FROM ledger_entries WHERE mode='sandbox'")!.count);
    assert.equal(audits('compliance.journals_exported'), 1);
    const comma = await call(admin, `/compliance/admin/exports/journals.csv?from=${today}&to=${today}&sep=comma`, { expected: 200 });
    assert.ok(comma.text.replace(/^\ufeff/, '').startsWith('"journal_id","date"'));
  });

  await t.test('admin summary and personal data: export without secrets, erasure keeps accounting records', async () => {
    const summary = await call(admin, '/compliance/admin/summary', { expected: 200 });
    assert.equal(summary.data.mode, MODE);
    assert.deepEqual(summary.data.issuer_problems, []);
    assert.equal(summary.data.invoices_blocked, false);

    const handler = personalDataHandlers().find(([name]) => name === 'compliance')?.[1];
    assert.ok(handler, 'compliance registers a GDPR handler');
    const exported = JSON.stringify(handler.export(alice.id));
    assert.ok(exported.includes('MTN MoMo ••••0001'));
    assert.ok(!exported.includes('670000001') && !exported.includes('details_sealed') && !exported.includes('address_sealed'));
    assert.ok(exported.includes('rue de la Paix'), 'the user receives their own address');
    const before = {
      withdrawals: one<{ count: number }>('SELECT COUNT(*) AS count FROM withdrawals WHERE user_id=?', alice.id)!.count,
      invoices: one<{ count: number }>('SELECT COUNT(*) AS count FROM invoices WHERE user_id=?', alice.id)!.count,
    };
    transaction(() => handler.erase(alice.id));
    const profile = one<any>('SELECT * FROM kyc_profiles WHERE user_id=?', alice.id);
    assert.deepEqual([profile.legal_name, profile.country, profile.date_of_birth, profile.address_sealed, profile.document_file_ids], ['', null, null, null, '[]']);
    assert.ok(all<{ details_sealed: string; display_mask: string }>('SELECT details_sealed,display_mask FROM payout_methods WHERE user_id=?', alice.id)
      .every((method) => method.details_sealed === '' && method.display_mask === '••••'));
    assert.equal(one<{ count: number }>('SELECT COUNT(*) AS count FROM withdrawals WHERE user_id=?', alice.id)!.count, before.withdrawals);
    assert.equal(one<{ count: number }>('SELECT COUNT(*) AS count FROM invoices WHERE user_id=?', alice.id)!.count, before.invoices);
    assert.ok(JSON.parse(one<{ customer_snapshot: string }>('SELECT customer_snapshot FROM invoices WHERE id=?', aliceCommission)!.customer_snapshot).name.includes('Alice'),
      'issued invoices are immutable legal records');
    assert.ok(ledgerIsBalanced());
  });
});
