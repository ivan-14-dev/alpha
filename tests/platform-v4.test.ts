import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { z } from 'zod';

process.env.DATABASE_PATH = ':memory:';
const { app } = await import('../server/app.js');
const { db, one, run, transaction, onCommit } = await import('../server/db.js');
const { afterCommit } = await import('../server/platform/events.js');
const { seal, unseal, sealBuffer, unsealBuffer, maskSecret, safeEqual } = await import('../server/platform/secrets.js');
const { getSetting, setSetting, getSecretSetting, setSecretSetting, hasSecretSetting } = await import('../server/platform/settings.js');
const { postJournal, balance, ledgerAccounts, ledgerIsBalanced } = await import('../server/payments/ledger.js');
const { fromBase, toBase } = await import('../server/payments/mode.js');
const { hit } = await import('../server/platform/rateLimit.js');
const { queueEmail, deliverQueuedEmails, setMailTransportForTests, renderEmail } = await import('../server/platform/mailer.js');
const { registerJob, runJob, listJobs } = await import('../server/platform/jobs.js');
const { recordLegalAcceptance, pendingRequiredDocuments } = await import('../server/platform/legal.js');
const { latestSchemaVersion } = await import('../server/migrations.js');
const { readProviderConfig, describeProviderConfig, saveProviderConfig, enabledProviders, activeEnvironment } = await import('../server/payments/config.js');

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('V4 platform foundation', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  run("INSERT INTO users(id,name,email,password_hash) VALUES ('admin-v4','Admin','admin-v4@example.test','x')");

  await t.test('schema is fully migrated and health reports version and payment mode', async () => {
    assert.equal(one<{ version: number }>('SELECT MAX(version) AS version FROM schema_migrations')!.version, latestSchemaVersion);
    const response = await fetch(`${base}/health`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('x-request-id') ?? '', /^[a-f0-9-]{36}$/);
    assert.deepEqual(await response.json(), { status: 'ok', version: '0.4.0', payment_mode: 'demo' });
  });

  await t.test('webhook paths bypass the browser CSRF header but other mutations still require it', async () => {
    const webhook = await fetch(`${base}/payments/webhooks/unknown-provider`, { method: 'POST', body: 'raw', headers: { 'content-type': 'text/plain' } });
    assert.notEqual(webhook.status, 403);
    const blocked = await fetch(`${base}/auth/logout`, { method: 'POST' });
    assert.equal(blocked.status, 403);
  });

  await t.test('secrets are authenticated-encrypted and bound to their context', () => {
    const sealed = seal('sk_test_123', 'setting:a');
    assert.ok(sealed.startsWith('v1.'));
    assert.ok(!sealed.includes('sk_test_123'));
    assert.equal(unseal(sealed, 'setting:a'), 'sk_test_123');
    assert.throws(() => unseal(sealed, 'setting:b'));
    const tampered = sealed.slice(0, -2) + (sealed.endsWith('A') ? 'B' : 'A') + sealed.slice(-1);
    assert.throws(() => unseal(tampered, 'setting:a'));
    const buffer = sealBuffer(Buffer.from('fichier privé'), 'file:1');
    assert.equal(unsealBuffer(buffer, 'file:1').toString(), 'fichier privé');
    assert.throws(() => unsealBuffer(buffer, 'file:2'));
    assert.equal(maskSecret('sk_live_abcdefgh'), maskSecret('sk_live_abcdefgh'));
    assert.ok(!maskSecret('sk_live_abcdefgh').includes('abcdefgh'));
    assert.ok(safeEqual('abc', 'abc'));
    assert.ok(!safeEqual('abc', 'abd'));
  });

  await t.test('settings validate on read and secret settings are sealed at rest', () => {
    const schema = z.object({ enabled: z.boolean() });
    assert.deepEqual(getSetting('test.flag', schema, { enabled: false }), { enabled: false });
    setSetting('test.flag', { enabled: true }, 'admin-v4');
    assert.deepEqual(getSetting('test.flag', schema, { enabled: false }), { enabled: true });
    setSetting('test.flag', { enabled: 'yes' }, 'admin-v4');
    assert.deepEqual(getSetting('test.flag', schema, { enabled: false }), { enabled: false });
    setSecretSetting('test.secret', 'top-secret-value', 'admin-v4');
    assert.ok(hasSecretSetting('test.secret'));
    assert.equal(getSecretSetting('test.secret'), 'top-secret-value');
    const stored = one<{ value: string; secret: string | null }>("SELECT value,secret FROM platform_settings WHERE key='test.secret'")!;
    assert.ok(!JSON.stringify(stored).includes('top-secret-value'));
    setSecretSetting('test.secret', null, 'admin-v4');
    assert.equal(getSecretSetting('test.secret'), null);
  });

  await t.test('nested transactions use savepoints and afterCommit only runs after the outer COMMIT', async () => {
    const ran: string[] = [];
    transaction(() => {
      run("INSERT INTO platform_settings(key,value) VALUES ('nest.outer','1')");
      afterCommit(() => { ran.push('outer'); });
      assert.throws(() => transaction(() => {
        run("INSERT INTO platform_settings(key,value) VALUES ('nest.inner','1')");
        afterCommit(() => { ran.push('discarded'); });
        throw new Error('inner failure');
      }), /inner failure/);
      transaction(() => { onCommit(() => ran.push('inner-kept')); });
      assert.deepEqual(ran, []);
    });
    await tick();
    assert.equal(one<{ key: string }>("SELECT key FROM platform_settings WHERE key='nest.outer'")?.key, 'nest.outer');
    assert.equal(one("SELECT key FROM platform_settings WHERE key='nest.inner'"), undefined);
    assert.deepEqual(ran.sort(), ['inner-kept', 'outer']);
    assert.throws(() => transaction(() => { afterCommit(() => { ran.push('rolled-back'); }); throw new Error('outer failure'); }));
    await tick();
    assert.ok(!ran.includes('rolled-back'));
    assert.throws(() => transaction((() => Promise.resolve()) as () => unknown), /synchrone/);
  });

  await t.test('ledger journals balance, are idempotent, immutable and guard negative balances', () => {
    const escrow = ledgerAccounts.campaignEscrow('c1');
    const provider = ledgerAccounts.provider('simulator');
    const tester = ledgerAccounts.userAvailable('admin-v4');
    const first = postJournal({ idempotencyKey: 'fund:c1', kind: 'campaign.funded', mode: 'sandbox', currency: 'EUR', refType: 'campaign', refId: 'c1',
      legs: [{ account: provider, amountMinor: -5000 }, { account: escrow, amountMinor: 5000 }] });
    assert.ok(first.created);
    const again = postJournal({ idempotencyKey: 'fund:c1', kind: 'campaign.funded', mode: 'sandbox', currency: 'EUR', refType: 'campaign', refId: 'c1',
      legs: [{ account: provider, amountMinor: -5000 }, { account: escrow, amountMinor: 5000 }] });
    assert.deepEqual(again, { journalId: first.journalId, created: false });
    assert.equal(balance(escrow, 'sandbox', 'EUR'), 5000);
    assert.equal(balance(escrow, 'live', 'EUR'), 0);
    assert.throws(() => postJournal({ idempotencyKey: 'unbalanced', kind: 'x', mode: 'sandbox', currency: 'EUR', refType: 'x', refId: 'x',
      legs: [{ account: provider, amountMinor: -1 }, { account: escrow, amountMinor: 2 }] }), /equilibree/);
    assert.throws(() => postJournal({ idempotencyKey: 'overdraw', kind: 'mission.paid', mode: 'sandbox', currency: 'EUR', refType: 'mission', refId: 'm1',
      legs: [{ account: escrow, amountMinor: -6000 }, { account: tester, amountMinor: 6000 }], nonNegative: [escrow] }), /Solde insuffisant/);
    assert.equal(balance(tester, 'sandbox', 'EUR'), 0);
    assert.equal(one<{ count: number }>("SELECT COUNT(*) AS count FROM ledger_journals WHERE idempotency_key='overdraw'")!.count, 0);
    assert.throws(() => run('UPDATE ledger_entries SET amount_minor=1'), /immuable|immutable|interdit/i);
    assert.throws(() => run('DELETE FROM ledger_journals'), /immuable|immutable|interdit/i);
    assert.ok(ledgerIsBalanced());
  });

  await t.test('FX conversions never favour the platform user against escrow', () => {
    assert.equal(fromBase(1000, 'XAF'), 6560);
    assert.equal(toBase(6560, 'XAF'), 1000);
    assert.equal(fromBase(1234, 'EUR'), 1234);
  });

  await t.test('durable rate limiter counts per hashed key and resets after its window', async () => {
    assert.equal(hit('login:1.2.3.4', 2, 60000).allowed, true);
    assert.equal(hit('login:1.2.3.4', 2, 60000).allowed, true);
    assert.equal(hit('login:1.2.3.4', 2, 60000).allowed, false);
    assert.equal(one<{ count: number }>("SELECT COUNT(*) AS count FROM rate_limit_buckets WHERE key LIKE '%1.2.3.4%'")!.count, 0);
    assert.equal(hit('short-window', 1, 1).allowed, true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(hit('short-window', 1, 1).allowed, true);
  });

  await t.test('email outbox only sends committed messages, retries failures and redacts sensitive bodies', async () => {
    assert.throws(() => transaction(() => {
      queueEmail({ to: 'rolled@example.test', category: 'test', subject: 'rolled back', text: 'never' });
      throw new Error('rollback');
    }));
    const email = renderEmail({ title: 'Réinitialisez <votre> mot de passe', paragraphs: ['Bonjour'], action: { label: 'Ouvrir', url: '/reset-password?token=abc' } });
    assert.ok(email.html.includes('&lt;votre&gt;'));
    assert.match(email.text, /http:\/\/127\.0\.0\.1:5173\/reset-password\?token=abc/);
    const okId = queueEmail({ to: 'ok@example.test', category: 'account.reset', subject: 'Reset', text: email.text, html: email.html, sensitive: true });
    const failId = queueEmail({ to: 'fail@example.test', category: 'test', subject: 'Fail', text: 'body' });
    const sent: string[] = [];
    setMailTransportForTests({ sendMail: (async (message: { to: string }) => {
      if (message.to === 'fail@example.test') throw new Error('SMTP down');
      sent.push(message.to);
      return {};
    }) as never });
    try {
      const result = await deliverQueuedEmails();
      assert.deepEqual(result, { sent: 1, failed: 1, logged: 0 });
    } finally { setMailTransportForTests(null); }
    assert.deepEqual(sent, ['ok@example.test']);
    const ok = one<{ status: string; text_body: string; html_body: string | null }>('SELECT status,text_body,html_body FROM email_outbox WHERE id=?', okId)!;
    assert.equal(ok.status, 'sent');
    assert.ok(!ok.text_body.includes('token=abc'));
    assert.equal(ok.html_body, null);
    const failed = one<{ status: string; attempts: number; last_error: string; send_after: string }>('SELECT status,attempts,last_error,send_after FROM email_outbox WHERE id=?', failId)!;
    assert.equal(failed.status, 'queued');
    assert.equal(failed.attempts, 1);
    assert.match(failed.last_error, /SMTP down/);
    assert.ok(Date.parse(failed.send_after) > Date.now());
    assert.equal(one<{ count: number }>("SELECT COUNT(*) AS count FROM email_outbox WHERE to_address='rolled@example.test'")!.count, 0);
  });

  await t.test('jobs record runs and failures without overlapping', async () => {
    let calls = 0;
    registerJob({ name: 'test.job', description: 'test', intervalMs: 1000, run: async () => { calls += 1; await tick(); if (calls === 2) throw new Error('boom'); } });
    const [first, overlapping] = await Promise.all([runJob('test.job'), runJob('test.job')]);
    assert.equal(first, true);
    assert.equal(overlapping, false);
    await assert.rejects(runJob('test.job'), /boom/);
    const job = listJobs().find((item) => item.name === 'test.job')!;
    assert.equal(job.runs, 2);
    assert.equal(job.failures, 1);
    assert.equal(job.last_status, 'failed');
  });

  await t.test('provider configs are per environment, secrets stay sealed and invalid configs cannot be enabled', () => {
    assert.equal(activeEnvironment(), null);
    assert.deepEqual(enabledProviders(), []);
    assert.equal(readProviderConfig('simulator', 'sandbox')?.id, 'simulator');
    assert.equal(readProviderConfig('simulator', 'live'), null);
    assert.throws(() => saveProviderConfig('simulator', 'live', { enabled: true, settings: { currency: 'EUR' }, secrets: {} }, 'admin-v4'), /simulateur/);
    assert.throws(() => saveProviderConfig('simulator', 'sandbox', { enabled: true, settings: { unknown: 'x' }, secrets: {} }, 'admin-v4'), /Champ inconnu/);
    assert.throws(() => saveProviderConfig('simulator', 'sandbox', { enabled: true, settings: { webhook_secret: 'x' }, secrets: {} }, 'admin-v4'), /secrets/);
    assert.throws(() => saveProviderConfig('simulator', 'sandbox', { enabled: true, settings: { currency: 'GBP' }, secrets: {} }, 'admin-v4'), /non autorisée/);
    assert.throws(() => saveProviderConfig('simulator', 'sandbox', { enabled: true, settings: {}, secrets: {} }, 'admin-v4'), /requis/);
    const saved = saveProviderConfig('simulator', 'sandbox', { enabled: true, settings: { currency: 'XAF' }, secrets: { webhook_secret: 'whsec_simulator_123456' } }, 'admin-v4');
    assert.equal(saved.secrets.webhook_secret.configured, true);
    assert.ok(!JSON.stringify(saved).includes('whsec_simulator_123456'));
    assert.match(saved.webhook_url, /\/api\/payments\/webhooks\/simulator$/);
    assert.equal(readProviderConfig('simulator', 'sandbox')!.secrets.webhook_secret, 'whsec_simulator_123456');
    saveProviderConfig('simulator', 'sandbox', { enabled: true, settings: { currency: 'XAF' }, secrets: { webhook_secret: undefined } }, 'admin-v4');
    assert.equal(readProviderConfig('simulator', 'sandbox')!.secrets.webhook_secret, 'whsec_simulator_123456');
    saveProviderConfig('simulator', 'sandbox', { enabled: false, settings: { currency: 'XAF' }, secrets: { webhook_secret: null } }, 'admin-v4');
    assert.equal(readProviderConfig('simulator', 'sandbox'), null);
    assert.equal(describeProviderConfig('simulator', 'sandbox').secrets.webhook_secret.configured, false);
    setSetting('payments.mode', 'sandbox', 'admin-v4');
    try {
      assert.equal(activeEnvironment(), 'sandbox');
      assert.deepEqual(enabledProviders(), []);
      saveProviderConfig('simulator', 'sandbox', { enabled: true, settings: { currency: 'XAF' }, secrets: {} }, 'admin-v4');
      assert.deepEqual(enabledProviders({ currency: 'XAF', method: 'mobile_money' }).map((provider) => provider.id), ['simulator']);
      assert.deepEqual(enabledProviders({ currency: 'GBP' }), []);
    } finally { setSetting('payments.mode', 'demo', 'admin-v4'); }
  });

  await t.test('legal acceptances are versioned and idempotent', () => {
    assert.deepEqual(pendingRequiredDocuments('admin-v4').sort(), ['privacy', 'terms']);
    recordLegalAcceptance('admin-v4', ['terms', 'privacy']);
    recordLegalAcceptance('admin-v4', ['terms']);
    assert.deepEqual(pendingRequiredDocuments('admin-v4'), []);
  });

  db.exec('PRAGMA foreign_key_check');
});
