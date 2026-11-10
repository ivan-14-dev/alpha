import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

process.env.DATABASE_PATH = ':memory:';
const { app } = await import('../server/app.js');
const { all, db, one, run } = await import('../server/db.js');
const { safeUrl } = await import('../server/core.js');

interface Actor {
  id: string;
  name: string;
  email: string;
  password: string;
  cookie: string;
}
interface Resource { id: string }
interface User extends Resource { name: string; email: string; role: string }
interface Project extends Resource {
  title: string;
  visibility: string;
  can_manage: boolean;
}
interface Mission extends Resource {
  status: string;
  report: null | (Resource & { summary: string });
}
interface Balance {
  funded_cents: number;
  paid_cents: number;
  reserved_cents: number;
  available_cents: number;
}
interface Order extends Resource { status: string; price_cents: number; delivery_text: string; version: number; revision_requested: number }
interface Notification extends Resource { read_at: string | null; link: string }

function assertNoSecrets(value: unknown, forbidden: string[] = ['password_hash', 'token_hash', 'email']) {
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    assert.ok(!forbidden.includes(key), `Private field ${key} leaked into a response`);
    assertNoSecrets(nested, forbidden);
  }
}

test('Alpha HTTP integration: real sessions, private resources, and demo business flows', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    db.close();
  });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;

  async function request<T>(
    actor: Actor | null,
    path: string,
    expected = 200,
    method = 'GET',
    body?: unknown,
    extraHeaders: Record<string, string | null> = {},
  ) {
    const headers = new Headers({
      'X-Alpha-Client': 'web',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(actor?.cookie ? { Cookie: actor.cookie } : {}),
    });
    for (const [name, value] of Object.entries(extraHeaders)) {
      if (value === null) headers.delete(name);
      else headers.set(name, value);
    }
    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    assert.equal(response.status, expected, `${method} ${path}: ${text}`);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    const data = JSON.parse(text) as T;
    if (expected >= 400) {
      assert.equal(typeof (data as { error?: unknown }).error, 'string', 'Errors must be actionable JSON');
    }
    const cookie = response.headers.get('set-cookie');
    if (actor && cookie) actor.cookie = cookie.split(';', 1)[0];
    return { data, response };
  }

  async function api<T>(
    actor: Actor | null, path: string, expected = 200, method = 'GET', body?: unknown,
  ): Promise<T> {
    return (await request<T>(actor, path, expected, method, body)).data;
  }

  function actor(name: string): Actor {
    return { id: '', name, email: `${name.toLowerCase()}@example.test`, password: 'Alpha-test-password-2026!', cookie: '' };
  }
  const owner = actor('Owner');
  const tester = actor('Tester');
  const outsider = actor('Outsider');
  const administrator = actor('Moderator');
  const actors = [owner, tester, outsider, administrator];

  for (const account of actors) {
    const { data, response } = await request<{ user: User }>(account, '/auth/register', 201, 'POST', {
      name: account.name, email: account.email, password: account.password,
    });
    account.id = data.user.id;
    assert.equal(data.user.role, 'member');
    assert.match(response.headers.get('set-cookie')!, /HttpOnly/);
    assert.match(response.headers.get('set-cookie')!, /SameSite=Lax/);
    assert.match(account.cookie, /^alpha_session=[a-f0-9]{64}$/);
    assertNoSecrets(data, ['password_hash', 'token_hash']);
  }
  run("UPDATE users SET role='admin' WHERE id=?", administrator.id);

  let publicProject: Project;
  let privateProject: Project;
  let campaignId: string;
  let missionId: string;
  let orderId: string;
  const reward = 2500;
  const report = {
    summary: 'The onboarding flow is usable with one keyboard navigation issue.',
    steps: 'Open the dashboard, use Tab to reach the new project button, then press Enter.',
    expected: 'The project creation form receives keyboard focus.',
    observed: 'Focus remains on the dashboard instead of moving to the form.',
    evidence_url: 'https://example.test/evidence',
  };
  const campaignInput = (projectId: string) => ({
    project_id: projectId,
    title: 'Keyboard usability campaign',
    description: 'Validate the onboarding flow using keyboard navigation and a desktop browser.',
    reward_cents: reward,
    slots: 1,
    deadline: new Date(Date.now() + 7 * 86400000).toISOString(),
  });
  const motivation = { motivation: 'I can test the complete desktop flow and provide reproducible accessibility feedback.' };

  await t.test('sessions are authenticated, rotated, expired, and revoked; unsafe mutations are rejected', async () => {
    assert.deepEqual(await api(null, '/health'), { status: 'ok', version: '0.4.0', payment_mode: 'demo' });
    assert.deepEqual(await api(null, '/auth/me'), { user: null });
    assert.equal((await api<{ user: User }>(owner, '/auth/me')).user.id, owner.id);
    await api(null, '/payments/summary', 401);
    await api(null, '/projects', 401, 'POST', {});
    await api(null, '/auth/register', 400, 'POST', {
      name: 'Short password', email: 'short@example.test', password: 'short',
    });
    await api(null, '/auth/register', 409, 'POST', {
      name: 'Duplicate owner', email: owner.email.toUpperCase(), password: owner.password,
    });
    await api(null, '/auth/login', 401, 'POST', { email: owner.email, password: 'wrong-password-2026' });
    const blockedCredentials = {
      name: 'Blocked registration', email: 'blocked@example.test', password: owner.password,
    };
    const unsafeHeaders: Record<string, string | null>[] = [
      { 'X-Alpha-Client': null },
      { Origin: 'https://untrusted.example.test' },
    ];
    const sessionsBefore = one<{ count: number }>('SELECT COUNT(*) AS count FROM sessions')!.count;
    for (const [path, credentials] of [
      ['/auth/register', blockedCredentials],
      ['/auth/login', { email: owner.email, password: owner.password }],
      ['/auth/logout', {}],
    ] as const) {
      for (const headers of unsafeHeaders) {
        const blocked = await request(owner, path, 403, 'POST', credentials, headers);
        assert.equal(blocked.response.headers.get('set-cookie'), null);
      }
    }
    assert.equal(one('SELECT id FROM users WHERE email=?', blockedCredentials.email), undefined);
    assert.equal(one<{ count: number }>('SELECT COUNT(*) AS count FROM sessions')!.count, sessionsBefore);
    await request(owner, '/auth/logout', 403, 'POST', {}, { 'X-Alpha-Client': '' });
    assert.equal((await api<{ user: User }>(owner, '/auth/me')).user.id, owner.id);

    const roleClaimant = actor('RoleClaimant');
    const claimed = await api<{ user: User }>(roleClaimant, '/auth/register', 201, 'POST', {
      name: roleClaimant.name, email: roleClaimant.email, password: roleClaimant.password, role: 'admin',
    });
    roleClaimant.id = claimed.user.id;
    assert.equal(claimed.user.role, 'member');
    assert.equal(one<{ role: string }>('SELECT role FROM users WHERE id=?', roleClaimant.id)!.role, 'member');
    const claimedLogin = await api<{ user: User }>(roleClaimant, '/auth/login', 200, 'POST', {
      email: roleClaimant.email, password: roleClaimant.password, role: 'admin',
    });
    assert.equal(claimedLogin.user.role, 'member');
    assert.equal((await api<{ user: User }>(roleClaimant, '/auth/me')).user.role, 'member');
    await api(roleClaimant, '/trust/audit', 403);
    await api(roleClaimant, '/auth/logout', 200, 'POST', {});

    const previousCookie = owner.cookie;
    const passwordHash = one<{ password_hash: string }>('SELECT password_hash FROM users WHERE id=?', owner.id)!.password_hash;
    assert.notEqual(passwordHash, owner.password);
    assert.match(passwordHash, /^[a-f0-9]{32}:[a-f0-9]{128}$/);
    await api(owner, '/auth/login', 200, 'POST', { email: owner.email.toUpperCase(), password: owner.password });
    assert.notEqual(owner.cookie, previousCookie);
    assert.deepEqual(await api({ ...owner, cookie: previousCookie }, '/auth/me'), { user: null });
    const liveCookie = owner.cookie;
    const token = liveCookie.slice('alpha_session='.length);
    assert.ok(one('SELECT token_hash FROM sessions WHERE token_hash=?', createHash('sha256').update(token).digest('hex')));
    assert.equal(one('SELECT token_hash FROM sessions WHERE token_hash=?', token), undefined);
    await api(owner, '/auth/logout', 200, 'POST', {});
    assert.deepEqual(await api({ ...owner, cookie: liveCookie }, '/auth/me'), { user: null });
    assert.deepEqual(await api(owner, '/auth/me'), { user: null });
    await api(owner, '/auth/login', 200, 'POST', { email: owner.email, password: owner.password });

    const expiredToken = 'a'.repeat(64);
    run('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?,?,?)',
      createHash('sha256').update(expiredToken).digest('hex'), outsider.id, '2000-01-01T00:00:00.000Z');
    assert.deepEqual(await api({ ...outsider, cookie: `alpha_session=${expiredToken}` }, '/auth/me'), { user: null });
    assert.deepEqual(await api({ ...outsider, cookie: 'alpha_session=not-a-valid-token' }, '/auth/me'), { user: null });
    const malformed = await fetch(`${base}/auth/login`, {
      method: 'POST', headers: { 'X-Alpha-Client': 'web', 'Content-Type': 'application/json' }, body: '{',
    });
    assert.equal(malformed.status, 400);
    assert.equal(typeof (await malformed.json() as { error: string }).error, 'string');
    await api(null, '/does-not-exist', 404);
  });

  await t.test('shared URL validation returns validation failures rather than throwing for malformed URLs', () => {
    for (const value of ['not-a-url', 'https:', 'https://', 'https://[', 'javascript:alert(1)', 'data:text/plain,example']) {
      const result = safeUrl.safeParse(value);
      assert.equal(result.success, false, `Unsafe or malformed URL accepted: ${value}`);
    }
    for (const value of ['', 'https://example.test/evidence', 'http://example.test/prototype']) {
      assert.equal(safeUrl.safeParse(value).success, true);
    }
  });

  await t.test('public projects are discoverable; private projects and organization roles enforce access', async () => {
    publicProject = (await api<{ project: Project }>(owner, '/projects', 201, 'POST', {
      title: 'Public Alpha prototype', summary: 'A public project for integration testing.', category: 'developer-tools',
      visibility: 'public', tags: ['TypeScript', 'TypeScript'],
    })).project;
    privateProject = (await api<{ project: Project }>(owner, '/projects', 201, 'POST', {
      title: 'Confidential Alpha prototype', summary: 'A private prototype not visible to unrelated members.',
      category: 'ai', visibility: 'private',
    })).project;
    const publicView = await api<{ project: Project & { tags: string[] } }>(null, `/projects/${publicProject.id}`);
    assert.equal(publicView.project.can_manage, false);
    assert.deepEqual(publicView.project.tags, ['TypeScript']);
    assertNoSecrets(publicView);
    for (const visitor of [null, outsider]) {
      await api(visitor, `/projects/${privateProject.id}`, 404);
      const listing = await api<{ projects: Project[]; total: number }>(visitor, '/projects');
      assert.deepEqual(listing.projects.map((project) => project.id), [publicProject.id]);
      assert.equal(listing.total, 1);
      const search = await api<{ projects: Project[]; total: number }>(visitor, '/projects?q=Confidential');
      assert.equal(search.total, 0);
      assert.deepEqual(search.projects, []);
    }
    await api(outsider, `/projects/${publicProject.id}`, 403, 'PATCH', { title: 'Unauthorized replacement' });
    await api(outsider, `/projects/${privateProject.id}`, 404, 'PATCH', { title: 'Unauthorized replacement' });
    for (const repo_url of ['not-a-url', 'https:', 'https://', 'https://[', 'javascript:alert(1)']) {
      await api(owner, `/projects/${publicProject.id}`, 400, 'PATCH', { repo_url });
      assert.equal(one<{ repo_url: string }>('SELECT repo_url FROM projects WHERE id=?', publicProject.id)!.repo_url, '');
    }
    assert.equal((await api<{ project: Project }>(owner, `/projects/${privateProject.id}`)).project.can_manage, true);

    const organization = (await api<{ organization: Resource }>(owner, '/people/organizations', 201, 'POST', {
      name: 'Alpha collaborators', description: 'Organization for private project collaboration.',
    })).organization;
    await api(owner, `/projects/${privateProject.id}`, 200, 'PATCH', { organization_id: organization.id });
    await api(owner, `/people/organizations/${organization.id}/members`, 409, 'POST', { user_id: tester.id, role: 'member' });
    const invitation = (await api<{ invitation: Resource }>(owner, `/people/organizations/${organization.id}/invitations`, 201, 'POST', { user_id: tester.id, role: 'member' })).invitation;
    await api(tester, `/projects/${privateProject.id}`, 404);
    await api(tester, `/people/invitations/${invitation.id}/accept`, 200, 'POST', {});
    assert.equal((await api<{ project: Project }>(tester, `/projects/${privateProject.id}`)).project.can_manage, false);
    await api(tester, `/projects/${privateProject.id}`, 403, 'PATCH', { title: 'Member cannot edit' });
    await api(tester, `/people/organizations/${organization.id}/members`, 403, 'POST', { user_id: outsider.id, role: 'admin' });
    await api(outsider, `/people/organizations/${organization.id}/members`, 403);
    await api(owner, `/people/organizations/${organization.id}/members`, 200, 'POST', { user_id: tester.id, role: 'admin' });
    const edited = await api<{ project: Project }>(tester, `/projects/${privateProject.id}`, 200, 'PATCH', {
      title: 'Confidential Alpha prototype updated by organization admin',
    });
    assert.equal(edited.project.can_manage, true);
    await api(tester, `/projects/${privateProject.id}`, 403, 'PATCH', { organization_id: null });
    await api(owner, `/people/organizations/${organization.id}/members/${owner.id}`, 409, 'DELETE');
    await api(owner, `/people/organizations/${organization.id}/members/${tester.id}`, 200, 'DELETE');
    await api(tester, `/projects/${privateProject.id}`, 404);

    const profile = await api<{ person: { projects: Resource[] } }>(null, `/people/${owner.id}`);
    assert.deepEqual(profile.person.projects.map((project) => project.id), [publicProject.id]);
    assertNoSecrets(profile);
    assertNoSecrets(await api(null, '/people'));
    await api(outsider, '/people/me', 400, 'PATCH', { role: 'admin' });
    assert.equal((await api<{ user: User }>(outsider, '/auth/me')).user.role, 'member');
  });

  await t.test('campaign selection requires funding, prevents oversubscription, and isolates applications', async () => {
    await api(outsider, '/testing/campaigns', 403, 'POST', campaignInput(publicProject.id));
    const created = await api<{ campaign: Resource; balance: Balance }>(owner, '/testing/campaigns', 201, 'POST', campaignInput(publicProject.id));
    campaignId = created.campaign.id;
    assert.deepEqual(created.balance, { funded_cents: 0, paid_cents: 0, reserved_cents: 0, available_cents: 0 });
    await api(owner, `/testing/campaigns/${campaignId}/applications`, 403, 'POST', motivation);
    const application = (await api<{ application: Resource }>(tester, `/testing/campaigns/${campaignId}/applications`, 201, 'POST', motivation)).application;
    const competingApplication = (await api<{ application: Resource }>(outsider, `/testing/campaigns/${campaignId}/applications`, 201, 'POST', motivation)).application;
    await api(tester, `/testing/campaigns/${campaignId}/applications`, 409, 'POST', motivation);
    await api(outsider, `/testing/applications/${application.id}/accept`, 403, 'POST', {});
    await api(owner, `/testing/applications/${application.id}/accept`, 409, 'POST', {});
    assert.equal(one<{ status: string }>('SELECT status FROM applications WHERE id=?', application.id)!.status, 'pending');
    assert.equal(one<{ count: number }>('SELECT COUNT(*) AS count FROM missions WHERE campaign_id=?', campaignId)!.count, 0);
    await api(outsider, `/payments/campaigns/${campaignId}/fund`, 403, 'POST', { amount_cents: reward });
    await api(owner, `/payments/campaigns/${campaignId}/fund`, 400, 'POST', { amount_cents: 0 });
    await api(owner, `/payments/campaigns/${campaignId}/fund`, 400, 'POST', { amount_cents: 1.5 });
    await api(owner, `/payments/campaigns/${campaignId}/fund`, 400, 'POST', { amount_cents: reward + 1 });
    const funded = await api<{ balance: Balance; mode: string }>(owner, `/payments/campaigns/${campaignId}/fund`, 200, 'POST', { amount_cents: reward });
    assert.equal(funded.mode, 'demo');
    assert.equal(funded.balance.available_cents, reward);
    await api(owner, `/payments/campaigns/${campaignId}/fund`, 400, 'POST', { amount_cents: 1 });
    const selection = await api<{ mission: Mission; balance: Balance }>(owner, `/testing/applications/${application.id}/accept`, 201, 'POST', {});
    missionId = selection.mission.id;
    assert.equal(selection.mission.status, 'assigned');
    assert.equal(selection.balance.reserved_cents, reward);
    assert.equal(selection.balance.available_cents, 0);
    await api(owner, `/testing/applications/${application.id}/accept`, 409, 'POST', {});
    await api(owner, `/testing/applications/${competingApplication.id}/accept`, 409, 'POST', {});
    assert.equal(one<{ status: string }>('SELECT status FROM applications WHERE id=?', competingApplication.id)!.status, 'pending');
    assert.equal(one<{ count: number }>('SELECT COUNT(*) AS count FROM missions WHERE campaign_id=?', campaignId)!.count, 1);

    const ownerView = await api<{ applications: Resource[]; missions: Mission[] }>(owner, `/testing/campaigns/${campaignId}`);
    assert.equal(ownerView.applications.length, 2);
    assertNoSecrets(ownerView);
    const outsiderView = await api<{ application: Resource; missions: Mission[]; applications?: unknown; balance?: unknown }>(outsider, `/testing/campaigns/${campaignId}`);
    assert.equal(outsiderView.application.id, competingApplication.id);
    assert.deepEqual(outsiderView.missions, []);
    assert.equal(outsiderView.applications, undefined);
    assert.equal(outsiderView.balance, undefined);
    assert.deepEqual((await api<{ missions: Mission[] }>(outsider, '/testing/missions')).missions, []);
    const privateCampaign = (await api<{ campaign: Resource }>(owner, '/testing/campaigns', 201, 'POST', campaignInput(privateProject.id))).campaign;
    await api(outsider, `/testing/campaigns/${privateCampaign.id}`, 404);
    await api(outsider, `/testing/campaigns/${privateCampaign.id}/applications`, 404, 'POST', motivation);
    const publicCampaigns = await api<{ campaigns: Resource[] }>(null, '/testing/campaigns');
    assert.ok(!publicCampaigns.campaigns.some((campaign) => campaign.id === privateCampaign.id));
  });

  await t.test('reports follow the work state machine; payout and reputation require accepted paid work', async () => {
    const reviewInput = { mission_id: missionId, rating: 5, body: 'Detailed reproducible feedback and excellent collaboration.' };
    await api(owner, '/reputation/reviews', 409, 'POST', reviewInput);
    await api(owner, `/payments/missions/${missionId}/pay`, 409, 'POST', {});
    await api(owner, `/testing/missions/${missionId}/start`, 403, 'POST', {});
    await api(outsider, `/testing/missions/${missionId}/report`, 403, 'POST', report);
    const started = await api<{ mission: Mission }>(tester, `/testing/missions/${missionId}/start`, 200, 'POST', {});
    assert.equal(started.mission.status, 'in_progress');
    await api(tester, `/testing/missions/${missionId}/start`, 409, 'POST', {});
    await api(tester, `/testing/missions/${missionId}/report`, 400, 'POST', { ...report, evidence_url: 'javascript:alert(1)' });
    const submitted = await api<{ mission: Mission }>(tester, `/testing/missions/${missionId}/report`, 200, 'POST', report);
    assert.equal(submitted.mission.status, 'submitted');
    assert.equal(submitted.mission.report?.summary, report.summary);
    await api(tester, `/testing/missions/${missionId}/report`, 409, 'POST', report);
    await api(tester, `/testing/missions/${missionId}/accept`, 403, 'POST', {});
    const correction = await api<{ mission: Mission }>(owner, `/testing/missions/${missionId}/changes`, 200, 'POST', {
      reason: 'Please include the tested browser version in your report.',
    });
    assert.equal(correction.mission.status, 'changes_requested');
    await api(owner, `/payments/missions/${missionId}/pay`, 409, 'POST', {});
    await api(tester, `/testing/missions/${missionId}/report`, 409, 'POST', report);
    const revised = await api<{ mission: Mission }>(tester, `/testing/missions/${missionId}/report`, 200, 'POST', {
      ...report, observed: `${report.observed} Reproduced in Firefox 132.`,
    });
    assert.equal(revised.mission.report?.id, submitted.mission.report?.id);
    const accepted = await api<{ mission: Mission }>(owner, `/testing/missions/${missionId}/accept`, 200, 'POST', {});
    assert.equal(accepted.mission.status, 'accepted');
    await api(owner, '/reputation/reviews', 409, 'POST', reviewInput);
    await api(tester, `/payments/missions/${missionId}/pay`, 403, 'POST', {});
    await api(outsider, `/payments/missions/${missionId}/pay`, 403, 'POST', {});
    const payment = await api<{ status: string; mode: string }>(owner, `/payments/missions/${missionId}/pay`, 200, 'POST', {});
    assert.equal(payment.status, 'paid');
    assert.equal(payment.mode, 'demo');
    const repeatedPayment = await api<{ status: string; mode: string }>(owner, `/payments/missions/${missionId}/pay`, 200, 'POST', {});
    assert.equal(repeatedPayment.status, 'paid');
    const payouts = all<{ user_id: string; amount_cents: number; mode: string }>("SELECT user_id,amount_cents,mode FROM transactions WHERE mission_id=? AND kind='payout'", missionId);
    assert.equal(payouts.length, 1);
    assert.equal(payouts[0].user_id, tester.id);
    assert.equal(payouts[0].amount_cents, reward);
    assert.equal(payouts[0].mode, 'demo');
    const balance = (await api<{ balance: Balance }>(owner, `/testing/campaigns/${campaignId}`)).balance;
    assert.deepEqual(balance, { funded_cents: reward, paid_cents: reward, reserved_cents: 0, available_cents: 0 });
    const earnings = await api<{ summary: { earned_cents: number; mode: string } }>(tester, '/payments/summary');
    assert.equal(earnings.summary.earned_cents, reward);
    assert.equal(earnings.summary.mode, 'demo');
    assert.deepEqual((await api<{ transactions: unknown[] }>(outsider, '/payments/transactions')).transactions, []);

    await api(outsider, '/reputation/reviews', 403, 'POST', reviewInput);
    const eligible = await api<{ missions: Resource[] }>(owner, '/reputation/eligible');
    assert.ok(eligible.missions.some((mission) => mission.id === missionId));
    const review = await api<{ review: Resource & { subject_id: string; verified: boolean } }>(owner, '/reputation/reviews', 201, 'POST', reviewInput);
    assert.equal(review.review.subject_id, tester.id);
    assert.equal(review.review.verified, true);
    await api(owner, '/reputation/reviews', 409, 'POST', reviewInput);
    await api(tester, '/reputation/reviews', 201, 'POST', { ...reviewInput, rating: 4 });
    assert.ok(!(await api<{ missions: Resource[] }>(owner, '/reputation/eligible')).missions.some((mission) => mission.id === missionId));
    const reviews = await api<{ reviews: Resource[] }>(null, `/reputation/reviews?user=${tester.id}`);
    assert.equal(reviews.reviews.length, 1);
    assertNoSecrets(reviews, ['password_hash', 'token_hash', 'email', 'mission_id', 'campaign_id', 'project_id']);
    const reputation = await api<{ summary: { average: number; count: number } }>(null, `/reputation/summary?user=${tester.id}`);
    assert.equal(reputation.summary.average, 5);
    assert.equal(reputation.summary.count, 1);
  });

  await t.test('marketplace orders stay private, lock terms, and settle exactly once after delivery', async () => {
    const listingInput = {
      title: 'Accessible navigation component',
      description: 'A reusable navigation component with accessible keyboard interactions.',
      kind: 'component', price_cents: 4900,
      license: 'Non-exclusive license for one commercial project.',
      deliverables: 'Source code archive and complete installation documentation.',
      project_id: publicProject.id,
    };
    await api(owner, '/marketplace/listings', 403, 'POST', { ...listingInput, project_id: privateProject.id });
    const listing = (await api<{ listing: Resource }>(owner, '/marketplace/listings', 201, 'POST', listingInput)).listing;
    await api(owner, `/marketplace/listings/${listing.id}/buy`, 403, 'POST', {});
    await api(outsider, `/marketplace/listings/${listing.id}`, 403, 'PATCH', { price_cents: 1 });
    const purchase = await api<{ order: Order; mode: string }>(tester, `/marketplace/listings/${listing.id}/buy`, 201, 'POST', {});
    orderId = purchase.order.id;
    assert.equal(purchase.mode, 'demo');
    assert.equal(purchase.order.status, 'paid');
    assert.equal(purchase.order.price_cents, listingInput.price_cents);
    assert.equal(purchase.order.delivery_text, '');
    await api(tester, `/marketplace/listings/${listing.id}/buy`, 409, 'POST', {});
    await api(owner, `/marketplace/listings/${listing.id}`, 409, 'PATCH', { price_cents: 1 });
    await api(outsider, `/marketplace/orders/${orderId}`, 404);
    await api(null, `/marketplace/orders/${orderId}`, 401);
    assert.deepEqual((await api<{ orders: Order[] }>(outsider, '/marketplace/orders')).orders, []);
    assert.equal(purchase.order.version, 1);
    assert.equal(purchase.order.revision_requested, 0);
    await api(tester, `/marketplace/orders/${orderId}/complete`, 409, 'POST', { version: purchase.order.version });
    const delivery = { version: purchase.order.version, delivery_text: 'Private delivery: archive reference alpha-component-v1, installation instructions included.' };
    await api(tester, `/marketplace/orders/${orderId}/deliver`, 403, 'POST', delivery);
    await api(outsider, `/marketplace/orders/${orderId}/deliver`, 404, 'POST', delivery);
    const delivered = await api<{ order: Order }>(owner, `/marketplace/orders/${orderId}/deliver`, 200, 'POST', delivery);
    assert.equal(delivered.order.status, 'delivered');
    assert.equal(delivered.order.delivery_text, delivery.delivery_text);
    const buyerView = await api<{ order: Order }>(tester, `/marketplace/orders/${orderId}`);
    assert.equal(buyerView.order.delivery_text, delivery.delivery_text);
    assertNoSecrets(buyerView);
    const publicListing = await api(null, `/marketplace/listings/${listing.id}`);
    assert.ok(!JSON.stringify(publicListing).includes(delivery.delivery_text));
    await api(owner, `/marketplace/orders/${orderId}/complete`, 403, 'POST', { version: delivered.order.version });
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.equal((await api<{ order: Order }>(tester, `/marketplace/orders/${orderId}/complete`, 200, 'POST', { version: delivered.order.version })).order.status, 'completed');
    }
    const ledger = all<{ kind: string; amount_cents: number; user_id: string; mode: string }>(
      'SELECT kind,amount_cents,user_id,mode FROM transactions WHERE order_id=? ORDER BY kind', orderId,
    );
    assert.equal(ledger.length, 2);
    assert.deepEqual(ledger.map((entry) => entry.kind), ['purchase', 'sale']);
    assert.equal(ledger[0].user_id, tester.id);
    assert.equal(ledger[1].user_id, owner.id);
    assert.ok(ledger.every((entry) => entry.amount_cents === listingInput.price_cents && entry.mode === 'demo'));
    await api(owner, `/marketplace/orders/${orderId}/deliver`, 409, 'POST', delivery);
    await api(owner, `/marketplace/listings/${listing.id}/archive`, 200, 'POST', {});
    await api(outsider, `/marketplace/listings/${listing.id}`, 404);
    await api(tester, `/marketplace/listings/${listing.id}`);
    await api(outsider, `/marketplace/listings/${listing.id}/buy`, 409, 'POST', {});
  });

  await t.test('community membership, like toggling, and content ownership persist correctly', async () => {
    const group = (await api<{ group: Resource & { member_count: number; is_member: boolean } }>(owner, '/community/groups', 201, 'POST', {
      name: 'Alpha accessibility', description: 'Share practical accessibility testing feedback.', category: 'Design',
    })).group;
    assert.equal(group.member_count, 1);
    assert.equal(group.is_member, true);
    const postInput = { group_id: group.id, body: 'How do you validate keyboard focus in your prototypes?' };
    await api(tester, '/community/posts', 403, 'POST', postInput);
    await api(owner, `/community/groups/${group.id}/leave`, 409, 'POST', {});
    for (let attempt = 0; attempt < 2; attempt++) {
      const joined = await api<{ group: { member_count: number; is_member: boolean } }>(tester, `/community/groups/${group.id}/join`, 200, 'POST', {});
      assert.equal(joined.group.member_count, 2);
      assert.equal(joined.group.is_member, true);
    }
    const post = (await api<{ post: Resource }>(tester, '/community/posts', 201, 'POST', postInput)).post;
    await api(null, `/community/posts/${post.id}/like`, 401, 'POST', {});
    assert.deepEqual(await api(owner, `/community/posts/${post.id}/like`, 200, 'POST', {}), { liked: true, like_count: 1 });
    assert.deepEqual(await api(owner, `/community/posts/${post.id}/like`, 200, 'POST', {}), { liked: false, like_count: 0 });
    const comment = (await api<{ comment: Resource; comment_count: number }>(owner, `/community/posts/${post.id}/comments`, 201, 'POST', {
      body: 'Test with Tab and Shift+Tab before enabling the mouse.',
    })).comment;
    const comments = await api<{ comments: Resource[]; total: number }>(null, `/community/posts/${post.id}/comments`);
    assert.equal(comments.total, 1);
    assert.equal(comments.comments[0].id, comment.id);
    assertNoSecrets(comments);
    await api(tester, `/community/comments/${comment.id}`, 403, 'DELETE');
    await api(owner, `/community/posts/${post.id}`, 403, 'DELETE');
    await api(owner, `/community/comments/${comment.id}`, 200, 'DELETE');
    assert.equal((await api<{ total: number }>(null, `/community/posts/${post.id}/comments`)).total, 0);
    await api(owner, `/community/posts/${post.id}/like`, 200, 'POST', {});
    await api(tester, `/community/posts/${post.id}`, 200, 'DELETE');
    assert.equal(one('SELECT post_id FROM post_likes WHERE post_id=?', post.id), undefined);
    await api(owner, `/community/posts/${post.id}/comments`, 404);
    const left = await api<{ group: { member_count: number; is_member: boolean } }>(tester, `/community/groups/${group.id}/leave`, 200, 'POST', {});
    assert.equal(left.group.member_count, 1);
    assert.equal(left.group.is_member, false);
    await api(tester, '/community/posts', 403, 'POST', postInput);
  });

  await t.test('private conversations isolate messages and notifications, including read operations', async () => {
    await api(null, '/communication/conversations', 401);
    await api(owner, '/communication/conversations', 400, 'POST', {
      recipient_id: owner.id, subject: 'Self conversation', body: 'Not a valid recipient.',
    });
    const created = await api<{ conversation: Resource; messages: Resource[] }>(owner, '/communication/conversations', 201, 'POST', {
      recipient_id: tester.id, subject: 'Confidential delivery discussion', body: 'Private initial message for the tester only.',
    });
    const conversationId = created.conversation.id;
    assert.equal(created.messages.length, 1);
    assertNoSecrets(created);
    await api(outsider, `/communication/conversations/${conversationId}`, 404);
    await api(outsider, `/communication/conversations/${conversationId}/messages`, 404, 'POST', { body: 'Unauthorized message.' });
    assert.deepEqual((await api<{ conversations: Resource[] }>(outsider, '/communication/conversations')).conversations, []);
    await api(tester, `/communication/conversations/${conversationId}/messages`, 201, 'POST', { body: 'Private reply confirming receipt.' });
    const conversation = await api<{ messages: (Resource & { body: string })[] }>(owner, `/communication/conversations/${conversationId}`);
    assert.deepEqual(conversation.messages.map((message) => message.body), [
      'Private initial message for the tester only.', 'Private reply confirming receipt.',
    ]);
    assertNoSecrets(conversation);
    const lastPage = await api<{ messages: Resource[]; has_more: boolean; next_before: string }>(tester, `/communication/conversations/${conversationId}?limit=1`);
    assert.equal(lastPage.has_more, true);
    assert.equal(lastPage.messages[0].id, conversation.messages[1].id);
    const firstPage = await api<{ messages: Resource[]; has_more: boolean }>(tester, `/communication/conversations/${conversationId}?limit=1&before=${lastPage.next_before}`);
    assert.equal(firstPage.messages[0].id, conversation.messages[0].id);
    assert.equal(firstPage.has_more, false);

    const inbox = await api<{ notifications: Notification[]; unread_count: number }>(tester, '/communication/notifications?limit=100');
    const messageNotice = inbox.notifications.find((notification) => notification.link === `/messages?conversation=${conversationId}`);
    assert.ok(messageNotice);
    assert.equal(messageNotice.read_at, null);
    await api(outsider, `/communication/notifications/${messageNotice.id}/read`, 404, 'POST', {});
    assert.equal(one<{ read_at: string | null }>('SELECT read_at FROM notifications WHERE id=?', messageNotice.id)!.read_at, null);
    const marked = await api<{ notification: Notification }>(tester, `/communication/notifications/${messageNotice.id}/read`, 200, 'POST', {});
    assert.equal(typeof marked.notification.read_at, 'string');
    const markedAgain = await api<{ notification: Notification }>(tester, `/communication/notifications/${messageNotice.id}/read`, 200, 'POST', {});
    assert.equal(markedAgain.notification.read_at, marked.notification.read_at);
    const remaining = await api<{ unread_count: number }>(tester, '/communication/notifications');
    assert.equal(remaining.unread_count, inbox.unread_count - 1);
    const ownerUnread = (await api<{ unread_count: number }>(owner, '/communication/notifications')).unread_count;
    await api(tester, '/communication/notifications/read-all', 200, 'POST', {});
    assert.equal((await api<{ unread_count: number }>(tester, '/communication/notifications')).unread_count, 0);
    assert.equal((await api<{ unread_count: number }>(owner, '/communication/notifications')).unread_count, ownerUnread);
    const otherInbox = await api<{ notifications: Notification[] }>(outsider, '/communication/notifications?limit=100');
    assert.ok(!otherInbox.notifications.some((notification) => notification.id === messageNotice.id));
    assertNoSecrets(await api(owner, '/communication/people'));
  });

  await t.test('moderation reports are private and only administrators can resolve or audit them', async () => {
    await api(outsider, '/trust/reports', 404, 'POST', {
      target_type: 'project', target_id: privateProject.id, reason: 'An unrelated member must not report a hidden resource.',
    });
    const input = {
      target_type: 'project', target_id: publicProject.id, reason: 'Please review whether this project follows the community guidelines.',
    };
    const report = (await api<{ report: Resource & { status: string } }>(tester, '/trust/reports', 201, 'POST', input)).report;
    assert.equal(report.status, 'open');
    await api(tester, '/trust/reports', 409, 'POST', input);
    assert.deepEqual((await api<{ reports: Resource[] }>(outsider, '/trust/reports')).reports, []);
    assert.deepEqual((await api<{ reports: Resource[] }>(owner, '/trust/reports')).reports, []);
    await api(null, '/trust/audit', 401);
    await api(tester, '/trust/audit', 403);
    const decision = { status: 'resolved', decision: 'Reviewed the public project and confirmed compliance with the guidelines.' };
    await api(tester, `/trust/reports/${report.id}/resolve`, 403, 'POST', decision);
    assert.equal(one<{ status: string }>('SELECT status FROM moderation_reports WHERE id=?', report.id)!.status, 'open');
    const queue = await api<{ reports: (Resource & { context: unknown })[] }>(administrator, '/trust/reports');
    assert.ok(queue.reports.some((entry) => entry.id === report.id && entry.context));
    const resolved = await api<{ report: { status: string; decision: string } }>(administrator, `/trust/reports/${report.id}/resolve`, 200, 'POST', decision);
    assert.equal(resolved.report.status, 'resolved');
    assert.equal(resolved.report.decision, decision.decision);
    await api(administrator, `/trust/reports/${report.id}/resolve`, 409, 'POST', decision);
    const audit = await api<{ events: { actor_id: string; target_id: string; action: string }[] }>(administrator, '/trust/audit');
    assert.ok(audit.events.some((event) => event.actor_id === administrator.id && event.target_id === report.id && event.action === 'moderation.report.resolved'));
    assertNoSecrets(audit);
  });

  await t.test('integrations validate provider URLs and only project managers can export work reports', async () => {
    const input = { project_id: publicProject.id, provider: 'github', url: 'https://github.com/example/alpha' };
    await api(null, `/integrations?project_id=${publicProject.id}`, 401);
    await api(outsider, '/integrations', 403, 'POST', input);
    await api(owner, '/integrations', 400, 'POST', { ...input, url: 'https://github.com.evil.example/repository' });
    await api(owner, '/integrations', 400, 'POST', { ...input, url: 'http://github.com/example/alpha' });
    await api(owner, '/integrations', 400, 'POST', { ...input, url: 'https://user:password@github.com/example/alpha' });
    const integration = (await api<{ integration: Resource }>(owner, '/integrations', 200, 'POST', input)).integration;
    const updated = await api<{ integration: Resource & { url: string } }>(owner, '/integrations', 200, 'POST', {
      ...input, url: 'https://github.com/example/alpha-updated',
    });
    assert.equal(updated.integration.id, integration.id);
    assert.equal(updated.integration.url, 'https://github.com/example/alpha-updated');
    const links = await api<{ integrations: Resource[] }>(owner, `/integrations?project_id=${publicProject.id}`);
    assert.equal(links.integrations.length, 1);
    await api(tester, `/integrations/export?project_id=${publicProject.id}`, 403);
    await api(outsider, `/integrations/export?project_id=${privateProject.id}`, 403);
    await api(null, `/integrations/export?project_id=${publicProject.id}`, 401);
    const exported = await request<{
      version: number; financial_mode: string; project: Resource;
      campaigns: Resource[]; missions: Resource[]; reports: (Resource & { mission_id: string })[];
    }>(owner, `/integrations/export?project_id=${publicProject.id}`);
    assert.match(exported.response.headers.get('content-disposition')!, /^attachment; filename="alpha-export-/);
    assert.equal(exported.data.version, 1);
    assert.equal(exported.data.financial_mode, 'demo');
    assert.equal(exported.data.project.id, publicProject.id);
    assert.deepEqual(exported.data.campaigns.map((campaign) => campaign.id), [campaignId]);
    assert.deepEqual(exported.data.missions.map((mission) => mission.id), [missionId]);
    assert.equal(exported.data.reports.length, 1);
    assert.equal(exported.data.reports[0].mission_id, missionId);
    assertNoSecrets(exported.data, ['password_hash', 'token_hash', 'email', 'tester_id', 'motivation']);
    await api(outsider, `/integrations/${integration.id}`, 403, 'DELETE');
    await api(owner, `/integrations/${integration.id}`, 200, 'DELETE');
    assert.deepEqual((await api<{ integrations: Resource[] }>(owner, `/integrations?project_id=${publicProject.id}`)).integrations, []);
    await api(owner, `/integrations/${integration.id}`, 404, 'DELETE');
    await api(owner, `/integrations/export?project_id=${randomUUID()}`, 404);
  });
});
