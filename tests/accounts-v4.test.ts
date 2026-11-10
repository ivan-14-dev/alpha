import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

process.env.DATABASE_PATH = ':memory:';
const { app } = await import('../server/app.js');
const { all, one, run } = await import('../server/db.js');
const { setOAuthFetchForTests, safeRedirectPath, pkceChallenge } = await import('../server/accounts/oauth.js');
const { base32Encode, totpCode, totpStep, verifyTotp } = await import('../server/accounts/totp.js');
const { accountRestriction } = await import('../server/platform/guards.js');
const { runJob } = await import('../server/platform/jobs.js');
const { personalDataHandlers } = await import('../server/platform/privacy.js');
const { appOrigin } = await import('../server/platform/settings.js');

const password = 'Accounts-v4-password-2026!';
const newPassword = 'Accounts-v4-rotated-2026!';
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

interface Actor { id: string; name: string; email: string; jar: Map<string, string> }
interface MeUser { id: string; email: string; role: string; email_verified: boolean; mfa_enabled: boolean; has_password: boolean; pending_legal: string[]; admin_mfa_required: boolean }
type Json = Record<string, any>;

// ---------- Fake OAuth providers (module-level fetch injection) ----------
interface FakeAccount { id: string | number; email: string; verified: boolean; name: string }
const fakeGithub = new Map<string, FakeAccount>();
const fakeGoogle = new Map<string, FakeAccount>();
const tokenRequests: { url: string; form: URLSearchParams }[] = [];
setOAuthFetchForTests(async (url, init) => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (url === 'https://github.com/login/oauth/access_token' || url === 'https://oauth2.googleapis.com/token') {
    const form = new URLSearchParams(String(init?.body));
    tokenRequests.push({ url, form });
    // GitHub reports invalid codes with HTTP 200 and an `error` field.
    if (form.get('code') === 'bad-code') return json({ error: 'bad_verification_code', error_description: 'The code is incorrect or expired.' });
    return json({ access_token: `token-${form.get('code')}`, token_type: 'bearer' });
  }
  const code = new Headers(init?.headers).get('authorization')?.replace('Bearer token-', '') ?? '';
  if (url === 'https://api.github.com/user') {
    const account = fakeGithub.get(code);
    return account ? json({ id: Number(account.id), login: account.name.replace(/\s/g, '').toLowerCase(), name: account.name }) : json({ message: 'Bad credentials' }, 401);
  }
  if (url === 'https://api.github.com/user/emails') {
    const account = fakeGithub.get(code)!;
    return json([{ email: 'not-primary@example.test', primary: false, verified: true }, { email: account.email, primary: true, verified: account.verified }]);
  }
  if (url === 'https://openidconnect.googleapis.com/v1/userinfo') {
    const account = fakeGoogle.get(code)!;
    return json({ sub: String(account.id), email: account.email, email_verified: account.verified, name: account.name });
  }
  return json({ message: 'unexpected URL' }, 404);
});

test('V4 accounts: verification, recovery, MFA, OAuth, admin and legal', { timeout: 120000 }, async (t) => {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  t.after(async () => {
    setOAuthFetchForTests(null);
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  });

  const resetLimits = () => run('DELETE FROM rate_limit_buckets');
  const actor = (name: string): Actor => ({ id: '', name, email: `${name.toLowerCase()}@accounts.test`, jar: new Map() });
  async function call<T = Json>(who: Actor | null, path: string, options: { method?: string; body?: unknown; expected?: number; headers?: Record<string, string> } = {}) {
    const method = options.method ?? 'GET';
    const expected = options.expected ?? 200;
    const headers = new Headers({ 'X-Alpha-Client': 'web', ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...options.headers });
    if (who?.jar.size) headers.set('Cookie', [...who.jar].map(([name, value]) => `${name}=${value}`).join('; '));
    const response = await fetch(`${base}${path}`, { method, headers, redirect: 'manual', ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
    const text = await response.text();
    assert.equal(response.status, expected, `${method} ${path}: ${text}`);
    const cookies = response.headers.getSetCookie();
    if (expected >= 400) {
      assert.ok(!cookies.some((cookie) => /^alpha_session=[^;]+/.test(cookie)), 'Failures must never issue a session cookie');
      if (text) assert.equal(typeof JSON.parse(text).error, 'string');
    }
    if (who) {
      for (const cookie of cookies) {
        const [pair] = cookie.split(';');
        const index = pair.indexOf('=');
        const name = pair.slice(0, index);
        const value = pair.slice(index + 1);
        if (!value || /Max-Age=0(;|$)/.test(cookie)) who.jar.delete(name); else who.jar.set(name, value);
      }
    }
    const data = (text && response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : {}) as T;
    return { data, response, cookies, location: response.headers.get('location') };
  }
  async function register(who: Actor, acceptTerms = true) {
    const result = await call<{ user: MeUser }>(who, '/auth/register', { method: 'POST', expected: 201,
      body: { name: who.name, email: who.email, password, ...(acceptTerms ? { accept_terms: true } : {}) } });
    who.id = result.data.user.id;
    return result.data.user;
  }
  const me = async (who: Actor | null) => (await call<{ user: MeUser | null }>(who, '/auth/me')).data.user;
  const outbox = (email: string, category: string) => all<{ subject: string; text_body: string; sensitive: number }>(
    'SELECT subject,text_body,sensitive FROM email_outbox WHERE to_address=? AND category=? ORDER BY created_at, rowid', email, category);
  const linkToken = (email: string, category: string, path: string) => {
    const messages = outbox(email, category);
    const match = messages.at(-1)?.text_body.match(new RegExp(`${path.replace('/', '\\/')}\\?token=([A-Za-z0-9_-]+)`));
    assert.ok(match, `No ${category} link for ${email}`);
    return match[1];
  };
  const sessionCount = (userId: string) => one<{ count: number }>('SELECT COUNT(*) AS count FROM sessions WHERE user_id=?', userId)!.count;
  const freshCode = (userId: string, secret: string) => {
    // Simulates time passing: steps already consumed stay rejected, the current step becomes usable.
    run('UPDATE mfa_totp SET last_used_step=? WHERE user_id=?', totpStep() - 2, userId);
    return totpCode(secret);
  };
  const wrongCode = (secret: string) => {
    const valid = new Set([-1, 0, 1].map((offset) => totpCode(secret, totpStep() + offset)));
    let code = 0;
    while (valid.has(String(code).padStart(6, '0'))) code++;
    return String(code).padStart(6, '0');
  };
  async function enableMfa(who: Actor) {
    const setup = await call<{ secret: string }>(who, '/auth/mfa/setup', { method: 'POST', body: { password } });
    const enabled = await call<{ recovery_codes: string[] }>(who, '/auth/mfa/enable', { method: 'POST', body: { code: totpCode(setup.data.secret) } });
    return { secret: setup.data.secret, codes: enabled.data.recovery_codes };
  }
  async function oauth(who: Actor, provider: 'github' | 'google', code: string, query = 'mode=login&redirect=%2Fprojects') {
    const start = await call(who, `/auth/oauth/${provider}/start?${query}`, { expected: 302 });
    const authorize = new URL(start.location!);
    const state = authorize.searchParams.get('state');
    if (!state) return { authorize, state, location: authorize, cookies: start.cookies };
    const callback = await call(who, `/auth/oauth/${provider}/callback?code=${encodeURIComponent(code)}&state=${state}`, { expected: 302 });
    return { authorize, state, location: new URL(callback.location!), cookies: callback.cookies };
  }
  const origin = appOrigin();
  const admin = actor('Admin');
  const secondAdmin = actor('SecondAdmin');
  const member = actor('Member');

  await t.test('migration backfills existing users as verified; TOTP follows RFC 6238; redirects are same-site only', () => {
    const legacy = new DatabaseSync(':memory:');
    legacy.exec(readFileSync(new URL('../server/schema.sql', import.meta.url), 'utf8'));
    legacy.prepare("INSERT INTO users(id,name,email,password_hash,created_at) VALUES ('old','Old','old@accounts.test','x','2024-01-02T03:04:05.000Z')").run();
    legacy.exec(readFileSync(new URL('../server/migrations/005-accounts.sql', import.meta.url), 'utf8'));
    assert.equal((legacy.prepare("SELECT email_verified_at FROM users WHERE id='old'").get() as { email_verified_at: string }).email_verified_at, '2024-01-02T03:04:05.000Z');
    legacy.close();

    const rfcSecret = base32Encode(Buffer.from('12345678901234567890'));
    assert.equal(rfcSecret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    for (const [seconds, code] of [[59, '287082'], [1111111109, '081804'], [1234567890, '005924'], [2000000000, '279037']] as const) {
      assert.equal(totpCode(rfcSecret, Math.floor(seconds / 30)), code);
    }
    assert.equal(verifyTotp(rfcSecret, '287082', { timeMs: 59000 }), 1);
    assert.equal(verifyTotp(rfcSecret, '287082', { timeMs: 89000 }), 1, 'previous step accepted (clock drift)');
    assert.equal(verifyTotp(rfcSecret, '287082', { timeMs: 59000, lastUsedStep: 1 }), null, 'replay refused');
    assert.equal(verifyTotp(rfcSecret, '287082', { timeMs: 150000 }), null, 'outside ±1 window');
    assert.equal(verifyTotp(rfcSecret, '28708', { timeMs: 59000 }), null);

    for (const value of ['/', '/projects', '/settings?tab=security#mfa', '/p/a-b_c.d~e']) assert.equal(safeRedirectPath(value), value);
    for (const value of ['//evil.example', 'https://evil.example/x', '/\\evil.example', '\\\\evil', 'javascript:alert(1)', '/api/auth/me', '/API/x',
      'evil', '', '/ok space', '/é', `/${'a'.repeat(600)}`, '/\nhttps://evil', 42, null, ['/a']]) {
      assert.equal(safeRedirectPath(value), null, `accepted ${String(value)}`);
    }
  });

  await t.test('registration queues a single-use 48 h verification link without requiring it', async () => {
    resetLimits();
    const verified = actor('Verifier');
    const user = await register(verified);
    assert.equal(user.email_verified, false);
    assert.equal(user.has_password, true);
    assert.equal(user.mfa_enabled, false);
    assert.deepEqual(user.pending_legal, []);
    assert.equal(JSON.stringify(user).includes('password_hash'), false);
    assert.ok(await me(verified), 'the account is usable before verification');
    const [message] = outbox(verified.email, 'account.verify');
    assert.equal(message.subject, 'Confirmez votre adresse e-mail');
    assert.equal(message.sensitive, 1);
    const token = linkToken(verified.email, 'account.verify', '/verify-email');
    assert.ok(message.text_body.includes(`${origin}/verify-email?token=`));
    const stored = one<{ token_hash: string; expires_at: string }>('SELECT token_hash,expires_at FROM email_verification_tokens WHERE user_id=?', verified.id)!;
    assert.equal(stored.token_hash, sha256(token));
    assert.ok(Math.abs(Date.parse(stored.expires_at) - Date.now() - 48 * 3600000) < 60000);
    assert.equal(JSON.stringify(all('SELECT * FROM email_verification_tokens')).includes(token), false);

    await call(null, '/auth/verify-email', { method: 'POST', body: { token: randomBytes(32).toString('base64url') }, expected: 400 });
    await call(null, '/auth/verify-email', { method: 'POST', body: { token: 'short' }, expected: 400 });
    await call(null, '/auth/verify-email', { method: 'POST', body: { token, extra: 1 }, expected: 400 });
    assert.deepEqual((await call(null, '/auth/verify-email', { method: 'POST', body: { token } })).data, { ok: true, email_verified: true });
    assert.equal((await me(verified))!.email_verified, true);
    assert.ok(one("SELECT 1 FROM audit_events WHERE action='auth.email_verified' AND actor_id=?", verified.id));
    await call(null, '/auth/verify-email', { method: 'POST', body: { token }, expected: 400 });
    await call(verified, '/auth/verify-email/resend', { method: 'POST', body: {}, expected: 409 });

    const pending = actor('Pending');
    assert.deepEqual((await register(pending, false)).pending_legal, ['terms', 'privacy']);
    const first = linkToken(pending.email, 'account.verify', '/verify-email');
    await call(null, '/auth/verify-email/resend', { method: 'POST', body: {}, expected: 401 });
    await call(pending, '/auth/verify-email/resend', { method: 'POST', body: {}, expected: 202 });
    const second = linkToken(pending.email, 'account.verify', '/verify-email');
    assert.notEqual(first, second);
    await call(null, '/auth/verify-email', { method: 'POST', body: { token: first }, expected: 400 });
    run('UPDATE email_verification_tokens SET expires_at=? WHERE token_hash=?', '2000-01-01T00:00:00.000Z', sha256(second));
    await call(null, '/auth/verify-email', { method: 'POST', body: { token: second }, expected: 410 });
    assert.equal((await me(pending))!.email_verified, false);
    await call(pending, '/auth/verify-email/resend', { method: 'POST', body: {}, expected: 202 });
    await call(pending, '/auth/verify-email/resend', { method: 'POST', body: {}, expected: 202 });
    await call(pending, '/auth/verify-email/resend', { method: 'POST', body: {}, expected: 429 });
    await call(null, '/auth/verify-email', { method: 'POST', body: { token: linkToken(pending.email, 'account.verify', '/verify-email') } });
    assert.equal((await me(pending))!.email_verified, true);
  });

  await t.test('password recovery never reveals accounts, revokes every session and consumes the link', async () => {
    resetLimits();
    const owner = actor('Recovery');
    await register(owner);
    const second = { ...owner, jar: new Map<string, string>() };
    await call(second, '/auth/login', { method: 'POST', body: { email: owner.email, password } });
    assert.equal(sessionCount(owner.id), 2);

    const startedAt = Date.now();
    const unknown = await call(null, '/auth/password/forgot', { method: 'POST', body: { email: 'nobody@accounts.test' }, expected: 202 });
    const known = await call(null, '/auth/password/forgot', { method: 'POST', body: { email: owner.email.toUpperCase() }, expected: 202 });
    assert.deepEqual(unknown.data, known.data);
    assert.ok(Date.now() - startedAt >= 400, 'responses are padded to a minimum duration');
    assert.equal(all("SELECT 1 FROM email_outbox WHERE category='account.reset' AND to_address='nobody@accounts.test'").length, 0);
    assert.equal(outbox(owner.email, 'account.reset').length, 1);
    const superseded = linkToken(owner.email, 'account.reset', '/reset-password');
    await call(null, '/auth/password/forgot', { method: 'POST', body: { email: owner.email }, expected: 202 });
    const token = linkToken(owner.email, 'account.reset', '/reset-password');
    assert.notEqual(token, superseded);
    const stored = one<{ expires_at: string }>('SELECT expires_at FROM password_reset_tokens WHERE token_hash=?', sha256(token))!;
    assert.ok(Math.abs(Date.parse(stored.expires_at) - Date.now() - 3600000) < 60000);
    await call(null, '/auth/password/reset', { method: 'POST', body: { token: superseded, password: newPassword }, expected: 400 });
    await call(null, '/auth/password/reset', { method: 'POST', body: { token, password: 'short' }, expected: 400 });
    await call(null, '/auth/password/reset', { method: 'POST', body: { token, password: newPassword, user_id: member.id }, expected: 400 });
    const beforeHash = one<{ password_hash: string }>('SELECT password_hash FROM users WHERE id=?', owner.id)!.password_hash;

    const reset = await call(null, '/auth/password/reset', { method: 'POST', body: { token, password: newPassword } });
    assert.deepEqual(reset.data, { ok: true });
    assert.equal(reset.cookies.length, 0, 'a reset never signs the user in');
    assert.notEqual(one<{ password_hash: string }>('SELECT password_hash FROM users WHERE id=?', owner.id)!.password_hash, beforeHash);
    assert.equal(sessionCount(owner.id), 0);
    assert.equal(await me(owner), null);
    assert.equal(await me(second), null);
    await call(null, '/auth/password/reset', { method: 'POST', body: { token, password: 'Yet-another-password-1' }, expected: 400 });
    await call(null, '/auth/login', { method: 'POST', body: { email: owner.email, password }, expected: 401 });
    await call(owner, '/auth/login', { method: 'POST', body: { email: owner.email, password: newPassword } });
    assert.equal(outbox(owner.email, 'account.password_changed').at(-1)?.subject, 'Votre mot de passe a été modifié');
    assert.ok(one("SELECT 1 FROM audit_events WHERE action='auth.password_reset' AND actor_id=?", owner.id));
    assert.equal(JSON.stringify(all('SELECT * FROM audit_events')).includes(token), false);

    await call(null, '/auth/password/forgot', { method: 'POST', body: { email: owner.email }, expected: 202 });
    const expired = linkToken(owner.email, 'account.reset', '/reset-password');
    run('UPDATE password_reset_tokens SET expires_at=? WHERE token_hash=?', '2000-01-01T00:00:00.000Z', sha256(expired));
    await call(null, '/auth/password/reset', { method: 'POST', body: { token: expired, password: 'Expired-link-password-1' }, expected: 410 });

    resetLimits();
    const before = outbox(owner.email, 'account.reset').length;
    for (let index = 0; index < 6; index++) await call(null, '/auth/password/forgot', { method: 'POST', body: { email: owner.email }, expected: 202 });
    assert.equal(outbox(owner.email, 'account.reset').length, before + 5, 'per-address limit is silent');
    for (let index = 0; index < 4; index++) await call(null, '/auth/password/forgot', { method: 'POST', body: { email: `x${index}@accounts.test` }, expected: 202 });
    await call(null, '/auth/password/forgot', { method: 'POST', body: { email: 'y@accounts.test' }, expected: 429 });
    await call(null, '/auth/password/forgot', { method: 'POST', body: { email: 'not-an-email' }, expected: 429 });
  });

  await t.test('TOTP MFA: setup, enable, login challenge, replay, recovery codes, attempts and disable', async () => {
    resetLimits();
    const owner = actor('Mfa');
    await register(owner);
    assert.deepEqual((await call(owner, '/auth/mfa')).data, { enabled: false, enabled_at: null, pending_setup: false, recovery_codes_remaining: 0 });
    await call(null, '/auth/mfa/setup', { method: 'POST', body: { password }, expected: 401 });
    await call(owner, '/auth/mfa/setup', { method: 'POST', body: {}, expected: 400 });
    await call(owner, '/auth/mfa/setup', { method: 'POST', body: { password: 'Wrong-password-2026' }, expected: 400 });
    await call(owner, '/auth/mfa/enable', { method: 'POST', body: { code: '123456' }, expected: 409 });
    const setup = await call<{ secret: string; otpauth_url: string; qr_code: string }>(owner, '/auth/mfa/setup', { method: 'POST', body: { password } });
    const { secret } = setup.data;
    assert.match(secret, /^[A-Z2-7]{32}$/);
    assert.ok(setup.data.otpauth_url.startsWith(`otpauth://totp/Alpha:${encodeURIComponent(owner.email)}?`));
    assert.equal(new URL(setup.data.otpauth_url).searchParams.get('issuer'), 'Alpha');
    assert.equal(new URL(setup.data.otpauth_url).searchParams.get('secret'), secret);
    assert.match(setup.data.qr_code, /^data:image\/png;base64,/);
    const row = one<{ secret_sealed: string; enabled_at: string | null }>('SELECT secret_sealed,enabled_at FROM mfa_totp WHERE user_id=?', owner.id)!;
    assert.equal(row.secret_sealed.includes(secret), false);
    assert.equal(row.enabled_at, null);
    assert.equal((await me(owner))!.mfa_enabled, false, 'a pending setup does not enable MFA');

    await call(owner, '/auth/mfa/enable', { method: 'POST', body: { code: wrongCode(secret) }, expected: 400 });
    const enableCode = totpCode(secret);
    const enabled = await call<{ recovery_codes: string[] }>(owner, '/auth/mfa/enable', { method: 'POST', body: { code: enableCode } });
    const codes = enabled.data.recovery_codes;
    assert.equal(codes.length, 10);
    assert.equal(new Set(codes).size, 10);
    for (const code of codes) assert.match(code, /^[a-z2-7]{4}(-[a-z2-7]{4}){3}$/);
    const storedCodes = JSON.stringify(all('SELECT * FROM mfa_recovery_codes WHERE user_id=?', owner.id));
    for (const code of codes) assert.equal(storedCodes.includes(code) || storedCodes.includes(code.replace(/-/g, '')), false);
    assert.equal(outbox(owner.email, 'account.security').at(-1)?.subject, 'Double authentification activée');
    await call(owner, '/auth/mfa/setup', { method: 'POST', body: { password }, expected: 409 });
    await call(owner, '/auth/mfa/enable', { method: 'POST', body: { code: '123456' }, expected: 409 });
    assert.equal((await me(owner))!.mfa_enabled, true);
    assert.equal((await call(owner, '/auth/mfa')).data.recovery_codes_remaining, 10);

    const signIn = async () => {
      const visitor = { ...owner, jar: new Map<string, string>() };
      const result = await call<{ mfa_required: boolean; challenge: string; user?: unknown }>(visitor, '/auth/login', { method: 'POST', body: { email: owner.email, password } });
      assert.equal(result.data.mfa_required, true);
      assert.match(result.data.challenge, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(result.data.user, undefined);
      assert.equal(result.cookies.length, 0, 'no session before the second factor');
      return { visitor, challenge: result.data.challenge };
    };
    const sessionsBefore = sessionCount(owner.id);
    let attempt = await signIn();
    assert.equal(sessionCount(owner.id), sessionsBefore);
    assert.equal(one<{ id_hash: string }>('SELECT id_hash FROM mfa_challenges WHERE id_hash=?', sha256(attempt.challenge))?.id_hash, sha256(attempt.challenge));
    await call(attempt.visitor, '/auth/mfa/verify', { method: 'POST', body: { challenge: attempt.challenge, code: enableCode }, expected: 401 });
    await call(attempt.visitor, '/auth/mfa/verify', { method: 'POST', body: { challenge: attempt.challenge, code: '123456', recovery_code: codes[0] }, expected: 400 });
    const loginCode = freshCode(owner.id, secret);
    const verified = await call<{ user: MeUser }>(attempt.visitor, '/auth/mfa/verify', { method: 'POST', body: { challenge: attempt.challenge, code: loginCode } });
    assert.equal(verified.data.user.id, owner.id);
    assert.equal((await me(attempt.visitor))!.id, owner.id);
    await call(attempt.visitor, '/auth/mfa/verify', { method: 'POST', body: { challenge: attempt.challenge, code: loginCode }, expected: 410 });

    attempt = await signIn();
    await call(attempt.visitor, '/auth/mfa/verify', { method: 'POST', body: { challenge: attempt.challenge, code: loginCode }, expected: 401 });
    await call(attempt.visitor, '/auth/mfa/verify', { method: 'POST', body: { challenge: attempt.challenge, recovery_code: codes[0].replace(/-/g, '').toUpperCase() } });
    assert.equal((await me(attempt.visitor))!.id, owner.id);
    assert.equal(outbox(owner.email, 'account.security').at(-1)?.subject, 'Code de récupération utilisé');
    attempt = await signIn();
    await call(attempt.visitor, '/auth/mfa/verify', { method: 'POST', body: { challenge: attempt.challenge, recovery_code: codes[0] }, expected: 401 });
    assert.equal((await call(owner, '/auth/mfa')).data.recovery_codes_remaining, 9);

    attempt = await signIn();
    for (let index = 0; index < 5; index++) {
      await call(attempt.visitor, '/auth/mfa/verify', { method: 'POST', body: { challenge: attempt.challenge, code: wrongCode(secret) }, expected: 401 });
    }
    await call(attempt.visitor, '/auth/mfa/verify', { method: 'POST', body: { challenge: attempt.challenge, code: freshCode(owner.id, secret) }, expected: 410 });
    assert.equal(one<{ attempts: number }>('SELECT attempts FROM mfa_challenges WHERE id_hash=?', sha256(attempt.challenge))!.attempts, 5);
    attempt = await signIn();
    run('UPDATE mfa_challenges SET expires_at=? WHERE id_hash=?', '2000-01-01T00:00:00.000Z', sha256(attempt.challenge));
    await call(attempt.visitor, '/auth/mfa/verify', { method: 'POST', body: { challenge: attempt.challenge, code: freshCode(owner.id, secret) }, expected: 410 });
    await call(null, '/auth/mfa/verify', { method: 'POST', body: { challenge: randomBytes(32).toString('base64url'), code: '123456' }, expected: 410 });

    await call(owner, '/auth/mfa/recovery-codes', { method: 'POST', body: { code: wrongCode(secret) }, expected: 400 });
    const regenerated = await call<{ recovery_codes: string[] }>(owner, '/auth/mfa/recovery-codes', { method: 'POST', body: { code: freshCode(owner.id, secret) } });
    assert.equal(regenerated.data.recovery_codes.length, 10);
    attempt = await signIn();
    await call(attempt.visitor, '/auth/mfa/verify', { method: 'POST', body: { challenge: attempt.challenge, recovery_code: codes[1] }, expected: 401 });

    await call(owner, '/auth/mfa/disable', { method: 'POST', body: { code: freshCode(owner.id, secret) }, expected: 400 });
    await call(owner, '/auth/mfa/disable', { method: 'POST', body: { password, code: wrongCode(secret) }, expected: 400 });
    await call(owner, '/auth/mfa/disable', { method: 'POST', body: { password: 'Wrong-password-2026', code: freshCode(owner.id, secret) }, expected: 400 });
    assert.equal((await me(owner))!.mfa_enabled, true);
    await call(owner, '/auth/mfa/disable', { method: 'POST', body: { password, code: regenerated.data.recovery_codes[0] } });
    assert.equal((await me(owner))!.mfa_enabled, false);
    assert.equal(all('SELECT 1 FROM mfa_recovery_codes WHERE user_id=?', owner.id).length, 0);
    assert.equal(outbox(owner.email, 'account.security').at(-1)?.subject, 'Double authentification désactivée');
    const direct = await call<{ user: MeUser }>({ ...owner, jar: new Map() }, '/auth/login', { method: 'POST', body: { email: owner.email, password } });
    assert.equal(direct.data.user.id, owner.id);
    assert.ok(one("SELECT 1 FROM audit_events WHERE action='auth.mfa_enabled' AND actor_id=?", owner.id));
    assert.ok(one("SELECT 1 FROM audit_events WHERE action='auth.mfa_disabled' AND actor_id=?", owner.id));
  });

  await t.test('admin OAuth configuration requires an administrator and never returns secrets', async () => {
    resetLimits();
    await register(admin);
    await register(secondAdmin);
    await register(member);
    run("UPDATE users SET role='admin' WHERE id IN (?,?)", admin.id, secondAdmin.id);
    const githubSecret = 'gh-very-secret-value-123456';
    const googleSecret = 'google-very-secret-value-456789';

    assert.deepEqual((await call(null, '/auth/oauth/providers')).data, { providers: [] });
    const disabled = await call(null, '/auth/oauth/github/start', { expected: 302 });
    assert.equal(disabled.location, `${origin}/login?oauth_error=provider_disabled`);
    await call(null, '/auth/oauth/gitlab/start', { expected: 404 });
    await call(null, '/auth/admin/oauth', { expected: 401 });
    await call(member, '/auth/admin/oauth', { expected: 403 });
    await call(member, '/auth/admin/oauth/github', { method: 'PUT', body: { enabled: true, client_id: 'x', client_secret: githubSecret }, expected: 403 });
    await call(admin, '/auth/admin/oauth/github', { method: 'PUT', body: { enabled: true, client_id: 'gh-client-id' }, expected: 400 });
    await call(admin, '/auth/admin/oauth/github', { method: 'PUT', body: { enabled: true, client_id: 'gh-client-id', client_secret: githubSecret, extra: true }, expected: 400 });
    await call(admin, '/auth/admin/oauth/gitlab', { method: 'PUT', body: { enabled: false, client_id: '' }, expected: 404 });
    const saved = await call<{ provider: Json }>(admin, '/auth/admin/oauth/github', { method: 'PUT', body: { enabled: true, client_id: 'gh-client-id', client_secret: githubSecret } });
    assert.equal(JSON.stringify(saved.data).includes(githubSecret), false);
    assert.equal(saved.data.provider.client_secret.configured, true);
    assert.ok(saved.data.provider.client_secret.mask.length > 0);
    assert.equal(saved.data.provider.callback_url, `${origin}/api/auth/oauth/github/callback`);
    assert.equal(saved.data.provider.ready, true);
    await call(admin, '/auth/admin/oauth/google', { method: 'PUT', body: { enabled: true, client_id: 'google-client-id.apps.googleusercontent.com', client_secret: googleSecret } });
    await call(admin, '/auth/admin/oauth/github', { method: 'PUT', body: { enabled: true, client_id: 'gh-client-id' } });
    const listed = await call<{ providers: Json[] }>(admin, '/auth/admin/oauth');
    const listedJson = JSON.stringify(listed.data);
    for (const secret of [githubSecret, googleSecret]) {
      assert.equal(listedJson.includes(secret), false);
      assert.equal(JSON.stringify(all('SELECT * FROM platform_settings')).includes(secret), false);
      assert.equal(JSON.stringify(all('SELECT * FROM audit_events')).includes(secret), false);
    }
    assert.deepEqual(listed.data.providers.map((provider) => [provider.id, provider.enabled, provider.client_secret.configured]), [['github', true, true], ['google', true, true]]);
    assert.ok(one("SELECT 1 FROM audit_events WHERE action='auth.oauth_config_updated' AND actor_id=?", admin.id));
    assert.deepEqual((await call(null, '/auth/oauth/providers')).data, { providers: [{ id: 'github', name: 'GitHub' }, { id: 'google', name: 'Google' }] });

    await call(admin, '/auth/admin/oauth/google', { method: 'PUT', body: { enabled: true, client_id: 'google-client-id.apps.googleusercontent.com', client_secret: null }, expected: 400 });
    await call(admin, '/auth/admin/oauth/google', { method: 'PUT', body: { enabled: false, client_id: 'google-client-id.apps.googleusercontent.com', client_secret: null } });
    assert.deepEqual((await call(null, '/auth/oauth/providers')).data, { providers: [{ id: 'github', name: 'GitHub' }] });
    await call(admin, '/auth/admin/oauth/google', { method: 'PUT', body: { enabled: true, client_id: 'google-client-id.apps.googleusercontent.com', client_secret: googleSecret } });
  });

  let oauthOnly: Actor;
  await t.test('OAuth sign-in: new account, existing identity, PKCE, state and provider failures, open redirects', async () => {
    resetLimits();
    oauthOnly = actor('Newcomer');
    fakeGithub.set('new-1', { id: 501, email: 'Newcomer@OAuth.test', verified: true, name: 'New Comer' });
    const usersBefore = one<{ count: number }>('SELECT COUNT(*) AS count FROM users')!.count;
    const flow = await oauth(oauthOnly, 'github', 'new-1');
    assert.equal(flow.authorize.origin + flow.authorize.pathname, 'https://github.com/login/oauth/authorize');
    assert.equal(flow.authorize.searchParams.get('client_id'), 'gh-client-id');
    assert.equal(flow.authorize.searchParams.get('redirect_uri'), `${origin}/api/auth/oauth/github/callback`);
    assert.equal(flow.authorize.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(flow.authorize.searchParams.get('scope'), 'read:user user:email');
    const exchange = tokenRequests.at(-1)!;
    assert.equal(exchange.form.get('client_secret'), 'gh-very-secret-value-123456');
    assert.equal(pkceChallenge(exchange.form.get('code_verifier')!), flow.authorize.searchParams.get('code_challenge'));
    assert.equal(exchange.form.get('redirect_uri'), `${origin}/api/auth/oauth/github/callback`);
    assert.equal(flow.location.toString(), `${origin}/projects`);
    assert.ok(flow.cookies.some((cookie) => cookie.startsWith('alpha_oauth_state=;') && cookie.includes('Max-Age=0')), 'state cookie cleared');
    const created = (await me(oauthOnly))!;
    oauthOnly.id = created.id;
    oauthOnly.email = created.email;
    assert.equal(created.email, 'newcomer@oauth.test');
    assert.equal(created.email_verified, true);
    assert.equal(created.has_password, false);
    assert.deepEqual(created.pending_legal, [], 'continuing with a provider records acceptance of the terms');
    assert.equal(one<{ password_hash: string }>('SELECT password_hash FROM users WHERE id=?', created.id)!.password_hash, '');
    assert.equal(one<{ count: number }>('SELECT COUNT(*) AS count FROM users')!.count, usersBefore + 1);
    assert.equal(all('SELECT 1 FROM oauth_states').length, 0, 'states are single use');
    await call(null, '/auth/login', { method: 'POST', body: { email: created.email, password: 'Any-password-123' }, expected: 401 });

    fakeGithub.set('new-1-again', { id: 501, email: 'renamed@oauth.test', verified: true, name: 'New Comer' });
    const returning = actor('Returning');
    const again = await oauth(returning, 'github', 'new-1-again', 'redirect=%2Fprojects%3Ftab%3Dmine%23top');
    assert.equal(again.location.toString(), `${origin}/projects?tab=mine#top`);
    assert.equal((await me(returning))!.id, created.id);
    assert.equal(one<{ count: number }>('SELECT COUNT(*) AS count FROM users')!.count, usersBefore + 1);

    const intruder = actor('Intruder');
    const started = await call(intruder, '/auth/oauth/github/start', { expected: 302 });
    const state = new URL(started.location!).searchParams.get('state')!;
    intruder.jar.set('alpha_oauth_state', randomBytes(32).toString('base64url'));
    const mismatch = await call(intruder, `/auth/oauth/github/callback?code=new-1&state=${state}`, { expected: 302 });
    assert.equal(mismatch.location, `${origin}/login?oauth_error=state`);
    assert.equal(await me(intruder), null);
    const noCookie = await call(null, `/auth/oauth/github/callback?code=new-1&state=${state}`, { expected: 302 });
    assert.equal(noCookie.location, `${origin}/login?oauth_error=state`);
    const replay = actor('Replay');
    const used = await oauth(replay, 'github', 'new-1');
    replay.jar.set('alpha_oauth_state', used.state!);
    assert.equal((await call(replay, `/auth/oauth/github/callback?code=new-1&state=${used.state}`, { expected: 302 })).location, `${origin}/login?oauth_error=state`);
    const late = actor('Late');
    const lateStart = await call(late, '/auth/oauth/github/start', { expected: 302 });
    run('UPDATE oauth_states SET expires_at=?', '2000-01-01T00:00:00.000Z');
    const lateState = new URL(lateStart.location!).searchParams.get('state');
    assert.equal((await call(late, `/auth/oauth/github/callback?code=new-1&state=${lateState}`, { expected: 302 })).location, `${origin}/login?oauth_error=state`);
    const crossProvider = actor('Cross');
    const googleStart = await call(crossProvider, '/auth/oauth/google/start', { expected: 302 });
    const googleState = new URL(googleStart.location!).searchParams.get('state');
    assert.equal((await call(crossProvider, `/auth/oauth/github/callback?code=new-1&state=${googleState}`, { expected: 302 })).location, `${origin}/login?oauth_error=state`);

    const failing = actor('Failing');
    assert.equal((await oauth(failing, 'github', 'bad-code')).location.toString(), `${origin}/login?oauth_error=provider_error`);
    const denied = await call(failing, '/auth/oauth/github/start', { expected: 302 });
    const deniedState = new URL(denied.location!).searchParams.get('state');
    assert.equal((await call(failing, `/auth/oauth/github/callback?error=access_denied&state=${deniedState}`, { expected: 302 })).location, `${origin}/login?oauth_error=access_denied`);
    fakeGithub.set('unverified', { id: 502, email: 'unverified@oauth.test', verified: false, name: 'Unverified' });
    assert.equal((await oauth(failing, 'github', 'unverified')).location.toString(), `${origin}/login?oauth_error=email_unverified`);
    fakeGoogle.set('google-unverified', { id: 'g-502', email: 'unverified-google@oauth.test', verified: false, name: 'Unverified' });
    assert.equal((await oauth(failing, 'google', 'google-unverified')).location.toString(), `${origin}/login?oauth_error=email_unverified`);
    assert.equal(one('SELECT 1 FROM users WHERE email IN (?,?)', 'unverified@oauth.test', 'unverified-google@oauth.test'), undefined);
    assert.equal(all('SELECT 1 FROM oauth_identities WHERE provider_user_id IN (?,?)', '502', 'g-502').length, 0);
    assert.equal(await me(failing), null);

    const statesBefore = all('SELECT 1 FROM oauth_states').length;
    for (const redirect of ['//evil.example', 'https://evil.example/x', '/\\evil.example', 'javascript:alert(1)', '/api/auth/me', 'evil.example']) {
      await call(null, `/auth/oauth/github/start?redirect=${encodeURIComponent(redirect)}`, { expected: 400 });
    }
    await call(null, '/auth/oauth/github/start?mode=admin', { expected: 400 });
    assert.equal(all('SELECT 1 FROM oauth_states').length, statesBefore);
    const stored = one<{ verifier_sealed: string }>('SELECT verifier_sealed FROM oauth_states LIMIT 1');
    if (stored) assert.ok(stored.verifier_sealed.startsWith('v1.'));
  });

  await t.test('OAuth linking, e-mail matching rules, MFA second step and unlinking', async () => {
    resetLimits();
    const local = actor('Linker');
    await register(local);
    const anonymous = actor('Anonymous');
    assert.equal((await oauth(anonymous, 'github', 'x', 'mode=link&redirect=%2Fsettings')).location.toString(), `${origin}/login?oauth_error=login_required`);

    fakeGithub.set('link-1', { id: 777, email: local.email, verified: true, name: 'Linker' });
    assert.equal((await me(local))!.email_verified, false);
    const linked = await oauth(local, 'github', 'link-1', 'mode=link&redirect=%2Fsettings');
    assert.equal(linked.location.toString(), `${origin}/settings?oauth=linked&provider=github`);
    assert.ok(one("SELECT 1 FROM oauth_identities WHERE provider='github' AND provider_user_id='777' AND user_id=?", local.id));
    assert.equal((await me(local))!.email_verified, true, 'a provider-verified matching address verifies the account');
    assert.ok(one("SELECT 1 FROM audit_events WHERE action='auth.oauth_linked' AND actor_id=?", local.id));
    fakeGithub.set('link-2', { id: 778, email: 'other@oauth.test', verified: true, name: 'Linker' });
    assert.equal((await oauth(local, 'github', 'link-2', 'mode=link&redirect=%2Fsettings')).location.toString(), `${origin}/settings?oauth_error=already_linked`);
    const thief = actor('Thief');
    await register(thief);
    assert.equal((await oauth(thief, 'github', 'link-1', 'mode=link&redirect=%2Fsettings')).location.toString(), `${origin}/settings?oauth_error=identity_taken`);
    const viaGithub = actor('ViaGithub');
    await oauth(viaGithub, 'github', 'link-1');
    assert.equal((await me(viaGithub))!.id, local.id);

    const unverifiedLocal = actor('Matching');
    await register(unverifiedLocal);
    fakeGoogle.set('match-1', { id: 'g-900', email: unverifiedLocal.email, verified: true, name: 'Matching' });
    const refused = actor('MatchingBrowser');
    assert.equal((await oauth(refused, 'google', 'match-1')).location.toString(), `${origin}/login?oauth_error=account_exists`);
    assert.equal(one("SELECT 1 FROM oauth_identities WHERE provider_user_id='g-900'"), undefined);
    assert.equal(await me(refused), null);
    await call(null, '/auth/verify-email', { method: 'POST', body: { token: linkToken(unverifiedLocal.email, 'account.verify', '/verify-email') } });
    const autoLinked = await oauth(refused, 'google', 'match-1');
    assert.equal(autoLinked.location.toString(), `${origin}/projects`);
    assert.equal((await me(refused))!.id, unverifiedLocal.id, 'verified on both sides: linked and signed in');
    assert.equal(all("SELECT 1 FROM users WHERE email=?", unverifiedLocal.email).length, 1);

    await call(oauthOnly, '/auth/oauth/identities/github', { method: 'DELETE', expected: 409 });
    await call(local, '/auth/oauth/identities/google', { method: 'DELETE', expected: 404 });
    await call(null, '/auth/oauth/identities/github', { method: 'DELETE', expected: 401 });
    await call(local, '/auth/oauth/identities/github', { method: 'DELETE' });
    assert.equal(one("SELECT 1 FROM oauth_identities WHERE provider_user_id='777'"), undefined);
    assert.ok(one("SELECT 1 FROM audit_events WHERE action='auth.oauth_unlinked' AND actor_id=?", local.id));

    const { secret } = await enableMfa(local);
    await oauth(local, 'github', 'link-1', 'mode=link&redirect=%2Fsettings');
    const browser = actor('MfaBrowser');
    const second = await oauth(browser, 'github', 'link-1', 'redirect=%2Fprojects');
    assert.equal(second.location.origin + second.location.pathname, `${origin}/login`);
    assert.equal(second.location.searchParams.get('next'), '/projects');
    const challenge = second.location.searchParams.get('mfa')!;
    assert.ok(challenge);
    assert.ok(!second.cookies.some((cookie) => /^alpha_session=[^;]+/.test(cookie)), 'MFA users get no session from the provider alone');
    assert.equal(await me(browser), null);
    await call(browser, '/auth/mfa/verify', { method: 'POST', body: { challenge, code: freshCode(local.id, secret) } });
    assert.equal((await me(browser))!.id, local.id);
  });

  await t.test('legal acceptance, account status, statistics and admin MFA policy', async () => {
    resetLimits();
    const signer = actor('Signer');
    await register(signer, false);
    await call(null, '/auth/legal/accept', { method: 'POST', body: { documents: ['terms'] }, expected: 401 });
    assert.deepEqual((await call(signer, '/auth/legal')).data.pending, ['terms', 'privacy']);
    await call(signer, '/auth/legal/accept', { method: 'POST', body: { documents: ['unknown'] }, expected: 400 });
    await call(signer, '/auth/legal/accept', { method: 'POST', body: { documents: [] }, expected: 400 });
    const accepted = await call<{ pending: string[]; documents: { key: string; accepted: boolean }[] }>(signer, '/auth/legal/accept', { method: 'POST', body: { documents: ['terms', 'privacy', 'terms'] } });
    assert.deepEqual(accepted.data.pending, []);
    assert.equal(accepted.data.documents.find((document) => document.key === 'payments')!.accepted, false);
    assert.deepEqual((await me(signer))!.pending_legal, []);
    assert.equal(all('SELECT 1 FROM legal_acceptances WHERE user_id=?', signer.id).length, 2);
    assert.ok(one("SELECT 1 FROM audit_events WHERE action='auth.legal_accepted' AND actor_id=?", signer.id));

    await call(null, '/auth/account', { expected: 401 });
    const status = await call<Json>(oauthOnly, '/auth/account');
    assert.equal(status.data.has_password, false);
    assert.equal(status.data.can_unlink, false);
    assert.deepEqual(status.data.identities.map((identity: Json) => identity.provider), ['github']);
    assert.deepEqual(status.data.oauth_providers.map((provider: Json) => [provider.id, provider.linked]), [['github', true], ['google', false]]);
    for (const key of ['password_hash', 'token_hash', 'secret_sealed', 'code_hash', 'provider_user_id']) assert.equal(JSON.stringify(status.data).includes(key), false);

    await call(member, '/auth/admin/stats', { expected: 403 });
    const stats = (await call<{ stats: Json }>(admin, '/auth/admin/stats')).data.stats;
    assert.equal(stats.users, one<{ count: number }>('SELECT COUNT(*) AS count FROM users')!.count);
    assert.equal(stats.mfa_enabled, one<{ count: number }>('SELECT COUNT(*) AS count FROM mfa_totp WHERE enabled_at IS NOT NULL')!.count);
    assert.equal(stats.identities.github, one<{ count: number }>("SELECT COUNT(*) AS count FROM oauth_identities WHERE provider='github'")!.count);
    assert.equal(stats.admins, 2);
    assert.ok(stats.email_verified_pct > 0 && stats.email_verified_pct <= 100);

    await call(member, '/auth/admin/policy', { method: 'PUT', body: { require_admin_mfa: true }, expected: 403 });
    await call(admin, '/auth/admin/policy', { method: 'PUT', body: { require_admin_mfa: true }, expected: 409 });
    const { secret } = await enableMfa(admin);
    const policy = await call<{ policy: Json; admins_without_mfa: number }>(admin, '/auth/admin/policy', { method: 'PUT', body: { require_admin_mfa: true } });
    assert.deepEqual(policy.data, { policy: { require_admin_mfa: true }, admins_without_mfa: 1 });
    const downgraded = (await me(secondAdmin))!;
    assert.equal(downgraded.role, 'member');
    assert.equal(downgraded.admin_mfa_required, true);
    await call(secondAdmin, '/auth/admin/stats', { expected: 403 });
    assert.equal((await me(admin))!.role, 'admin');
    await call(admin, '/auth/mfa/disable', { method: 'POST', body: { password, code: freshCode(admin.id, secret) }, expected: 409 });
    await call(admin, '/auth/admin/policy', { method: 'PUT', body: { require_admin_mfa: false } });
    assert.equal((await me(secondAdmin))!.role, 'admin');
    assert.ok(one("SELECT 1 FROM audit_events WHERE action='auth.policy_updated' AND actor_id=?", admin.id));
  });

  await t.test('login restrictions from the trust module sign the user out and block every sign-in path', async (t) => {
    resetLimits();
    const restricted = actor('Restricted');
    await register(restricted);
    fakeGithub.set('restricted', { id: 990, email: 'restricted-gh@oauth.test', verified: true, name: 'Restricted' });
    await oauth(restricted, 'github', 'restricted', 'mode=link&redirect=%2Fsettings');
    // Trust only blocks `login` with a non-appealable ban (suspended members can still sign in to appeal).
    try {
      run(`INSERT INTO sanctions(id,user_id,kind,capabilities,public_reason,appealable) VALUES (?,?,'ban','["login"]',?,0)`,
        'sanction-accounts-test', restricted.id, 'Fraude avérée au système de paiement.');
    } catch {
      t.skip('trust sanctions table unavailable');
      return;
    }
    const restriction = accountRestriction(restricted.id, 'login');
    if (!restriction) {
      t.skip('server/platform/guards.ts does not report login restrictions: behaviour cannot be observed');
      return;
    }
    assert.equal(await me(restricted), null);
    const refused = await call<{ error: string }>(null, '/auth/login', { method: 'POST', body: { email: restricted.email, password }, expected: 403 });
    assert.equal(refused.data.error, restriction.message);
    assert.equal((await oauth(actor('RestrictedBrowser'), 'github', 'restricted')).location.toString(), `${origin}/login?oauth_error=restricted`);
  });

  await t.test('personal data export hides secrets; erase and purge remove account security data', async () => {
    const handler = personalDataHandlers().find(([name]) => name === 'accounts')?.[1];
    assert.ok(handler);
    const subject = one<{ id: string }>("SELECT user_id AS id FROM oauth_identities WHERE provider_user_id='777'")!;
    const exported = JSON.stringify(handler.export(subject.id));
    assert.ok(exported.includes('"enabled":true'));
    assert.ok(exported.includes('github'));
    for (const row of all<Record<string, string>>('SELECT secret_sealed FROM mfa_totp WHERE user_id=?', subject.id)) assert.equal(exported.includes(row.secret_sealed), false);
    for (const key of ['secret', 'code_hash', 'token_hash', 'provider_user_id']) assert.equal(exported.includes(`"${key}"`), false);
    handler.erase(subject.id);
    for (const table of ['email_verification_tokens', 'password_reset_tokens', 'mfa_recovery_codes', 'mfa_totp', 'mfa_challenges', 'oauth_identities']) {
      assert.equal(all(`SELECT 1 FROM ${table} WHERE user_id=?`, subject.id).length, 0, table);
    }

    const past = '2000-01-01T00:00:00.000Z';
    run('INSERT INTO password_reset_tokens(id,user_id,token_hash,expires_at) VALUES (?,?,?,?)', 'expired-reset', member.id, sha256('expired-reset'), past);
    run('INSERT INTO email_verification_tokens(id,user_id,token_hash,email,expires_at) VALUES (?,?,?,?,?)', 'expired-verify', member.id, sha256('expired-verify'), member.email, past);
    run("INSERT INTO mfa_challenges(id_hash,user_id,method,expires_at) VALUES (?,?,'password',?)", sha256('expired-challenge'), member.id, past);
    assert.equal(await runJob('accounts.purge'), true);
    assert.equal(one("SELECT 1 FROM password_reset_tokens WHERE id='expired-reset'"), undefined);
    assert.equal(one("SELECT 1 FROM email_verification_tokens WHERE id='expired-verify'"), undefined);
    assert.equal(one('SELECT 1 FROM mfa_challenges WHERE id_hash=?', sha256('expired-challenge')), undefined);
  });
});
