import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

process.env.DATABASE_PATH = ':memory:';
// One reverse proxy: X-Forwarded-For carries the (test) client address, so public/private IP scopes can be exercised.
process.env.TRUST_PROXY = '1';
const { app } = await import('../server/app.js');
const { all, one, run } = await import('../server/db.js');
const { id: newId } = await import('../server/core.js');
const { accountRestriction, capabilityForPath, recordSignal, riskLevel } = await import('../server/platform/guards.js');
const { runJob } = await import('../server/platform/jobs.js');
const { personalDataHandlers } = await import('../server/platform/privacy.js');
const { setEscrowAdapterForTests } = await import('../server/trust/disputes.js');

const password = 'Trust-v4-password-2026!';
const userAgent = 'AlphaTrustTest/4.0 (raw-agent-marker)';

interface Actor { id: string; name: string; email: string; jar: Map<string, string>; device?: string; ip?: string }
type Json = Record<string, any>;
interface CaseRow { id: string; user_id: string; kind: string; score: number; status: string; dedupe_key: string; evidence: string; related_user_ids: string; detections: number }

test('V4 trust: signals, detectors, sanctions, appeals, administration and escrow disputes', { timeout: 180000 }, async (t) => {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  t.after(async () => {
    setEscrowAdapterForTests(null);
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  });

  const resetLimits = () => run('DELETE FROM rate_limit_buckets');
  let counter = 0;
  const actor = (name: string, network: { device?: string; ip?: string } = {}): Actor => {
    counter += 1;
    return { id: '', name, email: `${name.toLowerCase().replace(/[^a-z0-9]/g, '')}.${counter}@trust.test`, jar: new Map(), ...network };
  };
  async function call<T = Json>(who: Actor | null, path: string, options: { method?: string; body?: unknown; expected?: number } = {}) {
    const method = options.method ?? 'GET';
    const expected = options.expected ?? 200;
    const headers = new Headers({ 'X-Alpha-Client': 'web', 'User-Agent': userAgent });
    if (options.body !== undefined) headers.set('Content-Type', 'application/json');
    if (who?.device) headers.set('X-Alpha-Device', who.device);
    if (who?.ip) headers.set('X-Forwarded-For', who.ip);
    if (who?.jar.size) headers.set('Cookie', [...who.jar].map(([name, value]) => `${name}=${value}`).join('; '));
    const response = await fetch(`${base}${path}`, { method, headers, redirect: 'manual', ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
    const text = await response.text();
    assert.equal(response.status, expected, `${method} ${path}: ${text}`);
    if (who) {
      for (const cookie of response.headers.getSetCookie()) {
        const [pair] = cookie.split(';');
        const index = pair.indexOf('=');
        const name = pair.slice(0, index);
        const value = pair.slice(index + 1);
        if (!value || /Max-Age=0(;|$)/.test(cookie)) who.jar.delete(name); else who.jar.set(name, value);
      }
    }
    const data = (text && response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : {}) as T;
    if (expected >= 400) assert.equal(typeof (data as Json).error, 'string', `${method} ${path} must return a JSON error`);
    return data;
  }
  async function register(who: Actor) {
    resetLimits();
    const data = await call<{ user: { id: string } }>(who, '/auth/register', { method: 'POST', expected: 201, body: { name: who.name, email: who.email, password, accept_terms: true } });
    who.id = data.user.id;
    return who;
  }
  const member = async (name: string, network: { device?: string; ip?: string } = {}) => register(actor(name, network));
  const sessionCount = (userId: string) => one<{ count: number }>('SELECT COUNT(*) AS count FROM sessions WHERE user_id=?', userId)!.count;
  const casesFor = (kind: string, dedupeKey?: string) => all<CaseRow>(
    `SELECT * FROM risk_cases WHERE kind=? ${dedupeKey ? 'AND dedupe_key=?' : ''} ORDER BY created_at`, kind, ...(dedupeKey ? [dedupeKey] : []));
  const subjectsOf = (caseId: string) => all<{ user_id: string; role: string }>('SELECT user_id,role FROM risk_case_subjects WHERE case_id=? ORDER BY role DESC', caseId);
  const detect = async () => { assert.equal(await runJob('trust.detect'), true); };
  const directSanction = (userId: string, kind: string, capabilities: string[], options: { appealable?: number; startsAt?: string; endsAt?: string | null; revoked?: boolean } = {}) => {
    const sanctionId = newId();
    const startsAt = options.startsAt ?? new Date(Date.now() - 1000).toISOString();
    run(`INSERT INTO sanctions(id,user_id,kind,capabilities,public_reason,starts_at,ends_at,appealable,revoked_at,revoked_reason,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`, sanctionId, userId, kind, JSON.stringify(capabilities), 'Motif public de test suffisamment détaillé.',
    startsAt, options.endsAt ?? null, options.appealable ?? 1, options.revoked ? new Date().toISOString() : null, options.revoked ? 'Levée de test.' : '', startsAt);
    return sanctionId;
  };
  const projectBody = (title: string) => ({ title, summary: 'Un projet de test pour la matrice des restrictions.', category: 'developer-tools', visibility: 'public' });
  const listingBody = (title: string) => ({
    title, description: 'Un composant réutilisable avec une navigation clavier accessible.', kind: 'component', price_cents: 4900,
    license: 'Licence non exclusive pour un projet commercial.', deliverables: 'Archive du code source et documentation complète.',
  });
  const statement = 'Je conteste cette décision : les faits décrits ne correspondent pas à mon usage réel du compte.';

  const admin = await member('Admin Trust', { device: 'admin-device-0001' });
  run("UPDATE users SET role='admin' WHERE id=?", admin.id);

  await t.test('capability mapping and self-service allowlist', () => {
    const allowed = [
      '/api/auth/logout', '/api/auth/login', '/api/trust/appeals', '/api/trust/me/restrictions', '/api/privacy/export',
      '/api/payments/webhooks/stripe', '/api/integrations/webhooks/github', '/api/communication/notifications/read-all',
      '/api/communication/conversations/abc/read',
    ];
    for (const path of allowed) assert.equal(capabilityForPath(path), 'allow', path);
    const mapped: [string, string][] = [
      ['/api/projects', 'publish'], ['/api/projects/p1/updates', 'publish'], ['/api/community/posts', 'publish'], ['/api/workspace/boards', 'publish'],
      ['/api/communication/conversations', 'message'], ['/api/marketplace/listings', 'trade'], ['/api/marketplace/listings/l1/buy', 'trade'],
      ['/api/payments/checkout', 'money'], ['/api/compliance/withdrawals', 'withdraw'], ['/api/compliance/payout-methods', 'withdraw'],
      ['/api/compliance/kyc', 'money'], ['/api/reputation/reviews', 'review'], ['/api/testing/campaigns', 'test'], ['/api/sandbox/runs', 'test'],
    ];
    for (const [path, capability] of mapped) assert.equal(capabilityForPath(path), capability, path);
    // Redress mechanisms and admin tools are never covered by a member capability; unknown prefixes need a suspension/ban.
    for (const path of ['/api/marketplace/orders/o1/dispute', '/api/testing/missions/m1/dispute', '/api/trust/reports', '/api/marketplace/admin/listings', '/api/unknown', '/api/projectsx']) {
      assert.equal(capabilityForPath(path), null, path);
    }
  });

  await t.test('signals store keyed hashes only and never throw', async () => {
    const hashy = await member('Hashy Signal', { device: 'raw-device-marker-42', ip: '203.0.113.7' });
    const rows = all<Json>('SELECT * FROM risk_signals WHERE user_id=?', hashy.id);
    const registration = rows.find((row) => row.kind === 'register');
    assert.ok(registration, 'registration signal recorded');
    assert.equal(registration.ip_scope, 'public');
    for (const column of ['ip_hash', 'device_hash', 'ua_hash']) assert.match(String(registration[column]), /^[0-9a-f]{64}$/, column);
    const dump = JSON.stringify(all('SELECT * FROM risk_signals'));
    for (const raw of ['203.0.113.7', 'raw-device-marker-42', 'raw-agent-marker', hashy.email]) assert.ok(!dump.includes(raw), `raw value leaked: ${raw}`);

    // Same device → same hash (linkable), different purposes → unrelated hashes.
    const twin = await member('Hashy Twin', { device: 'raw-device-marker-42', ip: '10.20.30.40' });
    const twinSignal = one<Json>("SELECT * FROM risk_signals WHERE user_id=? AND kind='register'", twin.id)!;
    assert.equal(twinSignal.device_hash, registration.device_hash);
    assert.equal(twinSignal.ip_scope, 'private', 'RFC 1918 addresses are flagged and never used alone for IP matching');
    assert.notEqual(twinSignal.ip_hash, registration.ip_hash);

    recordSignal(null, hashy.id, 'payment', {
      status: 'failed', amount_cents: 1200, provider: 'stripe', email: 'leak@example.test', note: 'texte libre', ip_address: '198.51.100.9',
      reference: '203.0.113.99', phone_number: '+33612345678', description: 'Un texte libre avec espaces',
    });
    const meta = JSON.parse(one<{ meta: string }>("SELECT meta FROM risk_signals WHERE user_id=? AND kind='payment'", hashy.id)!.meta);
    assert.deepEqual(meta, { status: 'failed', amount_cents: 1200, provider: 'stripe' });
    assert.doesNotThrow(() => recordSignal(null, 'missing-user-id', 'login', {}));
    assert.doesNotThrow(() => recordSignal(null, hashy.id, 'x' as never, {}));
    assert.equal(one<{ count: number }>("SELECT COUNT(*) AS count FROM risk_signals WHERE user_id='missing-user-id'")!.count, 0);
  });

  await t.test('multi-account detection on shared devices and registration bursts, with dedupe', async () => {
    const first = await member('Multi One', { device: 'shared-device-0001', ip: '203.0.113.21' });
    assert.equal(casesFor('multi_account').filter((row) => subjectsOf(row.id).some((s) => s.user_id === first.id)).length, 0);
    const second = await member('Multi Two', { device: 'shared-device-0001', ip: '203.0.113.22' });
    const deviceHash = one<{ device_hash: string }>("SELECT device_hash FROM risk_signals WHERE user_id=? AND kind='register'", second.id)!.device_hash;
    const key = `multi_account:device:${deviceHash}`;
    // Inline detection opened the case as soon as the second account appeared.
    let cases = casesFor('multi_account', key);
    assert.equal(cases.length, 1);
    assert.equal(cases[0].user_id, second.id, 'the newest account is the primary subject');
    assert.equal(cases[0].score, 55);
    assert.deepEqual(subjectsOf(cases[0].id).map((s) => s.user_id).sort(), [first.id, second.id].sort());
    const evidence = JSON.parse(cases[0].evidence);
    assert.equal(evidence.pattern, 'shared_device');
    assert.ok(!cases[0].evidence.includes(deviceHash), 'evidence only keeps a truncated hash');

    await detect();
    await detect();
    cases = casesFor('multi_account', key);
    assert.equal(cases.length, 1, 'idempotent detector (dedupe key)');

    const third = await member('Multi Three', { device: 'shared-device-0001', ip: '203.0.113.23' });
    await detect();
    cases = casesFor('multi_account', key);
    assert.equal(cases.length, 1);
    assert.equal(cases[0].score, 70);
    assert.equal(subjectsOf(cases[0].id).length, 3);
    assert.equal(riskLevel(third.id), 'high');
    assert.equal(riskLevel(first.id), 'high', 'related subjects share the case risk');

    const burst: Actor[] = [];
    for (let index = 0; index < 5; index += 1) burst.push(await member(`Burst ${index}`, { device: `burst-device-000${index}`, ip: '198.51.100.77' }));
    await detect();
    const ipCases = all<CaseRow>("SELECT * FROM risk_cases WHERE kind='multi_account' AND dedupe_key LIKE 'multi_account:ip:%'");
    assert.equal(ipCases.length, 1);
    assert.equal(subjectsOf(ipCases[0].id).length, 5);
    assert.equal(JSON.parse(ipCases[0].evidence).pattern, 'ip_registrations');
    // Private/CGNAT ranges never feed the IP detector.
    for (let index = 0; index < 5; index += 1) await member(`Office ${index}`, { device: `office-device-000${index}`, ip: '10.0.0.8' });
    await detect();
    assert.equal(all("SELECT id FROM risk_cases WHERE dedupe_key LIKE 'multi_account:ip:%'").length, 1);
  });

  await t.test('collusion between campaign owners and paid testers', async () => {
    const owner = await member('Colluding Owner', { device: 'collusion-owner-01', ip: '198.51.100.30' });
    const tester = await member('Colluding Tester', { device: 'collusion-tester-01', ip: '198.51.100.30' });
    const honest = await member('Honest Tester', { device: 'honest-tester-0001', ip: '203.0.113.88' });
    const projectId = newId();
    run("INSERT INTO projects(id,owner_id,title,summary,category) VALUES (?,?,?,?,'developer-tools')", projectId, owner.id, 'Projet collusion', 'Résumé du projet de test.');
    const campaignId = newId();
    run(`INSERT INTO campaigns(id,project_id,owner_id,title,description,reward_cents,slots,deadline) VALUES (?,?,?,?,?,?,?,?)`,
      campaignId, projectId, owner.id, 'Campagne test', 'Description de la campagne.', 2500, 5, '2099-01-01');
    const paidMission = (testerId: string) => {
      const applicationId = newId();
      run("INSERT INTO applications(id,campaign_id,tester_id,motivation,status) VALUES (?,?,?,?,'accepted')", applicationId, campaignId, testerId, 'Motivation de test.');
      const missionId = newId();
      run("INSERT INTO missions(id,campaign_id,tester_id,application_id,status,updated_at) VALUES (?,?,?,?,'paid',?)", missionId, campaignId, testerId, applicationId, new Date().toISOString());
      return missionId;
    };
    const missionId = paidMission(tester.id);
    paidMission(honest.id);
    await detect();
    const key = `collusion:${owner.id}:${tester.id}`;
    let cases = casesFor('collusion', key);
    assert.equal(cases.length, 1);
    assert.equal(cases[0].user_id, tester.id);
    assert.equal(cases[0].score, 50, 'shared public IP only');
    const evidence = JSON.parse(cases[0].evidence);
    assert.equal(evidence.shared_ips.length, 1);
    assert.deepEqual(evidence.mission_ids, [missionId]);
    assert.equal(casesFor('collusion', `collusion:${owner.id}:${honest.id}`).length, 0, 'a single payout without shared network is not suspicious');
    await detect();
    cases = casesFor('collusion', key);
    assert.equal(cases.length, 1);
    assert.equal(riskLevel(tester.id), 'medium');
  });

  await t.test('marketplace self-dealing between buyer and seller', async () => {
    const seller = await member('Self Seller', { device: 'selfdeal-device-01', ip: '203.0.113.50' });
    const buyer = await member('Self Buyer', { device: 'selfdeal-device-01', ip: '203.0.113.51' });
    const listing = (await call<{ listing: { id: string } }>(seller, '/marketplace/listings', { method: 'POST', expected: 201, body: listingBody('Composant auto-acheté') })).listing;
    const order = (await call<{ order: { id: string } }>(buyer, `/marketplace/listings/${listing.id}/buy`, { method: 'POST', expected: 201, body: {} })).order;
    await detect();
    await detect();
    const cases = casesFor('self_dealing', `self_dealing:${seller.id}:${buyer.id}`);
    assert.equal(cases.length, 1);
    assert.equal(cases[0].user_id, seller.id);
    assert.equal(cases[0].score, 75, 'shared device');
    assert.deepEqual(JSON.parse(cases[0].evidence).order_ids, [order.id]);
  });

  await t.test('risk levels from cases, failed logins and sanctions', async () => {
    const calm = await member('Calm Member', { device: 'calm-device-00001' });
    assert.equal(riskLevel(calm.id), 'low');
    for (let index = 0; index < 10; index += 1) recordSignal(null, calm.id, 'login_failed', {});
    assert.equal(riskLevel(calm.id), 'medium');
    await detect();
    assert.equal(casesFor('velocity', `velocity:auth:${calm.id}`).length, 1);
    const quiet = await member('Quiet Member', { device: 'quiet-device-0001' });
    assert.equal(riskLevel(quiet.id), 'low');
    directSanction(quiet.id, 'suspension', ['publish', 'message', 'trade', 'money', 'withdraw', 'review', 'test']);
    assert.equal(riskLevel(quiet.id), 'high');
  });

  await t.test('restriction matrix through capabilityMiddleware', async () => {
    const warned = await member('Warned Member', { device: 'warned-device-001' });
    await call(admin, `/trust/admin/users/${warned.id}/sanctions`, { method: 'POST', expected: 201, body: { kind: 'warning', public_reason: 'Rappel des règles de courtoisie de la communauté.' } });
    await call(warned, '/projects', { method: 'POST', expected: 201, body: projectBody('Projet averti') });
    await call(warned, '/marketplace/listings', { method: 'POST', expected: 201, body: listingBody('Annonce avertie') });
    assert.equal(accountRestriction(warned.id, 'trade'), null);
    assert.equal(accountRestriction(warned.id, 'login'), null);

    const trader = await member('Restricted Trader', { device: 'trader-device-001' });
    await call(admin, `/trust/admin/users/${trader.id}/sanctions`, { method: 'POST', expected: 201,
      body: { kind: 'restriction', capabilities: ['trade'], public_reason: 'Ventes fictives constatées sur la marketplace.', ground: 'terms.self_dealing', duration_days: 30 } });
    const blocked = await call(trader, '/marketplace/listings', { method: 'POST', expected: 403, body: listingBody('Annonce bloquée') });
    assert.equal(blocked.restriction.kind, 'restriction');
    assert.equal(blocked.restriction.capability, 'trade');
    assert.equal(blocked.restriction.appealable, true);
    assert.ok(blocked.restriction.until);
    assert.equal(blocked.error, blocked.restriction.message);
    await call(trader, '/MARKETPLACE//listings', { method: 'POST', expected: 403, body: listingBody('Contournement casse') });
    await call(trader, '/marketplace/listings');
    await call(trader, '/projects', { method: 'POST', expected: 201, body: projectBody('Projet autorisé') });
    assert.equal(accountRestriction(trader.id, 'login'), null);

    const suspended = await member('Suspended Member', { device: 'suspended-dev-001' });
    const suspension = (await call<{ sanction: Json }>(admin, `/trust/admin/users/${suspended.id}/sanctions`, { method: 'POST', expected: 201,
      body: { kind: 'suspension', public_reason: 'Comptes multiples utilisés pour contourner les limites.', ground: 'terms.multi_account', internal_note: 'NOTE-INTERNE-SECRETE' } })).sanction;
    assert.ok(sessionCount(suspended.id) > 0, 'a suspension keeps sessions so the member can appeal');
    const denied = await call(suspended, '/projects', { method: 'POST', expected: 403, body: projectBody('Projet suspendu') });
    assert.equal(denied.restriction.kind, 'suspension');
    await call(suspended, '/marketplace/listings', { method: 'POST', expected: 403, body: listingBody('Annonce suspendue') });
    await call(suspended, '/unknown-module/action', { method: 'POST', expected: 403, body: {} });
    await call(suspended, '/projects');
    const restrictions = await call(suspended, '/trust/me/restrictions');
    assert.equal(restrictions.active.length, 1);
    assert.equal(restrictions.active[0].id, suspension.id);
    assert.equal(restrictions.active[0].can_appeal, true);
    assert.ok(!JSON.stringify(restrictions).includes('NOTE-INTERNE-SECRETE'), 'internal notes never reach the member');
    await call(suspended, '/trust/appeals', { method: 'POST', expected: 201, body: { sanction_id: suspension.id, statement } });
    assert.equal((await call(suspended, '/trust/appeals')).appeals.length, 1);
    assert.equal(accountRestriction(suspended.id, 'login'), null, 'suspended members can still sign in');
    await call(suspended, '/auth/logout', { method: 'POST', expected: 200, body: {} });
    resetLimits();
    await call(suspended, '/auth/login', { method: 'POST', expected: 200, body: { email: suspended.email, password } });
    assert.equal((await call(suspended, '/auth/me')).user?.id, suspended.id);

    // Expired, revoked or future sanctions never block.
    const timed = await member('Timed Member', { device: 'timed-device-0001' });
    directSanction(timed.id, 'suspension', ['publish'], { startsAt: '2020-01-01T00:00:00.000Z', endsAt: '2020-02-01T00:00:00.000Z' });
    directSanction(timed.id, 'suspension', ['publish'], { revoked: true });
    directSanction(timed.id, 'suspension', ['publish'], { startsAt: '2099-01-01T00:00:00.000Z' });
    assert.equal(accountRestriction(timed.id, 'publish'), null);
    await call(timed, '/projects', { method: 'POST', expected: 201, body: projectBody('Projet libre') });

    // An appealable ban keeps sign-in (to appeal); a non-appealable ban blocks it and revokes sessions.
    const appealableBan = await member('Appealable Ban', { device: 'appealban-dev-001' });
    await call(admin, `/trust/admin/users/${appealableBan.id}/sanctions`, { method: 'POST', expected: 201,
      body: { kind: 'ban', public_reason: 'Fraude répétée aux paiements de missions.', ground: 'terms.fraud' } });
    assert.equal(sessionCount(appealableBan.id), 0, 'every ban revokes the sessions');
    assert.equal(accountRestriction(appealableBan.id, 'login'), null);
    assert.equal(accountRestriction(appealableBan.id, 'publish')?.kind, 'ban');
    resetLimits();
    await call(appealableBan, '/auth/login', { method: 'POST', expected: 200, body: { email: appealableBan.email, password } });
    await call(appealableBan, '/projects', { method: 'POST', expected: 403, body: projectBody('Projet banni') });

    const banned = await member('Final Ban', { device: 'finalban-dev-0001' });
    assert.ok(sessionCount(banned.id) > 0);
    await call(admin, `/trust/admin/users/${banned.id}/sanctions`, { method: 'POST', expected: 201,
      body: { kind: 'ban', public_reason: 'Fraude caractérisée et usurpation d’identité.', ground: 'terms.fraud', appealable: false } });
    assert.equal(sessionCount(banned.id), 0);
    const loginBlock = accountRestriction(banned.id, 'login');
    assert.equal(loginBlock?.kind, 'ban');
    assert.equal(loginBlock?.appealable, false);
    assert.equal((await call(banned, '/auth/me')).user, null);
    resetLimits();
    const refused = await call(banned, '/auth/login', { method: 'POST', expected: 403, body: { email: banned.email, password } });
    assert.equal(refused.error, loginBlock?.message);
    await call(admin, `/trust/admin/users/${trader.id}/sanctions`, { method: 'POST', expected: 400,
      body: { kind: 'suspension', public_reason: 'Seul un bannissement peut être non contestable.', appealable: false } });
    await call(admin, `/trust/admin/users/${trader.id}/sanctions`, { method: 'POST', expected: 400,
      body: { kind: 'restriction', public_reason: 'Restriction sans capacité sélectionnée.' } });

    const notifications = all<{ kind: string }>('SELECT kind FROM notifications WHERE user_id=?', suspended.id).map((row) => row.kind);
    assert.ok(notifications.includes('trust.sanction'));
    assert.ok(notifications.includes('trust.appeal'));
  });

  await t.test('appeals lifecycle: one pending, two per sanction, acceptance lifts the sanction', async () => {
    const appellant = await member('Appellant Member', { device: 'appellant-dev-001' });
    const other = await member('Other Member', { device: 'other-device-0001' });
    const sanction = (await call<{ sanction: Json }>(admin, `/trust/admin/users/${appellant.id}/sanctions`, { method: 'POST', expected: 201,
      body: { kind: 'restriction', capabilities: ['review', 'message'], public_reason: 'Avis réciproques non authentiques détectés.', ground: 'terms.fake_reviews' } })).sanction;
    await call(appellant, '/trust/appeals', { method: 'POST', expected: 400, body: { sanction_id: sanction.id, statement: 'Trop court.' } });
    await call(other, '/trust/appeals', { method: 'POST', expected: 404, body: { sanction_id: sanction.id, statement } });
    const first = (await call(appellant, '/trust/appeals', { method: 'POST', expected: 201, body: { sanction_id: sanction.id, statement } })).appeal;
    assert.equal(first.status, 'pending');
    await call(appellant, '/trust/appeals', { method: 'POST', expected: 409, body: { sanction_id: sanction.id, statement } });

    await call(other, `/trust/admin/appeals/${first.id}/reject`, { method: 'POST', expected: 403, body: { note: 'Tentative non autorisée de décision.' } });
    const queue = await call(admin, '/trust/admin/appeals?status=pending');
    const queued = queue.appeals.find((item: Json) => item.id === first.id);
    assert.equal(queued.sanction.id, sanction.id);
    assert.equal(queued.appeals_on_sanction, 1);
    await call(admin, `/trust/admin/appeals/${first.id}/reject`, { method: 'POST', expected: 400, body: { note: 'Non.' } });
    const rejected = (await call(admin, `/trust/admin/appeals/${first.id}/reject`, { method: 'POST', body: { note: 'Les éléments du dossier confirment la décision initiale.' } })).appeal;
    assert.equal(rejected.status, 'rejected');
    await call(admin, `/trust/admin/appeals/${first.id}/accept`, { method: 'POST', expected: 409, body: {} });
    assert.ok(accountRestriction(appellant.id, 'review'), 'rejection keeps the sanction');

    const second = (await call(appellant, '/trust/appeals', { method: 'POST', expected: 201, body: { sanction_id: sanction.id, statement: `${statement} Nouveaux éléments joints.` } })).appeal;
    await call(admin, `/trust/admin/appeals/${second.id}/reject`, { method: 'POST', body: { note: 'Les nouveaux éléments ne modifient pas l’analyse.' } });
    const exhausted = await call(appellant, '/trust/appeals', { method: 'POST', expected: 409, body: { sanction_id: sanction.id, statement } });
    assert.match(exhausted.error, /maximal/);
    assert.throws(() => run("INSERT INTO appeals(id,sanction_id,user_id,statement,status,decided_at) VALUES (?,?,?,?,'rejected',?)",
      newId(), sanction.id, appellant.id, statement, new Date().toISOString()), /appeal limit/);
    const view = await call(appellant, '/trust/me/restrictions');
    assert.equal(view.active[0].can_appeal, false);
    assert.equal(view.active[0].appeals.length, 2);
    assert.equal(view.active[0].appeals[0].decision_note.length > 0, true);

    const restriction = (await call<{ sanction: Json }>(admin, `/trust/admin/users/${appellant.id}/sanctions`, { method: 'POST', expected: 201,
      body: { kind: 'restriction', capabilities: ['trade'], public_reason: 'Achats croisés avec un compte lié.', ground: 'terms.self_dealing' } })).sanction;
    await call(appellant, '/marketplace/listings', { method: 'POST', expected: 403, body: listingBody('Annonce avant appel') });
    const appeal = (await call(appellant, '/trust/appeals', { method: 'POST', expected: 201, body: { sanction_id: restriction.id, statement } })).appeal;
    const accepted = (await call(admin, `/trust/admin/appeals/${appeal.id}/accept`, { method: 'POST', body: { note: 'Erreur d’appréciation, la mesure est levée.' } })).appeal;
    assert.equal(accepted.status, 'accepted');
    const lifted = one<{ revoked_at: string | null; revoked_by: string | null }>('SELECT revoked_at,revoked_by FROM sanctions WHERE id=?', restriction.id)!;
    assert.ok(lifted.revoked_at);
    assert.equal(lifted.revoked_by, admin.id);
    assert.equal(accountRestriction(appellant.id, 'trade'), null);
    await call(appellant, '/marketplace/listings', { method: 'POST', expected: 201, body: listingBody('Annonce après appel') });
    const history = (await call(appellant, '/trust/me/restrictions')).history;
    assert.ok(history.some((item: Json) => item.id === restriction.id && item.appeals[0].status === 'accepted'));
    await call(appellant, '/trust/appeals', { method: 'POST', expected: 409, body: { sanction_id: restriction.id, statement } });
    const kinds = all<{ title: string }>("SELECT title FROM notifications WHERE user_id=? AND kind='trust.appeal'", appellant.id).map((row) => row.title);
    assert.ok(kinds.some((title) => /accepté/.test(title)));
    assert.ok(kinds.some((title) => /rejeté/.test(title)));
  });

  await t.test('administration: authorization, roles and sanction safeguards', async () => {
    const plain = await member('Plain Member', { device: 'plain-device-0001' });
    await call(null, '/trust/admin/users', { expected: 401 });
    await call(plain, '/trust/admin/users', { expected: 403 });
    await call(plain, '/trust/admin/stats', { expected: 403 });
    await call(plain, `/trust/admin/users/${plain.id}/role`, { method: 'PATCH', expected: 403, body: { role: 'admin' } });
    await call(plain, '/trust/admin/settings', { method: 'PUT', expected: 403, body: { thresholds: { window_days: 1 } } });

    const listed = await call(admin, `/trust/admin/users?q=${encodeURIComponent(plain.email)}`);
    assert.equal(listed.total, 1);
    assert.equal(listed.users[0].id, plain.id);
    assert.equal(listed.users[0].risk_level, 'low');
    assert.ok('email_verified' in listed.users[0] || 'email_verified_at' in listed.users[0]);
    const risky = await call(admin, '/trust/admin/users?risk=high&limit=100');
    assert.ok(risky.users.length > 0 && risky.users.every((user: Json) => user.risk_level === 'high'));
    const detail = await call(admin, `/trust/admin/users/${plain.id}`);
    assert.equal(detail.user.id, plain.id);
    assert.ok(Array.isArray(detail.signals.by_kind));
    assert.ok(one("SELECT 1 FROM audit_events WHERE action='trust.user.viewed' AND target_id=?", plain.id), 'risk data access is audited');

    await call(admin, `/trust/admin/users/${admin.id}/role`, { method: 'PATCH', expected: 409, body: { role: 'member' } });
    await call(admin, `/trust/admin/users/${admin.id}/sanctions`, { method: 'POST', expected: 409, body: { kind: 'warning', public_reason: 'Auto-sanction interdite par construction.' } });
    const promoted = await call(admin, `/trust/admin/users/${plain.id}/role`, { method: 'PATCH', body: { role: 'admin' } });
    assert.equal(promoted.changed, true);
    await call(admin, `/trust/admin/users/${plain.id}/sanctions`, { method: 'POST', expected: 409, body: { kind: 'warning', public_reason: 'Sanction d’un administrateur sans confirmation.' } });
    await call(admin, `/trust/admin/users/${plain.id}/sanctions`, { method: 'POST', expected: 201, body: { kind: 'warning', public_reason: 'Sanction d’un administrateur confirmée.', confirm_admin: true } });
    // The second admin removes the first one, then cannot remove itself: at least one admin always remains.
    await call(plain, `/trust/admin/users/${admin.id}/role`, { method: 'PATCH', body: { role: 'member' } });
    await call(admin, '/trust/admin/users', { expected: 403 });
    await call(plain, `/trust/admin/users/${plain.id}/role`, { method: 'PATCH', expected: 409, body: { role: 'member' } });
    assert.equal(one<{ count: number }>("SELECT COUNT(*) AS count FROM users WHERE role='admin'")!.count, 1);
    await call(plain, `/trust/admin/users/${admin.id}/role`, { method: 'PATCH', body: { role: 'admin' } });
    await call(admin, `/trust/admin/users/${plain.id}/role`, { method: 'PATCH', body: { role: 'member' } });
    assert.ok(one("SELECT 1 FROM audit_events WHERE action='trust.user.role_changed' AND target_id=?", plain.id));

    const suspended = await member('Suspended Candidate', { device: 'candidate-dev-001' });
    const active = (await call(admin, `/trust/admin/users/${suspended.id}/sanctions`, { method: 'POST', expected: 201,
      body: { kind: 'suspension', public_reason: 'Suspension conservatoire pendant enquête.' } })).sanction;
    await call(admin, `/trust/admin/users/${suspended.id}/role`, { method: 'PATCH', expected: 409, body: { role: 'admin' } });
    const listedSanctions = (await call(admin, '/trust/admin/sanctions?kind=suspension&limit=100')).sanctions as Json[];
    assert.ok(listedSanctions.some((row) => row.id === active.id && row.internal_note !== undefined), 'admins see the full record');
    await call(admin, `/trust/admin/sanctions/${active.id}/revoke`, { method: 'POST', expected: 400, body: { reason: 'court' } });
    await call(admin, `/trust/admin/sanctions/${active.id}/revoke`, { method: 'POST', body: { reason: 'Enquête close sans manquement établi.' } });
    assert.equal(accountRestriction(suspended.id, 'publish'), null);
    assert.ok(one("SELECT 1 FROM notifications WHERE user_id=? AND kind='trust.sanction' AND title='Sanction levée'", suspended.id), 'revocation is notified');
    await call(admin, `/trust/admin/sanctions/${active.id}/revoke`, { method: 'POST', expected: 409, body: { reason: 'Deuxième levée de la même sanction.' } });

    const sessionsUser = await member('Session Holder', { device: 'session-device-01' });
    assert.ok(sessionCount(sessionsUser.id) > 0);
    await call(admin, `/trust/admin/users/${sessionsUser.id}/sessions/revoke`, { method: 'POST', body: {} });
    assert.equal(sessionCount(sessionsUser.id), 0);
    assert.ok(one("SELECT 1 FROM audit_events WHERE action LIKE 'trust.%' AND target_id=?", sessionsUser.id));
  });

  await t.test('cases queue: assign, dismiss with cooldown, action into a sanction', async () => {
    const a = await member('Queue Alpha', { device: 'queue-shared-0001' });
    const b = await member('Queue Beta', { device: 'queue-shared-0001' });
    const [found] = all<CaseRow>("SELECT c.* FROM risk_cases c JOIN risk_case_subjects s ON s.case_id=c.id WHERE s.user_id=? AND c.kind='multi_account'", b.id);
    assert.ok(found);
    const queue = await call(admin, `/trust/admin/cases?user_id=${a.id}`);
    assert.equal(queue.cases.length, 1);
    assert.equal(queue.cases[0].subjects.length, 2);
    const assigned = await call(admin, `/trust/admin/cases/${found.id}/assign`, { method: 'POST', body: {} });
    assert.equal(assigned.case.assigned_to, admin.id);
    assert.equal(assigned.case.status, 'reviewing');
    await call(admin, `/trust/admin/cases/${found.id}/dismiss`, { method: 'POST', expected: 400, body: { note: 'non' } });
    await call(admin, `/trust/admin/cases/${found.id}/dismiss`, { method: 'POST', body: { note: 'Colocataires vérifiés, aucun abus.' } });
    await detect();
    assert.equal(all("SELECT id FROM risk_cases WHERE dedupe_key=? AND status IN ('open','reviewing')", found.dedupe_key).length, 0, 'dismissal cooldown');
    await call(admin, `/trust/admin/cases/${found.id}/dismiss`, { method: 'POST', expected: 409, body: { note: 'Déjà clôturé.' } });

    const manual = await call(admin, `/trust/admin/users/${b.id}/cases`, { method: 'POST', expected: 201, body: { summary: 'Signalement interne : comportement suspect à vérifier.', score: 60 } });
    const outsider = await member('Queue Outsider', { device: 'queue-outsider-01' });
    await call(admin, `/trust/admin/cases/${manual.case.id}/action`, { method: 'POST', expected: 400,
      body: { user_id: outsider.id, kind: 'warning', public_reason: 'Avertissement hors dossier refusé.' } });
    const actioned = await call(admin, `/trust/admin/cases/${manual.case.id}/action`, { method: 'POST',
      body: { kind: 'restriction', capabilities: ['money'], public_reason: 'Paiements suspendus pendant la vérification.', note: 'Mesure proportionnée.' } });
    assert.equal(actioned.case.status, 'actioned');
    assert.equal(actioned.sanction.case_id, manual.case.id);
    assert.equal(accountRestriction(b.id, 'money')?.kind, 'restriction');
    const statement = (await call(b, '/trust/me/restrictions')).active.find((item: Json) => item.id === actioned.sanction.id);
    assert.equal(statement.automated_detection, true, 'DSA art. 17(3)(c): use of automated detection is disclosed');
  });

  await t.test('dispute resolution refunds real escrow atomically and keeps demo behaviour', async () => {
    const seller = await member('Escrow Seller', { device: 'escrow-seller-001', ip: '203.0.113.61' });
    const buyer = await member('Escrow Buyer', { device: 'escrow-buyer-0001', ip: '203.0.113.62' });
    const disputedOrder = async (title: string, mode: 'demo' | 'sandbox') => {
      const listing = (await call<{ listing: { id: string } }>(seller, '/marketplace/listings', { method: 'POST', expected: 201, body: listingBody(title) })).listing;
      const order = (await call<{ order: { id: string } }>(buyer, `/marketplace/listings/${listing.id}/buy`, { method: 'POST', expected: 201, body: {} })).order;
      run('UPDATE orders SET payment_mode=? WHERE id=?', mode, order.id);
      const report = (await call<{ report: { id: string } }>(buyer, '/trust/reports', { method: 'POST', expected: 201,
        body: { target_type: 'order', target_id: order.id, reason: 'Livraison jamais reçue malgré plusieurs relances.' } })).report;
      assert.equal(one<{ status: string }>('SELECT status FROM orders WHERE id=?', order.id)!.status, 'disputed');
      return { orderId: order.id, reportId: report.id };
    };
    const calls: [string, string, string][] = [];
    let failure: Error | null = null;
    setEscrowAdapterForTests({
      orderPaymentMode: (orderId) => one<{ payment_mode: 'demo' | 'sandbox' | 'live' }>('SELECT payment_mode FROM orders WHERE id=?', orderId)?.payment_mode ?? 'demo',
      refundOrderEscrow: (orderId, actorId, reason) => {
        if (failure) throw failure;
        calls.push([orderId, actorId, reason]);
      },
    });
    const decision = 'Le vendeur n’a fourni aucune livraison vérifiable : remboursement intégral.';
    const sandbox = await disputedOrder('Composant séquestre', 'sandbox');
    const eventsBefore = all('SELECT id FROM order_events WHERE order_id=?', sandbox.orderId).length;

    failure = new Error('PSP indisponible');
    await call(admin, `/trust/reports/${sandbox.reportId}/resolve`, { method: 'POST', expected: 500, body: { status: 'resolved', decision, resolution: 'refunded' } });
    assert.equal(one<{ status: string }>('SELECT status FROM moderation_reports WHERE id=?', sandbox.reportId)!.status, 'open', 'refund failure rolls back the decision');
    assert.equal(one<{ status: string }>('SELECT status FROM orders WHERE id=?', sandbox.orderId)!.status, 'disputed');
    assert.equal(all('SELECT id FROM order_events WHERE order_id=?', sandbox.orderId).length, eventsBefore);

    failure = null;
    const resolved = await call(admin, `/trust/reports/${sandbox.reportId}/resolve`, { method: 'POST', body: { status: 'resolved', decision, resolution: 'refunded' } });
    assert.equal(resolved.report.status, 'resolved');
    assert.deepEqual(calls, [[sandbox.orderId, admin.id, decision]]);
    assert.equal(one<{ status: string }>('SELECT status FROM orders WHERE id=?', sandbox.orderId)!.status, 'refunded');
    const events = all<{ actor_id: string; kind: string; body: string }>('SELECT actor_id,kind,body FROM order_events WHERE order_id=? ORDER BY created_at,rowid', sandbox.orderId);
    assert.equal(events.length, eventsBefore + 1);
    assert.equal(events.at(-1)!.actor_id, admin.id);
    assert.match(events.at(-1)!.body, /Remboursement intégral/);
    assert.ok(all("SELECT 1 FROM notifications WHERE user_id=? AND body LIKE '%remboursement intégral%'", buyer.id).length > 0);

    const demo = await disputedOrder('Composant démo', 'demo');
    await call(admin, `/trust/reports/${demo.reportId}/resolve`, { method: 'POST', expected: 400, body: { status: 'resolved', decision, resolution: 'refunded' } });
    assert.equal(calls.length, 1, 'demo orders never reach the escrow');
    const resumed = await call(admin, `/trust/reports/${demo.reportId}/resolve`, { method: 'POST', body: { status: 'resolved', decision: 'Reprise de la commande à l’état payé.', resolution: 'paid' } });
    assert.equal(resumed.report.status, 'resolved');
    assert.equal(one<{ status: string }>('SELECT status FROM orders WHERE id=?', demo.orderId)!.status, 'paid');
    setEscrowAdapterForTests(null);
  });

  await t.test('settings validation and opt-in withdrawal holds (never an automatic ban)', async () => {
    const settings = await call(admin, '/trust/admin/settings');
    assert.equal(settings.auto_actions.hold_withdrawals_on_high_risk, false);
    assert.equal(settings.thresholds.multi_account_device_users, 2);
    await call(admin, '/trust/admin/settings', { method: 'PUT', expected: 400, body: { thresholds: { multi_account_device_users: 1 } } });
    await call(admin, '/trust/admin/settings', { method: 'PUT', expected: 400, body: { thresholds: { unknown_threshold: 3 } } });
    await call(admin, '/trust/admin/settings', { method: 'PUT', expected: 400, body: { auto_actions: { auto_ban: true } } });

    const x = await member('Hold Alpha', { device: 'hold-shared-00001' });
    const y = await member('Hold Beta', { device: 'hold-shared-00001' });
    const z = await member('Hold Gamma', { device: 'hold-shared-00001' });
    assert.equal(riskLevel(z.id), 'high');
    await detect();
    assert.equal(all('SELECT id FROM sanctions WHERE user_id IN (?,?,?)', x.id, y.id, z.id).length, 0, 'automatic actions are off by default');

    const updated = await call(admin, '/trust/admin/settings', { method: 'PUT', body: { auto_actions: { hold_withdrawals_on_high_risk: true, hold_days: 7 } } });
    assert.equal(updated.auto_actions.hold_withdrawals_on_high_risk, true);
    const result = await call(admin, '/trust/admin/detect', { method: 'POST', body: {} });
    assert.equal(result.ran, true);
    assert.ok(result.summary.auto_holds >= 3);
    for (const user of [x, y, z]) {
      const holds = all<{ kind: string; capabilities: string; automated: number; appealable: number; ends_at: string | null }>('SELECT * FROM sanctions WHERE user_id=?', user.id);
      assert.equal(holds.length, 1);
      assert.equal(holds[0].kind, 'restriction');
      assert.deepEqual(JSON.parse(holds[0].capabilities), ['withdraw']);
      assert.equal(holds[0].automated, 1);
      assert.equal(holds[0].appealable, 1);
      assert.ok(holds[0].ends_at);
      assert.equal(accountRestriction(user.id, 'withdraw')?.capability, 'withdraw');
      assert.equal(accountRestriction(user.id, 'publish'), null);
    }
    assert.equal(all("SELECT id FROM sanctions WHERE automated=1 AND kind!='restriction'").length, 0);
    assert.equal(all("SELECT id FROM sanctions WHERE automated=1 AND capabilities!='[\"withdraw\"]'").length, 0);
    await detect();
    assert.equal(all('SELECT id FROM sanctions WHERE user_id IN (?,?,?)', x.id, y.id, z.id).length, 3, 'holds are not duplicated');
    await call(x, '/compliance/withdrawals', { method: 'POST', expected: 403, body: {} });
    await call(admin, '/trust/admin/settings', { method: 'PUT', body: { auto_actions: { hold_withdrawals_on_high_risk: false } } });
    const stats = await call(admin, '/trust/admin/stats');
    assert.ok(stats.sanctions.automated_active >= 3);
    assert.ok(stats.signals.total > 0);
    assert.equal(stats.detection.job.last_status, 'ok');
  });

  await t.test('personal data: own statements exported, signals erased, decisions kept', async () => {
    const subject = await member('Privacy Subject', { device: 'privacy-device-01', ip: '203.0.113.90' });
    await call(admin, `/trust/admin/users/${subject.id}/sanctions`, { method: 'POST', expected: 201,
      body: { kind: 'restriction', capabilities: ['message'], public_reason: 'Messages promotionnels répétés.', internal_note: 'NOTE-MODERATION-PRIVEE', ground: 'terms.spam' } });
    const sanction = one<{ id: string }>('SELECT id FROM sanctions WHERE user_id=?', subject.id)!;
    await call(subject, '/trust/appeals', { method: 'POST', expected: 201, body: { sanction_id: sanction.id, statement } });
    const handler = new Map(personalDataHandlers()).get('trust');
    assert.ok(handler);
    const exported = handler.export(subject.id) as Json;
    const text = JSON.stringify(exported);
    assert.equal(exported.sanctions.length, 1);
    assert.equal(exported.appeals.length, 1);
    assert.ok(exported.risk_signals.events.length > 0);
    for (const secret of ['NOTE-MODERATION-PRIVEE', 'internal_note', 'created_by', admin.id, '203.0.113.90', 'privacy-device-01']) {
      assert.ok(!text.includes(secret), `export must not contain ${secret}`);
    }
    assert.ok(!/[0-9a-f]{64}/.test(text), 'hashes are not exported');
    handler.erase(subject.id);
    assert.equal(all('SELECT id FROM risk_signals WHERE user_id=?', subject.id).length, 0);
    assert.equal(all('SELECT id FROM sanctions WHERE user_id=?', subject.id).length, 1, 'sanctions are kept as legitimate-interest records');
    assert.equal(all('SELECT id FROM appeals WHERE user_id=?', subject.id).length, 1);
  });
});
