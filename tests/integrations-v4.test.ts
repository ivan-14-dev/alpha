import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

process.env.DATABASE_PATH = ':memory:';
const { app } = await import('../server/app.js');
const { all, one, run, transaction } = await import('../server/db.js');
const { audit } = await import('../server/core.js');
const { runJob, jobExists } = await import('../server/platform/jobs.js');
const { personalDataHandlers } = await import('../server/platform/privacy.js');
const { setIntegrationsFetchForTests } = await import('../server/integrations/http.js');
const { allowWebhookAddressesForTests, setWebhookResolverForTests, isPublicAddress, parseWebhookUrl, vetWebhookUrl } = await import('../server/integrations/ssrf.js');
const { setImmediateDeliveryForTests, BACKOFF_MS, MAX_ATTEMPTS, DISABLE_AFTER_FAILURES } = await import('../server/integrations/outgoing.js');
const { publicEventType } = await import('../server/integrations/catalog.js');

interface Actor { id: string; name: string; email: string; cookie: string }
interface FakeCall { method: string; url: URL; body: string; headers: Headers }
type FakeHandler = (call: FakeCall) => Response | Promise<Response>;

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => new Response(status === 204 ? null : JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json', ...headers },
});
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const hmac = (secret: string, value: string) => createHmac('sha256', secret).update(value).digest('hex');
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function settle() { for (let index = 0; index < 5; index += 1) await tick(); }

test('V4 integrations: OAuth, sources, inbound and outgoing webhooks', async (t) => {
  // ---- fake provider APIs (no request ever leaves the machine) ------------------------------------
  const fakes: { method: string; pattern: RegExp; handler: FakeHandler }[] = [];
  const calls: FakeCall[] = [];
  const fake = (method: string, pattern: RegExp, handler: FakeHandler) => { fakes.unshift({ method, pattern, handler }); };
  setIntegrationsFetchForTests(async (input, init = {}) => {
    const call: FakeCall = {
      method: (init.method ?? 'GET').toUpperCase(),
      url: new URL(String(input)),
      body: typeof init.body === 'string' ? init.body : '',
      headers: new Headers(init.headers),
    };
    assert.equal(init.redirect, 'error', 'provider calls must refuse redirects');
    calls.push(call);
    const route = fakes.find((item) => item.method === call.method && item.pattern.test(call.url.toString()));
    return route ? route.handler(call) : json({ message: 'Not Found' }, 404);
  });
  setImmediateDeliveryForTests(false);

  // ---- local webhook receiver (reachable only through the explicit test override) ------------------
  const received: { headers: IncomingHttpHeaders; body: string; url: string }[] = [];
  let receiverStatus = 200;
  let receiverHeaders: Record<string, string> = {};
  const receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      received.push({ headers: req.headers, body, url: req.url ?? '' });
      res.writeHead(receiverStatus, receiverHeaders);
      res.end('ok');
    });
  });
  receiver.listen(0, '127.0.0.1');
  await once(receiver, 'listening');
  const receiverPort = (receiver.address() as AddressInfo).port;
  const hookUrl = `http://127.0.0.1:${receiverPort}/hook`;

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const base = `${origin}/api`;
  t.after(async () => {
    setIntegrationsFetchForTests(null);
    allowWebhookAddressesForTests(null);
    setWebhookResolverForTests(null);
    setImmediateDeliveryForTests(true);
    await new Promise<void>((resolve) => { receiver.close(() => resolve()); receiver.closeAllConnections(); });
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  });

  async function call<T = Record<string, any>>(actor: Actor | null, path: string, expected = 200, method = 'GET', body?: unknown): Promise<T> {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        'X-Alpha-Client': 'web',
        Origin: 'http://127.0.0.1:5173',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(actor?.cookie ? { Cookie: actor.cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    assert.equal(response.status, expected, `${method} ${path}: ${text}`);
    const data = text ? JSON.parse(text) : {};
    if (expected >= 400) assert.equal(typeof data.error, 'string');
    return data as T;
  }

  async function redirectOf(actor: Actor | null, path: string, headers: Record<string, string> = {}) {
    const response = await fetch(`${base}${path}`, { redirect: 'manual', headers: { ...(actor?.cookie ? { Cookie: actor.cookie } : {}), ...headers } });
    return { status: response.status, location: response.headers.get('location') ?? '', body: await response.text() };
  }

  async function register(name: string): Promise<Actor> {
    const email = `${name.toLowerCase()}-${randomUUID().slice(0, 8)}@example.test`;
    const response = await fetch(`${base}/auth/register`, {
      method: 'POST',
      headers: { 'X-Alpha-Client': 'web', Origin: 'http://127.0.0.1:5173', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password: 'Alpha-test-password-2026!', accept_terms: true }),
    });
    const text = await response.text();
    assert.equal(response.status, 201, text);
    return { id: JSON.parse(text).user.id, name, email, cookie: response.headers.get('set-cookie')!.split(';', 1)[0] };
  }

  const owner = await register('Owner');
  const tester = await register('Tester');
  const outsider = await register('Outsider');
  const admin = await register('Admin');
  run("UPDATE users SET role='admin' WHERE id=?", admin.id);

  const projectId = randomUUID();
  const campaignId = randomUUID();
  const applicationId = randomUUID();
  const missionId = randomUUID();
  run(`INSERT INTO projects (id,owner_id,title,summary,category,visibility) VALUES (?,?,?,?,?,'private')`, projectId, owner.id, 'Projet Alpha', 'Résumé', 'web');
  run(`INSERT INTO campaigns (id,project_id,owner_id,title,description,reward_cents,slots,deadline) VALUES (?,?,?,?,?,?,?,?)`,
    campaignId, projectId, owner.id, 'Campagne bêta', 'Tester la bêta', 2500, 3, '2099-01-01');
  run(`INSERT INTO applications (id,campaign_id,tester_id,motivation,status) VALUES (?,?,?,?,'accepted')`, applicationId, campaignId, tester.id, 'MOTIVATION-PRIVEE');
  run(`INSERT INTO missions (id,campaign_id,tester_id,application_id,status) VALUES (?,?,?,?,'in_progress')`, missionId, campaignId, tester.id, applicationId);

  const sealedSecrets: string[] = [];
  const plainSecrets: string[] = [];
  const assertNoLeak = (value: unknown) => {
    const text = JSON.stringify(value);
    for (const secret of plainSecrets) assert.ok(!text.includes(secret), `secret leaked: ${secret.slice(0, 6)}…`);
    assert.ok(!/_sealed|"v1\.[A-Za-z0-9_-]{10}/.test(text), 'sealed value leaked');
    for (const sealed of sealedSecrets) assert.ok(!text.includes(sealed));
  };

  await t.test('admin configures OAuth apps; client secrets are never returned', async () => {
    await call(null, '/integrations/admin/providers', 401);
    await call(owner, '/integrations/admin/providers', 403);
    await call(owner, '/integrations/admin/providers/github', 403, 'PUT', { enabled: true, client_id: 'x' });
    await call(admin, '/integrations/admin/providers/github', 400, 'PUT', { enabled: true, client_id: 'gh-client' });
    await call(admin, '/integrations/admin/providers/github', 400, 'PUT', { enabled: true, client_id: 'gh-client', client_secret: 'x'.repeat(10), extra: 1 });
    plainSecrets.push('gh-client-secret-123', 'gl-client-secret-456', 'fg-client-secret-789');
    const github = await call(admin, '/integrations/admin/providers/github', 200, 'PUT', { enabled: true, client_id: 'gh-client', client_secret: 'gh-client-secret-123' });
    assert.equal(github.provider.client_secret.configured, true);
    assert.equal(github.provider.callback_url, 'http://127.0.0.1:5173/api/integrations/oauth/github/callback');
    assert.deepEqual(github.provider.scopes, ['read:user', 'admin:repo_hook']);
    await call(admin, '/integrations/admin/providers/figma', 400, 'PUT', { enabled: false, client_id: 'f', base_url: 'https://evil.example' });
    const gitlab = await call(admin, '/integrations/admin/providers/gitlab', 200, 'PUT', {
      enabled: true, client_id: 'gl-client', client_secret: 'gl-client-secret-456', base_url: 'https://gitlab.example.com/', scopes: ['read_api', 'read_user', 'api'],
    });
    assert.equal(gitlab.provider.base_url, 'https://gitlab.example.com');
    assert.equal(gitlab.provider.pkce, true);
    await call(admin, '/integrations/admin/providers/figma', 200, 'PUT', { enabled: true, client_id: 'fg-client', client_secret: 'fg-client-secret-789' });
    // Keeping the secret: omit client_secret.
    const unchanged = await call(admin, '/integrations/admin/providers/figma', 200, 'PUT', { enabled: true, client_id: 'fg-client' });
    assert.equal(unchanged.provider.client_secret.configured, true);
    const listing = await call(admin, '/integrations/admin/providers');
    assertNoLeak(listing);
    assert.equal(listing.providers.length, 3);
    assert.ok(one("SELECT id FROM audit_events WHERE action='admin.integrations.provider_updated' AND actor_id=?", admin.id));
    const providers = await call(owner, '/integrations/providers');
    assert.deepEqual(providers.providers.map((item: { enabled: boolean }) => item.enabled), [true, true, true]);
  });

  let githubState = '';
  await t.test('OAuth state is hashed, user-bound, provider-bound, single-use and expires', async () => {
    await call(null, '/integrations/oauth/github/start', 401);
    const start = await call(owner, '/integrations/oauth/github/start?return_to=/projects/abc');
    const authorize = new URL(start.authorize_url);
    assert.equal(authorize.origin + authorize.pathname, 'https://github.com/login/oauth/authorize');
    assert.equal(authorize.searchParams.get('client_id'), 'gh-client');
    assert.equal(authorize.searchParams.get('redirect_uri'), 'http://127.0.0.1:5173/api/integrations/oauth/github/callback');
    assert.equal(authorize.searchParams.get('scope'), 'read:user admin:repo_hook');
    assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
    const state = authorize.searchParams.get('state')!;
    const challenge = authorize.searchParams.get('code_challenge')!;
    assert.ok(state.length >= 40);
    assert.ok(!one('SELECT 1 FROM integration_oauth_states WHERE state_hash=?', state), 'raw state must not be stored');
    assert.ok(one('SELECT 1 FROM integration_oauth_states WHERE state_hash=? AND user_id=?', sha256(state), owner.id));

    const priv = new URL((await call(owner, '/integrations/oauth/github/start?access=private&return_to=//evil.example')).authorize_url);
    assert.equal(priv.searchParams.get('scope'), 'read:user admin:repo_hook repo');
    const evil = one<{ return_to: string }>('SELECT return_to FROM integration_oauth_states WHERE state_hash=?', sha256(priv.searchParams.get('state')!))!;
    assert.equal(evil.return_to, '/integrations');

    const crossSite = await redirectOf(owner, '/integrations/oauth/github/start', { 'Sec-Fetch-Site': 'cross-site' });
    assert.equal(crossSite.status, 403);
    const navigation = await redirectOf(owner, '/integrations/oauth/github/start', { 'Sec-Fetch-Site': 'same-origin' });
    assert.equal(navigation.status, 302);
    assert.match(navigation.location, /^https:\/\/github\.com\/login\/oauth\/authorize\?/);

    let verifier = '';
    fake('POST', /^https:\/\/github\.com\/login\/oauth\/access_token$/, ({ body, headers }) => {
      const form = new URLSearchParams(body);
      assert.equal(headers.get('accept'), 'application/json');
      assert.equal(form.get('client_secret'), 'gh-client-secret-123');
      if (form.get('code') !== 'good-code') return json({ error: 'bad_verification_code' });
      verifier = form.get('code_verifier') ?? '';
      return json({ access_token: 'gho_secret_access_token', token_type: 'bearer', scope: 'read:user,admin:repo_hook' });
    });
    fake('GET', /^https:\/\/api\.github\.com\/user$/, ({ headers }) => {
      assert.equal(headers.get('authorization'), 'Bearer gho_secret_access_token');
      return json({ id: 42, login: 'octo-owner' });
    });
    plainSecrets.push('gho_secret_access_token');

    // Signed out, another member, wrong provider: rejected; another member cannot burn the owner's state.
    assert.equal((await redirectOf(null, `/integrations/oauth/github/callback?state=${state}&code=good-code`)).location, '/integrations?integration_error=session');
    assert.equal((await redirectOf(outsider, `/integrations/oauth/github/callback?state=${state}&code=good-code`)).location, '/integrations?integration_error=state');
    assert.ok(one('SELECT 1 FROM integration_oauth_states WHERE state_hash=?', sha256(state)));
    const other = new URL((await call(owner, '/integrations/oauth/github/start')).authorize_url).searchParams.get('state')!;
    assert.equal((await redirectOf(owner, `/integrations/oauth/gitlab/callback?state=${other}&code=good-code`)).location, '/integrations?integration_error=state');
    assert.equal((await redirectOf(owner, `/integrations/oauth/github/callback?state=${other}&code=good-code`)).location, '/integrations?integration_error=state', 'consumed');
    assert.equal((await redirectOf(owner, '/integrations/oauth/github/callback?state=forged&code=good-code')).location, '/integrations?integration_error=state');
    const denied = new URL((await call(owner, '/integrations/oauth/github/start')).authorize_url).searchParams.get('state')!;
    assert.equal((await redirectOf(owner, `/integrations/oauth/github/callback?state=${denied}&error=access_denied`)).location, '/integrations?integration_error=denied');
    const badCode = new URL((await call(owner, '/integrations/oauth/github/start')).authorize_url).searchParams.get('state')!;
    assert.equal((await redirectOf(owner, `/integrations/oauth/github/callback?state=${badCode}&code=bad`)).location, '/integrations?integration_error=exchange');
    const expired = new URL((await call(owner, '/integrations/oauth/github/start')).authorize_url).searchParams.get('state')!;
    run('UPDATE integration_oauth_states SET expires_at=? WHERE state_hash=?', new Date(Date.now() - 1000).toISOString(), sha256(expired));
    assert.equal((await redirectOf(owner, `/integrations/oauth/github/callback?state=${expired}&code=good-code`)).location, '/integrations?integration_error=state');

    const success = await redirectOf(owner, `/integrations/oauth/github/callback?state=${state}&code=good-code`);
    assert.equal(success.status, 302);
    assert.equal(success.location, '/projects/abc?connected=github');
    assert.equal(createHash('sha256').update(verifier).digest('base64url'), challenge, 'PKCE verifier matches the challenge');
    assert.equal((await redirectOf(owner, `/integrations/oauth/github/callback?state=${state}&code=good-code`)).location, '/integrations?integration_error=state', 'replay');
    githubState = state;

    const row = one<{ access_token_sealed: string; external_login: string; scopes: string }>('SELECT * FROM integration_connections WHERE user_id=? AND provider=?', owner.id, 'github')!;
    assert.ok(row.access_token_sealed.startsWith('v1.'));
    assert.ok(!row.access_token_sealed.includes('gho_secret_access_token'));
    sealedSecrets.push(row.access_token_sealed);
    assert.equal(row.external_login, 'octo-owner');
    assert.deepEqual(JSON.parse(row.scopes), ['read:user', 'admin:repo_hook']);
    const connections = await call(owner, '/integrations/connections');
    assert.equal(connections.connections.length, 1);
    assertNoLeak(connections);
    assert.deepEqual(Object.keys(connections.connections[0]).filter((key) => /token/.test(key)), []);
    assert.deepEqual((await call(outsider, '/integrations/connections')).connections, []);
  });

  await t.test('GitLab uses PKCE on the configured instance and refreshes expiring tokens once', async () => {
    let refreshes = 0;
    fake('POST', /^https:\/\/gitlab\.example\.com\/oauth\/token$/, ({ body }) => {
      const form = new URLSearchParams(body);
      if (form.get('grant_type') === 'authorization_code') {
        assert.ok(form.get('code_verifier'));
        return json({ access_token: 'glat-first', refresh_token: 'glrt-first', expires_in: 7200, scope: 'read_api read_user api' });
      }
      assert.equal(form.get('grant_type'), 'refresh_token');
      assert.equal(form.get('refresh_token'), 'glrt-first');
      refreshes += 1;
      return json({ access_token: 'glat-second', refresh_token: 'glrt-second', expires_in: 7200 });
    });
    fake('GET', /^https:\/\/gitlab\.example\.com\/api\/v4\/user$/, () => json({ id: 7, username: 'gl-owner' }));
    fake('GET', /^https:\/\/gitlab\.example\.com\/api\/v4\/projects\?/, ({ headers, url }) => {
      assert.equal(headers.get('authorization'), 'Bearer glat-second');
      assert.equal(url.searchParams.get('membership'), 'true');
      return json([{ id: 2002, path_with_namespace: 'acme/web', web_url: 'https://gitlab.example.com/acme/web', visibility: 'private', default_branch: 'main' }], 200, { 'x-next-page': '2' });
    });
    plainSecrets.push('glat-first', 'glrt-first', 'glat-second', 'glrt-second');
    const authorize = new URL((await call(owner, '/integrations/oauth/gitlab/start')).authorize_url);
    assert.equal(authorize.origin + authorize.pathname, 'https://gitlab.example.com/oauth/authorize');
    assert.equal(authorize.searchParams.get('scope'), 'read_api read_user api');
    assert.ok(authorize.searchParams.get('code_challenge'));
    const done = await redirectOf(owner, `/integrations/oauth/gitlab/callback?state=${authorize.searchParams.get('state')}&code=gl-code`);
    assert.equal(done.location, '/integrations?connected=gitlab');
    run("UPDATE integration_connections SET expires_at=? WHERE user_id=? AND provider='gitlab'", new Date(Date.now() + 10_000).toISOString(), owner.id);
    const [first, second] = await Promise.all([
      call(owner, '/integrations/gitlab/projects?page=1'),
      call(owner, '/integrations/gitlab/projects?page=1'),
    ]);
    assert.equal(refreshes, 1, 'concurrent requests share a single refresh');
    assert.equal(first.items[0].full_name, 'acme/web');
    assert.equal(second.has_more, true);
    const row = one<{ refresh_token_sealed: string; expires_at: string }>("SELECT * FROM integration_connections WHERE user_id=? AND provider='gitlab'", owner.id)!;
    assert.ok(Date.parse(row.expires_at) > Date.now() + 3600_000);
    assert.ok(!row.refresh_token_sealed.includes('glrt-second'));
    await call(outsider, '/integrations/gitlab/projects', 409);
  });

  await t.test('Figma OAuth uses Basic client authentication and no PKCE', async () => {
    fake('POST', /^https:\/\/api\.figma\.com\/v1\/oauth\/token$/, ({ headers, body }) => {
      assert.equal(headers.get('authorization'), `Basic ${Buffer.from('fg-client:fg-client-secret-789').toString('base64')}`);
      assert.equal(new URLSearchParams(body).get('grant_type'), 'authorization_code');
      return json({ access_token: 'figd_access', refresh_token: 'figd_refresh', expires_in: 7776000 });
    });
    fake('GET', /^https:\/\/api\.figma\.com\/v1\/me$/, () => json({ id: 'f-1', handle: 'designer', email: 'private@example.test' }));
    plainSecrets.push('figd_access', 'figd_refresh');
    const authorize = new URL((await call(owner, '/integrations/oauth/figma/start')).authorize_url);
    assert.equal(authorize.origin + authorize.pathname, 'https://www.figma.com/oauth');
    assert.equal(authorize.searchParams.get('code_challenge'), null);
    assert.equal(authorize.searchParams.get('scope'), 'current_user:read,file_content:read,file_metadata:read,webhooks:write');
    const done = await redirectOf(owner, `/integrations/oauth/figma/callback?state=${authorize.searchParams.get('state')}&code=fg-code`);
    assert.equal(done.location, '/integrations?connected=figma');
    const connections = await call(owner, '/integrations/connections');
    assert.equal(connections.connections.length, 3);
    assert.ok(!JSON.stringify(connections).includes('private@example.test'));
  });

  const sources: Record<string, { id: string; secret: string }> = {};
  await t.test('project sources: authorization, automatic hooks, manual fallback, duplicates', async () => {
    const githubHook: { body?: any } = {};
    fake('GET', /^https:\/\/api\.github\.com\/repos\/acme\/app$/, () => json({
      id: 1001, full_name: 'acme/app', html_url: 'https://github.com/acme/app', private: false, default_branch: 'main', permissions: { admin: true },
    }));
    fake('POST', /^https:\/\/api\.github\.com\/repos\/acme\/app\/hooks$/, ({ body }) => { githubHook.body = JSON.parse(body); return json({ id: 555 }, 201); });
    fake('GET', /^https:\/\/gitlab\.example\.com\/api\/v4\/projects\/acme%2Fweb$/, () => json({
      id: 2002, path_with_namespace: 'acme/web', web_url: 'https://gitlab.example.com/acme/web', visibility: 'private', default_branch: 'main',
    }));
    fake('POST', /^https:\/\/gitlab\.example\.com\/api\/v4\/projects\/2002\/hooks$/, () => json({ message: '403 Forbidden' }, 403));
    const figmaHooks: any[] = [];
    fake('GET', /^https:\/\/api\.figma\.com\/v1\/files\/AbCdEf123456\/meta$/, () => json({ file: { name: 'Maquettes Alpha' } }));
    fake('POST', /^https:\/\/api\.figma\.com\/v2\/webhooks$/, ({ body }) => { figmaHooks.push(JSON.parse(body)); return json({ id: `fw-${figmaHooks.length}` }); });

    const path = `/integrations/projects/${projectId}/sources`;
    await call(null, path, 401, 'POST', { provider: 'github', full_name: 'acme/app' });
    await call(outsider, path, 403, 'POST', { provider: 'github', full_name: 'acme/app' });
    await call(tester, path, 403, 'POST', { provider: 'github', full_name: 'acme/app' });
    await call(tester, path, 403);
    await call(owner, path, 400, 'POST', { provider: 'github', full_name: '../etc' });
    await call(owner, path, 400, 'POST', { provider: 'bitbucket', full_name: 'acme/app' });

    const github = await call(owner, path, 201, 'POST', { provider: 'github', full_name: 'acme/app' });
    assert.equal(github.setup.mode, 'automatic');
    assert.equal(github.setup.secret, undefined, 'automatic setup never returns the secret');
    assert.equal(github.source.default_branch, 'main');
    assert.deepEqual(githubHook.body.events, ['push', 'release']);
    assert.equal(githubHook.body.config.url, `http://127.0.0.1:5173/api/integrations/webhooks/github/${github.source.id}`);
    assert.equal(githubHook.body.config.content_type, 'json');
    sources.github = { id: github.source.id, secret: githubHook.body.config.secret };
    await call(owner, path, 409, 'POST', { provider: 'github', full_name: 'acme/app' });

    const gitlab = await call(owner, path, 201, 'POST', { provider: 'gitlab', full_name: 'acme/web' });
    assert.equal(gitlab.setup.mode, 'manual');
    assert.match(gitlab.setup.reason, /droits/);
    assert.equal(gitlab.setup.url, `http://127.0.0.1:5173/api/integrations/webhooks/gitlab/${gitlab.source.id}`);
    assert.ok(gitlab.setup.secret.length >= 40);
    assert.ok(gitlab.setup.instructions.length >= 3);
    sources.gitlab = { id: gitlab.source.id, secret: gitlab.setup.secret };

    const figma = await call(owner, path, 201, 'POST', { provider: 'figma', file_key: 'AbCdEf123456' });
    assert.equal(figma.setup.mode, 'automatic');
    assert.deepEqual(figmaHooks.map((hook) => hook.event_type), ['FILE_VERSION_UPDATE', 'FILE_COMMENT']);
    assert.equal(figmaHooks[0].context, 'file');
    assert.equal(figmaHooks[0].context_id, 'AbCdEf123456');
    assert.ok(figmaHooks[0].passcode.length <= 100);
    assert.equal(figma.source.full_name, 'Maquettes Alpha');
    sources.figma = { id: figma.source.id, secret: figmaHooks[0].passcode };
    plainSecrets.push(sources.github.secret, sources.gitlab.secret, sources.figma.secret);

    const listing = await call(owner, path);
    assert.equal(listing.sources.length, 3);
    assertNoLeak(listing);
    const stored = one<{ webhook_secret_sealed: string; provider_webhook_id: string }>('SELECT * FROM integration_project_sources WHERE id=?', sources.figma.id)!;
    assert.equal(stored.provider_webhook_id, 'fw-1,fw-2');
    assert.ok(!stored.webhook_secret_sealed.includes(sources.figma.secret));

    // Rotation only for manual sources; the new secret is shown once.
    await call(owner, `${path}/${sources.github.id}/rotate-secret`, 409, 'POST', {});
    await call(outsider, `${path}/${sources.gitlab.id}/rotate-secret`, 403, 'POST', {});
    const rotated = await call(owner, `${path}/${sources.gitlab.id}/rotate-secret`, 200, 'POST', {});
    assert.notEqual(rotated.setup.secret, sources.gitlab.secret);
    sources.gitlab.secret = rotated.setup.secret;
    plainSecrets.push(rotated.setup.secret);
  });

  let endpoint: { id: string; secret: string } = { id: '', secret: '' };
  await t.test('outgoing endpoints: authorization, validation and SSRF checks at creation', async () => {
    allowWebhookAddressesForTests(['127.0.0.1']);
    const path = `/integrations/projects/${projectId}/endpoints`;
    const events = ['campaign.created', 'application.created', 'report.submitted', 'mission.paid', 'source.release', 'source.push'];
    await call(null, path, 401, 'POST', { url: hookUrl, events });
    await call(outsider, path, 403, 'POST', { url: hookUrl, events });
    await call(tester, path, 403, 'POST', { url: hookUrl, events });
    await call(owner, path, 400, 'POST', { url: hookUrl, events: [] });
    await call(owner, path, 400, 'POST', { url: hookUrl, events: ['user.deleted'] });
    for (const url of ['http://localhost:9999/hook', 'http://169.254.169.254/latest/meta-data', 'http://10.0.0.5/x', 'http://192.168.1.10/x',
      'http://[::1]:8080/x', 'http://user:pass@example.com/x', 'ftp://example.com/x', 'http://0.0.0.0/x', 'http://[::ffff:127.0.0.1]/x']) {
      await call(owner, path, 400, 'POST', { url, events });
    }
    setWebhookResolverForTests(async (hostname) => hostname === 'rebind.example.test' ? [{ address: '127.0.0.2', family: 4 }]
      : hostname === 'mixed.example.test' ? [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }]
        : hostname === 'v6.example.test' ? [{ address: 'fe80::1', family: 6 }] : [{ address: '127.0.0.1', family: 4 }]);
    const refused = await call(owner, path, 400, 'POST', { url: 'http://rebind.example.test/hook', events });
    assert.match(refused.error, /adresse privée/);
    await call(owner, path, 400, 'POST', { url: 'http://mixed.example.test/hook', events });
    await call(owner, path, 400, 'POST', { url: 'http://v6.example.test/hook', events });

    const created = await call(owner, path, 201, 'POST', { url: hookUrl, description: 'CI', events });
    assert.match(created.secret, /^whsec_[A-Za-z0-9_-]{40,}$/);
    endpoint = { id: created.endpoint.id, secret: created.secret };
    plainSecrets.push(created.secret);
    const listing = await call(owner, path);
    assert.equal(listing.endpoints.length, 1);
    assertNoLeak(listing);
    await call(outsider, path, 403);
    await call(outsider, `/integrations/endpoints/${endpoint.id}`, 404, 'PATCH', { active: false });
    await call(outsider, `/integrations/endpoints/${endpoint.id}/deliveries`, 404);
    await call(outsider, `/integrations/endpoints/${endpoint.id}`, 404, 'DELETE');
    const catalog = await call(owner, '/integrations/endpoints/catalog');
    assert.ok(catalog.events.some((item: { type: string }) => item.type === 'order.created'));
  });

  const signatureParts = (header: string) => {
    const parts = header.split(',').map((part) => part.split('='));
    return { t: parts.find(([key]) => key === 't')![1], v1: parts.filter(([key]) => key === 'v1').map(([, value]) => value) };
  };

  await t.test('domain events become signed deliveries with minimal payloads', async () => {
    assert.equal(publicEventType('demo.marketplace.purchased'), 'order.created');
    assert.equal(publicEventType('marketplace.listing.edited'), 'listing.updated');
    assert.equal(publicEventType('sandbox.mission.paid'), 'mission.paid');
    assert.equal(publicEventType('auth.password_changed'), null);
    transaction(() => audit(owner.id, 'campaign.created', 'campaign', campaignId));
    transaction(() => audit(tester.id, 'application.created', 'application', applicationId));
    transaction(() => audit(owner.id, 'project.updated', 'project', projectId)); // not subscribed
    transaction(() => audit(owner.id, 'demo.mission.paid', 'mission', missionId));
    // A rolled-back business action never produces a delivery.
    assert.throws(() => transaction(() => { audit(owner.id, 'report.submitted', 'mission', missionId); throw new Error('rollback'); }));
    const pending = all<{ event_type: string; status: string }>('SELECT event_type,status FROM integration_webhook_deliveries WHERE endpoint_id=? ORDER BY created_at', endpoint.id);
    assert.deepEqual(pending.map((row) => row.event_type).sort(), ['application.created', 'campaign.created', 'mission.paid']);
    assert.ok(pending.every((row) => row.status === 'pending'));
    assert.ok(jobExists('integrations.deliver'));
    received.length = 0;
    await runJob('integrations.deliver');
    assert.equal(received.length, 3);
    for (const request of received) {
      const { t: timestamp, v1 } = signatureParts(String(request.headers['x-alpha-signature']));
      assert.ok(Math.abs(Number(timestamp) - Date.now() / 1000) < 60);
      assert.deepEqual(v1, [hmac(endpoint.secret, `${timestamp}.${request.body}`)]);
      const body = JSON.parse(request.body);
      assert.equal(request.headers['x-alpha-event'], body.type);
      assert.equal(request.headers['content-type'], 'application/json');
      assert.match(String(request.headers['x-alpha-delivery']), /^[0-9a-f-]{36}$/);
      assert.match(body.id, /^evt_/);
      assert.equal(body.data.project_id, projectId);
      assert.ok(!request.body.includes('MOTIVATION-PRIVEE'));
      assert.ok(!request.body.includes(tester.email) && !request.body.includes(owner.email));
    }
    const campaign = JSON.parse(received.find((item) => item.headers['x-alpha-event'] === 'campaign.created')!.body);
    assert.deepEqual(campaign.data.campaign, { id: campaignId, title: 'Campagne bêta', status: 'open', slots: 3, deadline: '2099-01-01', reward_cents: 2500 });
    const application = JSON.parse(received.find((item) => item.headers['x-alpha-event'] === 'application.created')!.body);
    assert.deepEqual(Object.keys(application.data.application).sort(), ['campaign_id', 'created_at', 'id', 'status', 'tester_id']);
    assert.ok(all<{ status: string }>('SELECT status FROM integration_webhook_deliveries WHERE endpoint_id=?', endpoint.id).every((row) => row.status === 'succeeded'));
    assert.equal(one<{ consecutive_failures: number }>('SELECT consecutive_failures FROM integration_webhook_endpoints WHERE id=?', endpoint.id)!.consecutive_failures, 0);
  });

  const githubPost = (sourceId: string, event: string, delivery: string, payload: unknown, secret = sources.github.secret, extra: Record<string, string> = {}) => {
    const body = JSON.stringify(payload);
    return fetch(`${base}/integrations/webhooks/github/${sourceId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': event, 'X-GitHub-Delivery': delivery, 'X-Hub-Signature-256': `sha256=${hmac(secret, body)}`, ...extra },
      body,
    });
  };
  const notificationsFor = (userId: string, kind: string) => all<{ title: string; body: string; link: string }>('SELECT title,body,link FROM notifications WHERE user_id=? AND kind=? ORDER BY created_at', userId, kind);

  await t.test('GitHub inbound webhooks: HMAC, replay protection, push and release effects', async () => {
    const ping = await githubPost(sources.github.id, 'ping', 'gh-1', { zen: 'Keep it logically awesome.', hook_id: 555 });
    assert.equal(ping.status, 200);
    assert.deepEqual(await ping.json(), { received: true, status: 'processed' });

    const bad = await githubPost(sources.github.id, 'ping', 'gh-bad', { zen: 'x' }, 'wrong-secret');
    assert.equal(bad.status, 401);
    const badBody = await bad.json();
    assert.deepEqual(badBody, { error: 'Non autorisé.' });
    const unknown = await githubPost(randomUUID(), 'ping', 'gh-unknown', { zen: 'x' });
    assert.equal(unknown.status, 401);
    assert.deepEqual(await unknown.json(), badBody, 'unknown sources are indistinguishable from bad signatures');
    const crossProvider = await fetch(`${base}/integrations/webhooks/gitlab/${sources.github.id}`, { method: 'POST', headers: { 'X-Gitlab-Token': sources.github.secret }, body: '{}' });
    assert.equal(crossProvider.status, 401);
    const unsigned = await fetch(`${base}/integrations/webhooks/github/${sources.github.id}`, { method: 'POST', headers: { 'X-GitHub-Event': 'ping', 'X-GitHub-Delivery': 'gh-2' }, body: '{}' });
    assert.equal(unsigned.status, 401);
    // Signature over different bytes (re-serialised JSON) is rejected.
    const tampered = await fetch(`${base}/integrations/webhooks/github/${sources.github.id}`, {
      method: 'POST', body: '{"zen": "x"}',
      headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'ping', 'X-GitHub-Delivery': 'gh-3', 'X-Hub-Signature-256': `sha256=${hmac(sources.github.secret, '{"zen":"x"}')}` },
    });
    assert.equal(tampered.status, 401);

    const push = { ref: 'refs/heads/main', repository: { default_branch: 'main' }, commits: [{ id: 'a' }, { id: 'b' }], pusher: { name: 'octo-owner' }, head_commit: { id: 'abcdef1234567', message: 'Corrige la connexion\n\nDétails' } };
    assert.equal((await githubPost(sources.github.id, 'push', 'gh-push-1', push)).status, 200);
    const replay = await githubPost(sources.github.id, 'push', 'gh-push-1', push);
    assert.deepEqual(await replay.json(), { received: true, duplicate: true });
    assert.equal(one<{ total: number }>("SELECT COUNT(*) AS total FROM integration_inbound_events WHERE provider='github' AND delivery_id='gh-push-1'")!.total, 1);
    const pushEvent = one<{ status: string; summary: string }>("SELECT status,summary FROM integration_inbound_events WHERE delivery_id='gh-push-1'")!;
    assert.equal(pushEvent.status, 'processed');
    assert.equal(pushEvent.summary, 'Push sur main : 2 commits par octo-owner — abcdef1 Corrige la connexion');
    assert.equal(notificationsFor(owner.id, 'integrations.activity').length, 1);
    assert.equal(notificationsFor(tester.id, 'integrations.activity').length, 0);
    await githubPost(sources.github.id, 'push', 'gh-push-2', push);
    assert.equal(notificationsFor(owner.id, 'integrations.activity').length, 1, 'push notifications are throttled');
    await githubPost(sources.github.id, 'push', 'gh-push-3', { ...push, ref: 'refs/heads/feature' });
    assert.equal(one<{ status: string }>("SELECT status FROM integration_inbound_events WHERE delivery_id='gh-push-3'")!.status, 'ignored');

    const release = { action: 'published', release: { tag_name: 'v1.2.0', name: 'Version 1.2', prerelease: false, html_url: 'https://github.com/acme/app/releases/v1.2.0' } };
    assert.equal((await githubPost(sources.github.id, 'release', 'gh-rel-1', release)).status, 200);
    for (const member of [owner, tester]) {
      const notes = notificationsFor(member.id, 'testing.release');
      assert.equal(notes.length, 1);
      assert.equal(notes[0].title, 'Nouvelle version disponible : v1.2.0');
      assert.equal(notes[0].link, `/projects/${projectId}`);
    }
    assert.equal(notificationsFor(outsider.id, 'testing.release').length, 0);
    await githubPost(sources.github.id, 'release', 'gh-rel-2', release);
    assert.equal(notificationsFor(tester.id, 'testing.release').length, 1, 'the same version is announced once');
    await githubPost(sources.github.id, 'release', 'gh-rel-3', { ...release, action: 'edited' });
    assert.equal(one<{ status: string }>("SELECT status FROM integration_inbound_events WHERE delivery_id='gh-rel-3'")!.status, 'ignored');

    // Form-encoded payloads are verified over the raw bytes too.
    const formBody = `payload=${encodeURIComponent(JSON.stringify({ zen: 'form' }))}`;
    const form = await fetch(`${base}/integrations/webhooks/github/${sources.github.id}`, {
      method: 'POST', body: formBody,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-GitHub-Event': 'ping', 'X-GitHub-Delivery': 'gh-form', 'X-Hub-Signature-256': `sha256=${hmac(sources.github.secret, formBody)}` },
    });
    assert.equal(form.status, 200);

    // Inbound activity is forwarded to subscribed outgoing endpoints.
    const forwarded = all<{ event_type: string; payload: string }>("SELECT event_type,payload FROM integration_webhook_deliveries WHERE endpoint_id=? AND event_type LIKE 'source.%'", endpoint.id);
    assert.deepEqual(forwarded.map((row) => row.event_type).sort(), ['source.push', 'source.push', 'source.release']);
    assert.equal(JSON.parse(forwarded.find((row) => row.event_type === 'source.release')!.payload).data.version, 'v1.2.0');
  });

  await t.test('GitLab and Figma inbound webhooks: token/passcode, replay, tags, versions, comments', async () => {
    const gitlabPost = (event: string, uuid: string, payload: unknown, token = sources.gitlab.secret) => fetch(`${base}/integrations/webhooks/gitlab/${sources.gitlab.id}`, {
      method: 'POST', body: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json', 'X-Gitlab-Event': event, 'X-Gitlab-Event-UUID': uuid, 'X-Gitlab-Token': token },
    });
    assert.equal((await gitlabPost('Push Hook', 'gl-0', {}, 'nope')).status, 401);
    assert.equal((await gitlabPost('Push Hook', 'gl-0', {}, '')).status, 401);
    const push = { ref: 'refs/heads/main', after: 'b'.repeat(40), checkout_sha: 'c'.repeat(40), project: { default_branch: 'main' }, total_commits_count: 1, user_username: 'gl-owner', commits: [{ message: 'Ajoute le tableau de bord' }] };
    assert.equal((await gitlabPost('Push Hook', 'gl-1', push)).status, 200);
    assert.deepEqual(await (await gitlabPost('Push Hook', 'gl-1', push)).json(), { received: true, duplicate: true });
    assert.equal((await gitlabPost('Push Hook', 'gl-2', { ...push, after: '0'.repeat(40) })).status, 200);
    assert.equal(one<{ status: string }>("SELECT status FROM integration_inbound_events WHERE delivery_id='gl-2'")!.status, 'ignored');
    await gitlabPost('Tag Push Hook', 'gl-3', { ref: 'refs/tags/v2.0.0', after: 'd'.repeat(40) });
    assert.ok(notificationsFor(tester.id, 'testing.release').some((note) => note.title === 'Nouvelle version disponible : v2.0.0'));
    await gitlabPost('Release Hook', 'gl-4', { action: 'create', tag: 'v2.0.0', name: 'v2.0.0', url: 'https://gitlab.example.com/acme/web/-/releases/v2.0.0' });
    assert.equal(notificationsFor(tester.id, 'testing.release').filter((note) => note.title.endsWith('v2.0.0')).length, 1);
    assert.match(one<{ summary: string }>("SELECT summary FROM integration_inbound_events WHERE delivery_id='gl-4'")!.summary, /déjà annoncée/);

    const figmaPost = (payload: Record<string, unknown>) => fetch(`${base}/integrations/webhooks/figma/${sources.figma.id}`, {
      method: 'POST', body: JSON.stringify(payload), headers: { 'Content-Type': 'application/json' },
    });
    const common = { webhook_id: 'fw-1', file_key: 'AbCdEf123456', file_name: 'Maquettes Alpha', timestamp: '2026-01-01T10:00:00Z' };
    assert.equal((await figmaPost({ ...common, event_type: 'PING', passcode: 'wrong' })).status, 401);
    assert.equal((await figmaPost({ ...common, event_type: 'PING' })).status, 401);
    assert.equal((await figmaPost({ ...common, event_type: 'PING', passcode: sources.figma.secret })).status, 200);
    const version = { ...common, event_type: 'FILE_VERSION_UPDATE', passcode: sources.figma.secret, version_id: '987', label: 'Maquette v3', timestamp: '2026-01-01T11:00:00Z' };
    assert.equal((await figmaPost(version)).status, 200);
    assert.deepEqual(await (await figmaPost(version)).json(), { received: true, duplicate: true });
    assert.ok(notificationsFor(tester.id, 'testing.release').some((note) => note.title === 'Nouvelle version disponible : Maquette v3'));
    const comment = { ...common, event_type: 'FILE_COMMENT', passcode: sources.figma.secret, comment_id: 'c-1', comment: [{ text: 'COMMENTAIRE-CONFIDENTIEL' }], triggered_by: { id: 'u', handle: 'designer' }, timestamp: '2026-01-01T12:00:00Z' };
    assert.equal((await figmaPost(comment)).status, 200);
    const stored = one<{ summary: string; status: string }>("SELECT summary,status FROM integration_inbound_events WHERE provider='figma' AND event_type='FILE_COMMENT'")!;
    assert.equal(stored.status, 'processed');
    assert.ok(!stored.summary.includes('COMMENTAIRE-CONFIDENTIEL'));
    assert.ok(notificationsFor(owner.id, 'integrations.activity').some((note) => note.title === 'Nouveau commentaire Figma'));
    await figmaPost({ ...version, file_key: 'OtherFile1234', version_id: '988' });
    assert.equal(one<{ status: string }>("SELECT status FROM integration_inbound_events WHERE provider='figma' AND summary LIKE 'Fichier Figma différent%'")!.status, 'ignored');

    const log = await call(owner, `/integrations/projects/${projectId}/inbound-events`);
    assert.ok(log.events.length >= 10);
    assertNoLeak(log);
    await call(outsider, `/integrations/projects/${projectId}/inbound-events`, 403);
    await call(tester, `/integrations/projects/${projectId}/sources`, 403);

    // Repeated authentication failures from one client are throttled (uniform answers, no details).
    const ghost = randomUUID();
    let last = 0;
    for (let index = 0; index < 31; index += 1) {
      last = (await fetch(`${base}/integrations/webhooks/gitlab/${ghost}`, { method: 'POST', headers: { 'X-Gitlab-Token': 'x' }, body: '{}' })).status;
    }
    assert.equal(last, 429);
  });

  await t.test('SSRF guard rejects private, loopback, link-local, reserved and mapped addresses', async () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '172.16.5.4', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
      '224.0.0.1', '255.255.255.255', '198.18.0.1', '::', '::1', 'fc00::1', 'fd12::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8',
      '2001:db8::1', '64:ff9b::7f00:1', '2002:7f00:1::1', 'not-an-ip']) {
      assert.equal(isPublicAddress(address), false, address);
    }
    for (const address of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '2606:4700:4700::1111', '2a00:1450:4007:80b::200e']) {
      assert.equal(isPublicAddress(address), true, address);
    }
    allowWebhookAddressesForTests(null);
    await assert.rejects(vetWebhookUrl(hookUrl), /privées/);
    await assert.rejects(vetWebhookUrl('http://rebind.example.test/x'), /privée/);
    allowWebhookAddressesForTests(['127.0.0.1']);
    // DNS rebinding: the request connects to the vetted address, never re-resolves the name.
    const vetted = await vetWebhookUrl(`http://receiver.example.test:${receiverPort}/hook`);
    assert.equal(vetted.address, '127.0.0.1');

    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      assert.throws(() => parseWebhookUrl('http://example.com/hook'), /HTTPS/);
      assert.throws(() => parseWebhookUrl('https://example.com:9000/hook'), /ports/);
      assert.throws(() => parseWebhookUrl('https://intranet/hook'), /privées/);
      assert.equal(parseWebhookUrl('https://example.com:8443/hook').port, '8443');
      assert.throws(() => allowWebhookAddressesForTests(['127.0.0.1']));
      assert.throws(() => setIntegrationsFetchForTests(async () => json({})));
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  await t.test('retries with exponential backoff, dead letters, redelivery and auto-disable', async () => {
    run('UPDATE integration_webhook_endpoints SET url=? WHERE id=?', `http://receiver.example.test:${receiverPort}/hook`, endpoint.id);
    receiverStatus = 500;
    received.length = 0;
    transaction(() => audit(owner.id, 'campaign.created', 'campaign', campaignId));
    const delivery = one<{ id: string }>("SELECT id FROM integration_webhook_deliveries WHERE endpoint_id=? AND status='pending'", endpoint.id)!;
    const state = () => one<{ status: string; attempts: number; next_attempt_at: string | null; response_status: number; last_error: string }>('SELECT * FROM integration_webhook_deliveries WHERE id=?', delivery.id)!;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const before = Date.now();
      await runJob('integrations.deliver');
      const row = state();
      assert.equal(row.attempts, attempt);
      assert.equal(row.response_status, 500);
      if (attempt < MAX_ATTEMPTS) {
        assert.equal(row.status, 'failed');
        const delay = Date.parse(row.next_attempt_at!) - before;
        assert.ok(Math.abs(delay - BACKOFF_MS[attempt - 1]) < 5000, `attempt ${attempt}: ${delay}`);
        await runJob('integrations.deliver');
        assert.equal(state().attempts, attempt, 'not retried before next_attempt_at');
        run('UPDATE integration_webhook_deliveries SET next_attempt_at=? WHERE id=?', new Date(Date.now() - 1000).toISOString(), delivery.id);
      } else {
        assert.equal(row.status, 'dead');
        assert.equal(row.next_attempt_at, null);
      }
    }
    assert.equal(received.filter((item) => item.headers['x-alpha-delivery'] === delivery.id).length, MAX_ATTEMPTS,
      'connected to the vetted address although the name does not exist in DNS');
    assert.equal(BACKOFF_MS[0], 60_000);
    assert.equal(BACKOFF_MS.at(-1), 12 * 3600_000);

    // Redirects are failures, never followed.
    receiverStatus = 302;
    receiverHeaders = { Location: 'http://169.254.169.254/' };
    const ping = await call(owner, `/integrations/endpoints/${endpoint.id}/test`, 200, 'POST', {});
    assert.equal(ping.ok, false);
    assert.match(ping.error, /Redirection/);
    receiverHeaders = {};

    receiverStatus = 200;
    const redelivered = await call(owner, `/integrations/deliveries/${delivery.id}/redeliver`, 200, 'POST', {});
    assert.equal(redelivered.delivery.status, 'succeeded');
    assert.equal(redelivered.delivery.redelivery_of, delivery.id);
    const original = one<{ event_id: string }>('SELECT event_id FROM integration_webhook_deliveries WHERE id=?', delivery.id)!;
    assert.equal(redelivered.delivery.event_id, original.event_id);
    assert.equal(JSON.parse(received.at(-1)!.body).id, original.event_id, 'consumers can deduplicate on the event id');
    await call(outsider, `/integrations/deliveries/${delivery.id}/redeliver`, 404, 'POST', {});

    receiverStatus = 503;
    run('UPDATE integration_webhook_endpoints SET consecutive_failures=? WHERE id=?', DISABLE_AFTER_FAILURES - 1, endpoint.id);
    transaction(() => audit(tester.id, 'application.created', 'application', applicationId));
    await runJob('integrations.deliver');
    const disabled = one<{ active: number; disabled_reason: string }>('SELECT active,disabled_reason FROM integration_webhook_endpoints WHERE id=?', endpoint.id)!;
    assert.equal(disabled.active, 0);
    assert.match(disabled.disabled_reason, /20 échecs consécutifs/);
    assert.ok(notificationsFor(owner.id, 'integrations.webhook').some((note) => note.title === 'Webhook sortant désactivé'));
    const before = one<{ total: number }>('SELECT COUNT(*) AS total FROM integration_webhook_deliveries WHERE endpoint_id=?', endpoint.id)!.total;
    transaction(() => audit(owner.id, 'campaign.created', 'campaign', campaignId));
    assert.equal(one<{ total: number }>('SELECT COUNT(*) AS total FROM integration_webhook_deliveries WHERE endpoint_id=?', endpoint.id)!.total, before, 'disabled endpoints receive nothing');

    receiverStatus = 200;
    const reactivated = await call(owner, `/integrations/endpoints/${endpoint.id}`, 200, 'PATCH', { active: true });
    assert.equal(reactivated.endpoint.active, true);
    assert.equal(reactivated.endpoint.consecutive_failures, 0);
    assert.equal(reactivated.endpoint.disabled_reason, '');
    await runJob('integrations.deliver');
    assert.equal(one<{ status: string }>("SELECT status FROM integration_webhook_deliveries WHERE endpoint_id=? AND event_type='application.created' ORDER BY created_at DESC", endpoint.id)!.status, 'succeeded', 'pending work resumes after reactivation');
  });

  await t.test('test ping, secret rotation grace period and delivery log', async () => {
    received.length = 0;
    const ping = await call(owner, `/integrations/endpoints/${endpoint.id}/test`, 200, 'POST', {});
    assert.equal(ping.ok, true);
    assert.equal(received[0].headers['x-alpha-event'], 'ping');
    const rotated = await call(owner, `/integrations/endpoints/${endpoint.id}/rotate-secret`, 200, 'POST', {});
    assert.match(rotated.secret, /^whsec_/);
    assert.notEqual(rotated.secret, endpoint.secret);
    plainSecrets.push(rotated.secret);
    assert.equal(rotated.endpoint.secret.rotating, true);
    received.length = 0;
    await call(owner, `/integrations/endpoints/${endpoint.id}/test`, 200, 'POST', {});
    const { t: timestamp, v1 } = signatureParts(String(received[0].headers['x-alpha-signature']));
    assert.deepEqual(v1, [hmac(rotated.secret, `${timestamp}.${received[0].body}`), hmac(endpoint.secret, `${timestamp}.${received[0].body}`)]);
    endpoint.secret = rotated.secret;

    const log = await call(owner, `/integrations/endpoints/${endpoint.id}/deliveries`);
    assert.ok(log.deliveries.length >= 5);
    assert.equal(log.deliveries[0].payload, undefined);
    assertNoLeak(log);
    const detail = await call(owner, `/integrations/deliveries/${log.deliveries[0].id}`);
    assert.equal(detail.delivery.payload.type, 'ping');
    await call(outsider, `/integrations/deliveries/${log.deliveries[0].id}`, 404);
    const failed = await call(owner, `/integrations/endpoints/${endpoint.id}/deliveries?status=dead`);
    assert.equal(failed.deliveries.length, 1);
  });

  await t.test('admin sees delivery stats, dead letters (masked URLs) and the inbound log', async () => {
    await call(owner, '/integrations/admin/overview', 403);
    const overview = await call(admin, '/integrations/admin/overview');
    assert.ok(overview.connections.length >= 3);
    assert.equal(overview.endpoints.total, 1);
    const dead = await call(admin, '/integrations/admin/deliveries?status=dead');
    assert.equal(dead.deliveries.length, 1);
    assert.equal(dead.deliveries[0].project_title, 'Projet Alpha');
    assert.equal(dead.deliveries[0].payload, undefined);
    assertNoLeak(dead);
    const inbound = await call(admin, '/integrations/admin/inbound?provider=github');
    assert.ok(inbound.events.every((event: { provider: string }) => event.provider === 'github'));
    await call(admin, '/integrations/admin/inbound?provider=svn', 400);
    receiverStatus = 200;
    const redone = await call(admin, `/integrations/admin/deliveries/${dead.deliveries[0].id}/redeliver`, 200, 'POST', {});
    assert.equal(redone.delivery.status, 'succeeded');
    assert.ok(one("SELECT id FROM audit_events WHERE action='admin.integrations.delivery_redelivered'"));

    await call(owner, '/integrations/admin/webhooks', 403, 'PUT', { enabled: true, max_endpoints_per_project: 1 });
    await call(admin, '/integrations/admin/webhooks', 200, 'PUT', { enabled: true, max_endpoints_per_project: 1 });
    await call(owner, `/integrations/projects/${projectId}/endpoints`, 409, 'POST', { url: hookUrl, events: ['task.created'] });
    await call(admin, '/integrations/admin/webhooks', 200, 'PUT', { enabled: false, max_endpoints_per_project: 10 });
    const deliveriesBefore = one<{ total: number }>('SELECT COUNT(*) AS total FROM integration_webhook_deliveries')!.total;
    transaction(() => audit(owner.id, 'campaign.created', 'campaign', campaignId));
    assert.equal(one<{ total: number }>('SELECT COUNT(*) AS total FROM integration_webhook_deliveries')!.total, deliveriesBefore, 'globally disabled');
    await call(admin, '/integrations/admin/webhooks', 200, 'PUT', { enabled: true, max_endpoints_per_project: 10 });
  });

  await t.test('endpoint owners losing project access stop receiving events', async () => {
    const otherProject = randomUUID();
    const orgId = randomUUID();
    run('INSERT INTO organizations (id,name,owner_id) VALUES (?,?,?)', orgId, 'Org', outsider.id);
    run('INSERT INTO organization_members (organization_id,user_id,role) VALUES (?,?,?)', orgId, tester.id, 'admin');
    run(`INSERT INTO projects (id,owner_id,organization_id,title,summary,category) VALUES (?,?,?,?,?,?)`, otherProject, outsider.id, orgId, 'Projet Org', 'R', 'web');
    const created = await call(tester, `/integrations/projects/${otherProject}/endpoints`, 201, 'POST', { url: hookUrl, events: ['project.updated'] });
    plainSecrets.push(created.secret);
    run("UPDATE organization_members SET role='member' WHERE organization_id=? AND user_id=?", orgId, tester.id);
    transaction(() => audit(outsider.id, 'project.updated', 'project', otherProject));
    const row = one<{ active: number; disabled_reason: string }>('SELECT active,disabled_reason FROM integration_webhook_endpoints WHERE id=?', created.endpoint.id)!;
    assert.equal(row.active, 0);
    assert.match(row.disabled_reason, /ne gère plus/);
    assert.equal(one<{ total: number }>('SELECT COUNT(*) AS total FROM integration_webhook_deliveries WHERE endpoint_id=?', created.endpoint.id)!.total, 0);
    await call(tester, `/integrations/endpoints/${created.endpoint.id}`, 404, 'DELETE');
    await call(outsider, `/integrations/endpoints/${created.endpoint.id}`, 200, 'DELETE');
  });

  await t.test('deleting a source removes the provider webhook; disconnecting revokes the token', async () => {
    let removedHook = '';
    fake('DELETE', /^https:\/\/api\.github\.com\/repos\/acme\/app\/hooks\/\d+$/, ({ url }) => { removedHook = url.pathname; return json(null, 204); });
    await call(outsider, `/integrations/projects/${projectId}/sources/${sources.github.id}`, 403, 'DELETE');
    const deleted = await call(owner, `/integrations/projects/${projectId}/sources/${sources.github.id}`, 200, 'DELETE');
    assert.equal(deleted.provider_webhook_removed, true);
    assert.equal(removedHook, '/repos/acme/app/hooks/555');
    const afterDelete = await githubPost(sources.github.id, 'ping', 'gh-after-delete', { zen: 'x' });
    assert.equal(afterDelete.status, 401);

    let revokedWith = '';
    fake('DELETE', /^https:\/\/api\.github\.com\/applications\/gh-client\/token$/, ({ headers, body }) => {
      assert.equal(headers.get('authorization'), `Basic ${Buffer.from('gh-client:gh-client-secret-123').toString('base64')}`);
      revokedWith = JSON.parse(body).access_token;
      return json(null, 204);
    });
    const github = one<{ id: string }>("SELECT id FROM integration_connections WHERE user_id=? AND provider='github' AND revoked_at IS NULL", owner.id)!;
    await call(outsider, `/integrations/connections/${github.id}`, 404, 'DELETE');
    const result = await call(owner, `/integrations/connections/${github.id}`, 200, 'DELETE');
    assert.equal(result.revoked_at_provider, true);
    assert.equal(revokedWith, 'gho_secret_access_token');
    const row = one<{ access_token_sealed: string; revoked_at: string | null }>('SELECT * FROM integration_connections WHERE id=?', github.id)!;
    assert.equal(row.access_token_sealed, '');
    assert.ok(row.revoked_at);
    await call(owner, '/integrations/github/repos', 409);
    const figma = one<{ id: string }>("SELECT id FROM integration_connections WHERE user_id=? AND provider='figma' AND revoked_at IS NULL", owner.id)!;
    const figmaResult = await call(owner, `/integrations/connections/${figma.id}`, 200, 'DELETE');
    assert.equal(figmaResult.manual_revocation_required, true, 'Figma has no revocation API');
    assert.ok(githubState);
  });

  await t.test('personal data: export without tokens or secrets; erasure revokes and deletes', async () => {
    const handler = personalDataHandlers().find(([name]) => name === 'integrations')?.[1];
    assert.ok(handler);
    const exported = handler.export(owner.id) as { connections: unknown[]; webhook_endpoints: unknown[] };
    assert.ok(exported.connections.length >= 3);
    assert.equal(exported.webhook_endpoints.length, 1);
    assertNoLeak(exported);
    calls.length = 0;
    fake('POST', /^https:\/\/gitlab\.example\.com\/oauth\/revoke$/, ({ body }) => {
      assert.equal(new URLSearchParams(body).get('token'), 'glat-second');
      return json({});
    });
    transaction(() => handler.erase(owner.id));
    await settle();
    assert.equal(one<{ total: number }>('SELECT COUNT(*) AS total FROM integration_connections WHERE user_id=?', owner.id)!.total, 0);
    assert.equal(one<{ total: number }>('SELECT COUNT(*) AS total FROM integration_webhook_endpoints WHERE owner_id=?', owner.id)!.total, 0);
    assert.equal(one<{ total: number }>('SELECT COUNT(*) AS total FROM integration_project_sources WHERE created_by=?', owner.id)!.total, 0);
    assert.ok(calls.some((item) => item.url.pathname === '/oauth/revoke'), 'GitLab token revoked after commit');
  });

  await t.test('V3 routes keep working next to the V4 routers', async () => {
    const projects = await call(owner, '/integrations/projects');
    assert.ok(projects.projects.some((project: { id: string }) => project.id === projectId));
    const saved = await call(owner, '/integrations', 200, 'POST', { project_id: projectId, provider: 'linear', url: 'https://linear.app/acme' });
    assert.equal(saved.integration.provider, 'linear');
    await call(owner, `/integrations/${saved.integration.id}`, 200, 'DELETE');
    await call(null, '/integrations/providers', 401);
  });
});
