import assert from 'node:assert/strict';
import crypto, { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import test, { mock } from 'node:test';
import { promisify } from 'node:util';

const originalScrypt = crypto.scrypt;
let heldDerivation: { password: string; reached: () => void; resume?: () => void } | undefined;
mock.method(crypto, 'scrypt', (password: string, salt: string, length: number, callback: (error: Error | null, key: Buffer) => void) => {
  originalScrypt(password, salt, length, (error, key) => {
    if (heldDerivation?.password === password) {
      const held = heldDerivation;
      heldDerivation = undefined;
      held.resume = () => callback(error, key);
      held.reached();
    } else callback(error, key);
  });
});
syncBuiltinESMExports();

function pauseDerivation(password: string) {
  assert.equal(heldDerivation, undefined);
  let reached!: () => void;
  const paused = new Promise<void>((resolve) => { reached = resolve; });
  const gate = { password, reached, resume: undefined as (() => void) | undefined };
  heldDerivation = gate;
  return { paused, resume: () => { assert.ok(gate.resume, 'The real scrypt callback must be reached first'); gate.resume(); } };
}

const databasePath = `./data/account-v3-${process.pid}-${randomUUID()}.sqlite`;
process.env.DATABASE_PATH = databasePath;
mkdirSync('./data', { recursive: true });
const legacyCookie = `alpha_session=${randomBytes(32).toString('hex')}`;
const legacyExpiredCookie = `alpha_session=${randomBytes(32).toString('hex')}`;
const password = 'Account-local-password-2026!';
const rotatedPassword = 'A-new-local-password-2026!';
const digestCookie = (cookie: string) => createHash('sha256').update(cookie.slice('alpha_session='.length)).digest('hex');
const legacySalt = randomBytes(16).toString('hex');
const legacyHash = `${legacySalt}:${((await promisify(originalScrypt)(password, legacySalt, 64)) as Buffer).toString('hex')}`;
const legacy = new DatabaseSync(databasePath);
legacy.exec(readFileSync(new URL('../server/schema.sql', import.meta.url), 'utf8'));
legacy.prepare('INSERT INTO users(id,name,email,password_hash) VALUES (?,?,?,?)').run('legacy-owner', 'Legacy Owner', 'legacy@account.test', legacyHash);
legacy.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?,?,?)').run(digestCookie(legacyCookie), 'legacy-owner', '2099-01-01T00:00:00.000Z');
legacy.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?,?,?)').run(digestCookie(legacyExpiredCookie), 'legacy-owner', '2000-01-01T00:00:00.000Z');
legacy.close();
const { app } = await import('../server/app.js');
const { db, all, one, run } = await import('../server/db.js');
const { hashPassword } = await import('../server/auth.js');

interface Actor { id: string; name: string; email: string; cookie: string }
interface Session { id: string; created_at: string | null; expires_at: string; current: boolean }
interface SessionPage { sessions: Session[]; total: number; limit: number; offset: number; has_more: boolean }
interface StoredSession { token_hash: string; user_id: string; expires_at: string; public_id: string; created_at: string | null }

test('V3 local account controls: real HTTP, cookies, migration and transactional races', { timeout: 60000 }, async (t) => {
  const server = app.listen(0, '127.0.0.1');
  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    db.close();
    mock.restoreAll();
    syncBuiltinESMExports();
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${databasePath}${suffix}`, { force: true });
  });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/auth`;
  async function request<T = Record<string, unknown>>(actor: Actor | null, path: string, expected = 200, method = 'GET', body?: unknown, extraHeaders: Record<string, string | null> = {}) {
    const headers = new Headers({
      'X-Alpha-Client': 'web', 'Content-Type': 'application/json',
      ...(actor?.cookie ? { Cookie: actor.cookie } : {}),
    });
    for (const [key, value] of Object.entries(extraHeaders)) {
      if (value === null) headers.delete(key); else headers.set(key, value);
    }
    const response = await fetch(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    assert.equal(response.status, expected, `${method} ${path}: ${text}`);
    const data = JSON.parse(text) as T;
    if (expected >= 400) {
      assert.equal(typeof (data as { error?: unknown }).error, 'string');
      assert.equal(response.headers.get('set-cookie'), null, 'Failed operations must never issue a cookie');
    }
    const cookie = response.headers.get('set-cookie');
    if (actor && cookie) actor.cookie = cookie.split(';', 1)[0];
    return { data, response };
  }
  async function account(name: string) {
    const actor = { id: '', name, email: `${name.toLowerCase()}@account.test`, cookie: '' };
    const result = await request<{ user: { id: string } }>(actor, '/register', 201, 'POST', { name, email: actor.email, password });
    actor.id = result.data.user.id;
    return actor;
  }
  async function login(actor: Actor, loginPassword = password) {
    const next = { ...actor, cookie: '' };
    await request(next, '/login', 200, 'POST', { email: actor.email, password: loginPassword });
    return next;
  }
  const sessions = (actor: Actor) => all<StoredSession>('SELECT * FROM sessions WHERE user_id=? ORDER BY token_hash', actor.id);
  const passwordHash = (actor: Actor) => one<{ password_hash: string }>('SELECT password_hash FROM users WHERE id=?', actor.id)!.password_hash;
  const sessionId = (actor: Actor) => one<{ public_id: string }>('SELECT public_id FROM sessions WHERE token_hash=?', digestCookie(actor.cookie))!.public_id;
  const list = async (actor: Actor, query = '') => (await request<SessionPage>(actor, `/sessions${query}`)).data;
  const change = (actor: Actor, current = password, next = rotatedPassword, expected = 200) =>
    request(actor, '/password', expected, 'POST', { current_password: current, new_password: next });
  const auditCount = () => one<{ count: number }>('SELECT COUNT(*) AS count FROM audit_events')!.count;
  const oldActor = { id: 'legacy-owner', name: 'Legacy Owner', email: 'legacy@account.test', cookie: legacyCookie };
  let owner: Actor;
  let outsider: Actor;
  let other: Actor;
  let expired: Actor;

  await t.test('pre-migration cookies retain identity, opaque IDs and unknown creation dates', async () => {
    const rows = sessions(oldActor);
    assert.equal(rows.length, 2);
    assert.equal(new Set(rows.map((row) => row.public_id)).size, 2);
    for (const row of rows) { assert.match(row.public_id, /^[a-f0-9]{32}$/); assert.equal(row.created_at, null); }
    assert.equal((await request<{ user: { id: string } }>(oldActor, '/me')).data.user.id, oldActor.id);
    const page = await list(oldActor);
    assert.equal(page.total, 1);
    assert.deepEqual(page.sessions[0], { id: sessionId(oldActor), created_at: null, expires_at: '2099-01-01T00:00:00.000Z', current: true });
    await request({ ...oldActor, cookie: legacyExpiredCookie }, '/sessions', 401);
  });

  await t.test('new sessions preserve cookie protections and reveal only own live metadata', async () => {
    owner = await account('Owner');
    outsider = await account('Outsider');
    other = await login(owner);
    expired = await login(owner);
    run('UPDATE sessions SET expires_at=? WHERE token_hash=?', '2000-01-01T00:00:00.000Z', digestCookie(expired.cookie));
    const page = await list(owner);
    assert.equal(page.total, 2);
    assert.equal(page.limit, 20); assert.equal(page.offset, 0); assert.equal(page.has_more, false);
    assert.equal(page.sessions[0].current, true);
    assert.equal(page.sessions.filter((session) => session.current).length, 1);
    for (const session of page.sessions) {
      assert.deepEqual(Object.keys(session).sort(), ['created_at', 'current', 'expires_at', 'id']);
      assert.match(session.id, /^[a-f0-9]{32}$/);
      assert.ok(session.created_at);
      assert.equal(Date.parse(session.expires_at) - Date.parse(session.created_at), 7 * 86400000);
    }
    const json = JSON.stringify(page);
    for (const row of all<StoredSession>('SELECT * FROM sessions')) assert.ok(!json.includes(row.token_hash));
    for (const actor of [owner, other, outsider]) assert.ok(!json.includes(actor.cookie.slice('alpha_session='.length)));
    assert.ok(!json.includes(sessionId(outsider))); assert.ok(!json.includes(outsider.id)); assert.ok(!json.includes(outsider.email));
    assert.ok(!json.includes(passwordHash(owner)));
    assert.equal((await list(outsider)).total, 1);
    const first = await list(owner, '?limit=1&offset=0');
    const second = await list(owner, '?limit=1&offset=1');
    assert.equal(first.total, 2); assert.equal(first.has_more, true); assert.equal(second.has_more, false);
    assert.notEqual(first.sessions[0].id, second.sessions[0].id);
    assert.deepEqual((await list(owner, '?offset=99')).sessions, []);
    assert.deepEqual((await request({ ...owner, cookie: expired.cookie }, '/me')).data, { user: null });
    const originalEnvironment = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const secure = { ...owner, cookie: '' };
      const result = await request(secure, '/login', 200, 'POST', { email: owner.email, password });
      assert.match(result.response.headers.get('set-cookie')!, /HttpOnly; SameSite=Lax; Path=\/; Max-Age=604800; Secure$/);
      await request(secure, '/logout', 200, 'POST');
    } finally { if (originalEnvironment === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = originalEnvironment; }
  });

  await t.test('strict pagination, authentication, ownership, CSRF and origin validation', async () => {
    for (const query of ['limit=0', 'limit=51', 'limit=1.5', 'limit=1e1', 'limit=%202', 'limit=01', 'limit=1&limit=2', 'limit[]=1',
      'offset=-1', 'offset=1.1', 'offset=1000001', 'offset=Infinity', 'offset=', 'offset=00', 'user_id=outsider']) {
      await request(owner, `/sessions?${query}`, 400);
    }
    for (const [path, method] of [['/sessions', 'GET'], [`/sessions/${sessionId(other)}`, 'DELETE'], ['/sessions/revoke-others', 'POST'], ['/password', 'POST']]) {
      await request(null, path, 401, method, method === 'POST' ? {} : undefined);
    }
    for (const target of ['invalid', digestCookie(owner.cookie), 'ABCDEF0123456789ABCDEF0123456789AB']) await request(owner, `/sessions/${target}`, 400, 'DELETE');
    await request(owner, `/sessions/${'0'.repeat(32)}`, 404, 'DELETE');
    await request(owner, `/sessions/${sessionId(outsider)}`, 404, 'DELETE');
    await request(owner, `/sessions/${sessionId(owner)}`, 409, 'DELETE');
    const before = sessions(owner);
    for (const [path, method, body] of [
      [`/sessions/${sessionId(other)}`, 'DELETE', undefined],
      ['/sessions/revoke-others', 'POST', {}],
      ['/password', 'POST', { current_password: password, new_password: rotatedPassword }],
    ] as const) {
      const unsafeHeaders: Record<string, string | null>[] = [{ 'X-Alpha-Client': null }, { Origin: 'https://untrusted.example.test' }];
      for (const headers of unsafeHeaders) {
        await request(owner, path, 403, method, body, headers);
      }
    }
    assert.deepEqual(sessions(owner), before);
  });

  await t.test('individual and bulk revocation preserve current and unrelated users', async () => {
    // Login cleanup removed expired rows; create a known expired own session for the live-only DELETE check.
    const expiredToken = randomBytes(32).toString('hex');
    const expiredId = randomBytes(16).toString('hex');
    run('INSERT INTO sessions(token_hash,user_id,expires_at,public_id,created_at) VALUES (?,?,?,?,?)',
      digestCookie(`alpha_session=${expiredToken}`), owner.id, '2000-01-01T00:00:00.000Z', expiredId, null);
    await request(owner, `/sessions/${expiredId}`, 404, 'DELETE');
    const outsiderBefore = sessions(outsider);
    const target = sessionId(other);
    await request(owner, `/sessions/${target}`, 200, 'DELETE');
    await request(owner, `/sessions/${target}`, 404, 'DELETE');
    await request(other, '/sessions', 401);
    const extra = await login(owner);
    const previous = owner.cookie;
    const result = await request<{ ok: boolean; revoked: number }>(owner, '/sessions/revoke-others', 200, 'POST');
    assert.equal(result.data.ok, true); assert.equal(result.data.revoked, 1);
    assert.equal(owner.cookie, previous);
    await request(extra, '/sessions', 401);
    assert.equal((await list(owner)).total, 1);
    assert.equal((await request<{ revoked: number }>(owner, '/sessions/revoke-others', 200, 'POST')).data.revoked, 0);
    assert.deepEqual(sessions(outsider), outsiderBefore);
    assert.ok(one("SELECT id FROM audit_events WHERE action='auth.session_revoked'"));
    assert.ok(one("SELECT id FROM audit_events WHERE action='auth.sessions_revoked'"));
  });

  await t.test('password validation, wrong current password and unchanged password do not mutate', async () => {
    const beforeHash = passwordHash(owner);
    const beforeSessions = sessions(owner);
    const beforeAudit = auditCount();
    for (const body of [
      {}, { current_password: password }, { current_password: '', new_password: rotatedPassword },
      { current_password: password, new_password: '123456789' }, { current_password: password, new_password: 'x'.repeat(129) },
      { current_password: 'x'.repeat(129), new_password: rotatedPassword }, { current_password: password, new_password: 42 },
      { current_password: password, new_password: rotatedPassword, user_id: outsider.id },
    ]) await request(owner, '/password', 400, 'POST', body);
    await change(owner, 'Incorrect-old-password!', rotatedPassword, 400);
    await change(owner, password, password, 400);
    assert.equal(passwordHash(owner), beforeHash);
    assert.deepEqual(sessions(owner), beforeSessions);
    assert.equal(auditCount(), beforeAudit);
  });

  await t.test('password rotation atomically replaces all sessions and invalidates every old credential', async () => {
    const extra = await login(owner);
    const previous = { ...owner };
    const oldIds = sessions(owner).map((session) => session.public_id);
    const oldHash = passwordHash(owner);
    const outsiderBefore = sessions(outsider);
    const result = await change(owner);
    assert.deepEqual(result.data, { ok: true });
    assert.notEqual(owner.cookie, previous.cookie);
    assert.match(result.response.headers.get('set-cookie')!, /HttpOnly; SameSite=Lax; Path=\/; Max-Age=604800/);
    assert.notEqual(passwordHash(owner), oldHash);
    assert.match(passwordHash(owner), /^[a-f0-9]{32}:[a-f0-9]{128}$/);
    assert.equal(sessions(owner).length, 1);
    const page = await list(owner);
    assert.equal(page.total, 1); assert.equal(page.sessions[0].current, true);
    assert.ok(page.sessions[0].created_at); assert.ok(!oldIds.includes(page.sessions[0].id));
    for (const revoked of [previous, extra]) {
      await request(revoked, '/sessions', 401);
      assert.deepEqual((await request(revoked, '/me')).data, { user: null });
    }
    await request(null, '/login', 401, 'POST', { email: owner.email, password });
    const fresh = await login(owner, rotatedPassword);
    await request(fresh, '/logout', 200, 'POST');
    assert.deepEqual(sessions(outsider), outsiderBefore);
    const audits = JSON.stringify(all('SELECT * FROM audit_events'));
    for (const secret of [password, rotatedPassword, oldHash, passwordHash(owner), ...sessions(owner).map((session) => session.token_hash), owner.cookie.slice(14)]) {
      assert.ok(!audits.includes(secret), 'Audit events must not contain credentials');
    }
    assert.ok(one("SELECT id FROM audit_events WHERE action='auth.password_changed' AND actor_id=?", owner.id));
  });

  await t.test('audit or new-session failures roll back password, session revocation and cookie changes', async (t) => {
    const errors = t.mock.method(console, 'error', (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /^Intentional (account|revoke) rollback test$/);
    });
    const rollback = await account('Rollback');
    await login(rollback);
    for (const table of ['audit_events', 'sessions']) {
      const beforeHash = passwordHash(rollback);
      const beforeSessions = sessions(rollback);
      const beforeCookie = rollback.cookie;
      const beforeAudit = auditCount();
      db.exec(`CREATE TRIGGER account_fail_insert BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'Intentional account rollback test'); END`);
      try { await change(rollback, password, rotatedPassword, 500); }
      finally { db.exec('DROP TRIGGER account_fail_insert'); }
      assert.equal(passwordHash(rollback), beforeHash);
      assert.equal(rollback.cookie, beforeCookie);
      assert.deepEqual(sessions(rollback), beforeSessions);
      assert.equal(auditCount(), beforeAudit);
      assert.equal((await list(rollback)).total, 2);
    }
    db.exec("CREATE TRIGGER account_fail_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'Intentional revoke rollback test'); END");
    const before = sessions(rollback);
    try {
      const target = before.find((row) => row.token_hash !== digestCookie(rollback.cookie))!;
      await request(rollback, `/sessions/${target.public_id}`, 500, 'DELETE');
      assert.deepEqual(sessions(rollback), before);
      await request(rollback, '/sessions/revoke-others', 500, 'POST');
      assert.deepEqual(sessions(rollback), before);
    } finally { db.exec('DROP TRIGGER account_fail_audit'); }
    assert.equal(errors.mock.callCount(), 4);
  });

  await t.test('login verified against a snapshot cannot create a session after a password rotation', async () => {
    const racer = await account('LoginRace');
    const gate = pauseDerivation(password);
    const attempt = request(null, '/login', 401, 'POST', { email: racer.email, password });
    await gate.paused;
    try { await change(racer); }
    finally { gate.resume(); }
    await attempt;
    assert.equal(sessions(racer).length, 1);
    const verified = await login(racer, rotatedPassword);
    await request(verified, '/logout', 200, 'POST');
  });

  await t.test('a password request revoked during real scrypt cannot change credentials or issue a cookie', async () => {
    const racer = await account('RevokedRace');
    const controller = await login(racer);
    const beforeHash = passwordHash(racer);
    const gate = pauseDerivation('Revoked-in-flight-password!');
    const attempt = change(racer, password, 'Revoked-in-flight-password!', 401);
    await gate.paused;
    try { await request(controller, `/sessions/${sessionId(racer)}`, 200, 'DELETE'); }
    finally { gate.resume(); }
    await attempt;
    assert.equal(passwordHash(racer), beforeHash);
    assert.equal(sessions(racer).length, 1);
    assert.equal((await list(controller)).sessions[0].current, true);
  });

  await t.test('expiry and bulk revocation during scrypt are checked inside the password transaction', async () => {
    for (const revoke of ['expire', 'bulk']) {
      const racer = await account(`RequestRace${revoke}`);
      const controller = await login(racer);
      const beforeHash = passwordHash(racer);
      const gate = pauseDerivation(`Pending-${revoke}-new-password!`);
      const attempt = change(racer, password, `Pending-${revoke}-new-password!`, 401);
      await gate.paused;
      try {
        if (revoke === 'expire') run('UPDATE sessions SET expires_at=? WHERE token_hash=?', '2000-01-01T00:00:00.000Z', digestCookie(racer.cookie));
        else await request(controller, '/sessions/revoke-others', 200, 'POST');
      } finally { gate.resume(); }
      await attempt;
      assert.equal(passwordHash(racer), beforeHash);
      assert.equal((await list(controller)).total, 1);
    }
  });

  await t.test('concurrent password changes have one winner; snapshot changes conflict even if session remains', async () => {
    const racer = await account('PasswordRace');
    const controller = await login(racer);
    const gate = pauseDerivation('Losing-new-password-2026!');
    const attempt = change(racer, password, 'Losing-new-password-2026!', 401);
    await gate.paused;
    try { await change(controller); }
    finally { gate.resume(); }
    await attempt;
    assert.equal(sessions(racer).length, 1);
    const verified = await login(controller, rotatedPassword);
    await request(verified, '/logout', 200, 'POST');
    const conflict = await account('SnapshotRace');
    const replacementHash = await hashPassword('External-new-password-2026!');
    const snapshotGate = pauseDerivation('Snapshot-new-password-2026!');
    const conflicting = change(conflict, password, 'Snapshot-new-password-2026!', 409);
    await snapshotGate.paused;
    try { run('UPDATE users SET password_hash=? WHERE id=?', replacementHash, conflict.id); }
    finally { snapshotGate.resume(); }
    await conflicting;
    assert.equal(passwordHash(conflict), replacementHash);
    assert.equal(sessions(conflict).length, 1);
  });

  await t.test('password changes are rate-limited without mutating state', async () => {
    const before = sessions(outsider);
    const beforeHash = passwordHash(outsider);
    let limited = false;
    for (let attempt = 0; attempt < 31; attempt++) {
      const response = await fetch(`${base}/password`, {
        method: 'POST', headers: { 'X-Alpha-Client': 'web', 'Content-Type': 'application/json', Cookie: outsider.cookie },
        body: JSON.stringify({ current_password: password, new_password: 'short' }),
      });
      if (response.status === 429) { limited = true; break; }
      assert.equal(response.status, 400);
    }
    assert.equal(limited, true);
    assert.equal(passwordHash(outsider), beforeHash);
    assert.deepEqual(sessions(outsider), before);
    await list(outsider);
  });
});
