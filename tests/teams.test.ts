import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';

process.env.DATABASE_PATH = ':memory:';
const { all, db, one, run } = await import('../server/db.js');
const { attachUser } = await import('../server/auth.js');
const { canCollaborateProject, canManageProject, canReadProject, errorHandler } = await import('../server/core.js');
const { default: people } = await import('../server/modules/people.js');
const { default: projects } = await import('../server/modules/projects.js');
const { default: workspace } = await import('../server/modules/workspace.js');

interface Actor { id: string; name: string; cookie: string }
interface Member { id: string; role: string }
interface Invitation {
  id: string;
  organization_id: string;
  invitee_id: string;
  inviter_id: string;
  role: 'member' | 'admin';
  status: string;
  created_at: string;
  expires_at: string;
  responded_at: string | null;
  organization: { id: string; name: string; description: string };
  inviter: { id: string; name: string };
}
interface Invitations { invitations: Invitation[]; total: number; limit: number; offset: number }

function assertPublic(value: unknown) {
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    assert.ok(!['email', 'password_hash', 'token_hash', 'members', 'member_count'].includes(key), `Private field leaked: ${key}`);
    assertPublic(nested);
  }
}

test('Teams: explicit consent, invitation lifecycle, roles and immediate access withdrawal', async (t) => {
  const app = express();
  app.use(express.json(), attachUser);
  app.use('/api/people', people);
  app.use('/api/projects', projects);
  app.use('/api/workspace', workspace);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    db.close();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  async function request<T>(actor: Actor | null, path: string, expected: number | number[] = 200, method = 'GET', body?: unknown) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        'X-Alpha-Client': 'web',
        ...(actor ? { Cookie: actor.cookie } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    assert.ok((Array.isArray(expected) ? expected : [expected]).includes(response.status), `${method} ${path}: ${response.status} ${text}`);
    const data = JSON.parse(text) as T;
    if (response.status >= 400) assert.equal(typeof (data as { error?: unknown }).error, 'string');
    return { data, status: response.status };
  }
  async function api<T>(actor: Actor | null, path: string, expected = 200, method = 'GET', body?: unknown): Promise<T> {
    return (await request<T>(actor, path, expected, method, body)).data;
  }
  function actor(name: string, role = 'member'): Actor {
    const id = randomUUID();
    const token = randomBytes(32).toString('hex');
    run('INSERT INTO users (id,name,email,password_hash,role) VALUES (?,?,?,?,?)', id, name, `${id}@example.test`, 'not-used-for-session-tests', role);
    run('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)',
      createHash('sha256').update(token).digest('hex'), id, new Date(Date.now() + 86400000).toISOString());
    return { id, name, cookie: `alpha_session=${token}` };
  }
  const owner = actor('Owner');
  const recipient = actor('Recipient');
  const outsider = actor('Outsider');
  const moderator = actor('Platform administrator', 'admin');
  async function team() {
    const { organization } = await api<{ organization: { id: string } }>(owner, '/people/organizations', 201, 'POST', {
      name: 'Consent team', description: 'Private team work requires agreement.',
    });
    const { project } = await api<{ project: { id: string } }>(owner, '/projects', 201, 'POST', {
      organization_id: organization.id, title: 'Private team project', summary: 'Only accepted team members can collaborate.',
      category: 'saas', visibility: 'private',
    });
    return { organizationId: organization.id, projectId: project.id };
  }
  async function invite(organizationId: string, invitee = recipient, role: 'member' | 'admin' = 'member') {
    return (await api<{ invitation: Invitation }>(owner, `/people/organizations/${organizationId}/invitations`, 201, 'POST', { user_id: invitee.id, role })).invitation;
  }
  function membership(organizationId: string, userId: string) {
    return one<{ role: string }>('SELECT role FROM organization_members WHERE organization_id=? AND user_id=?', organizationId, userId);
  }
  function storedInvitation(invitationId: string) {
    return one<Invitation>('SELECT * FROM organization_invitations WHERE id=?', invitationId)!;
  }

  await t.test('authentication is required for every team and invitation operation', async () => {
    const { organizationId } = await team();
    const invitation = await invite(organizationId);
    for (const [path, method, body] of [
      ['/people/invitations', 'GET'],
      [`/people/organizations/${organizationId}/invitations`, 'GET'],
      [`/people/organizations/${organizationId}/invitations`, 'POST', { user_id: outsider.id, role: 'member' }],
      [`/people/invitations/${invitation.id}/accept`, 'POST'],
      [`/people/invitations/${invitation.id}/decline`, 'POST'],
      [`/people/invitations/${invitation.id}/revoke`, 'POST'],
      [`/people/organizations/${organizationId}/leave`, 'POST'],
      [`/people/organizations/${organizationId}/members/${recipient.id}`, 'PATCH', { role: 'admin' }],
      [`/people/organizations/${organizationId}/members/${recipient.id}`, 'DELETE'],
    ] as const) await api(null, path, 401, method, body);
    assert.equal(membership(organizationId, recipient.id), undefined);
  });

  await t.test('pending invitations disclose only the recipient’s own invitations and grant no access', async () => {
    const { organizationId, projectId } = await team();
    const invitation = await invite(organizationId);
    const otherInvitation = await invite(organizationId, outsider);
    assert.equal(invitation.status, 'pending');
    assert.equal(invitation.responded_at, null);
    assert.equal(Date.parse(invitation.expires_at) - Date.parse(invitation.created_at), 7 * 86400000);
    assert.equal(invitation.inviter.id, owner.id);
    assert.equal(invitation.organization.id, organizationId);
    assertPublic(invitation);
    const received = await api<Invitations>(recipient, `/people/invitations?invitee_id=${outsider.id}`);
    assert.ok(received.invitations.some((item) => item.id === invitation.id));
    assert.ok(received.invitations.every((item) => item.invitee_id === recipient.id));
    assert.ok(!JSON.stringify(received).includes(otherInvitation.id));
    assert.ok(!JSON.stringify(received).includes(outsider.id));
    assertPublic(received);
    const sent = await api<Invitations>(owner, `/people/organizations/${organizationId}/invitations?limit=1`);
    assert.equal(sent.total, 2);
    assert.equal(sent.invitations.length, 1);
    assertPublic(sent);
    const page = await api<Invitations>(owner, `/people/organizations/${organizationId}/invitations?limit=1&offset=1`);
    assert.notEqual(page.invitations[0].id, sent.invitations[0].id);
    for (const account of [recipient, outsider, moderator]) {
      await api(account, `/people/organizations/${organizationId}/invitations`, 403);
      await api(account, `/people/organizations/${organizationId}/members`, 403);
      await api(account, `/people/organizations/${organizationId}/invitations`, 403, 'POST', { user_id: owner.id, role: 'admin' });
      await api(account, `/projects/${projectId}`, 404);
      await api(account, `/workspace/projects/${projectId}`, 404);
      assert.equal(canReadProject(account.id, projectId), false);
      assert.equal(canManageProject(account.id, projectId), false);
      assert.equal(canCollaborateProject(account.id, projectId), false);
    }
    const mine = await api<{ organizations: { id: string }[] }>(recipient, '/people/organizations');
    assert.ok(!mine.organizations.some((organization) => organization.id === organizationId));
    const blocked = await api<{ error: string }>(owner, `/people/organizations/${organizationId}/members`, 409, 'POST', { user_id: recipient.id, role: 'admin' });
    assert.match(blocked.error, /invitation/i);
    await api(owner, `/people/organizations/${organizationId}/members/${recipient.id}`, 404, 'PATCH', { role: 'admin' });
    assert.equal(membership(organizationId, recipient.id), undefined);
    await api(recipient, '/people/invitations?limit=101', 400);
    await api(owner, `/people/organizations/${organizationId}/invitations?offset=-1`, 400);
  });

  await t.test('only recipients accept; concurrent retries are idempotent and preserve the current role', async () => {
    const { organizationId, projectId } = await team();
    const invitation = await invite(organizationId);
    for (const account of [owner, outsider, moderator]) {
      await api(account, `/people/invitations/${invitation.id}/accept`, 403, 'POST');
      await api(account, `/people/invitations/${invitation.id}/decline`, 403, 'POST');
    }
    await api(recipient, `/people/invitations/${invitation.id}/accept`, 400, 'POST', { role: 'owner' });
    assert.equal(membership(organizationId, recipient.id), undefined);
    const accepted = await Promise.all(Array.from({ length: 4 }, () =>
      api<{ invitation: Invitation; member: Member }>(recipient, `/people/invitations/${invitation.id}/accept`, 200, 'POST')));
    assert.ok(accepted.every((result) => result.invitation.status === 'accepted' && result.member.role === 'member'));
    assert.equal(all('SELECT user_id FROM organization_members WHERE organization_id=? AND user_id=?', organizationId, recipient.id).length, 1);
    assert.equal(all("SELECT id FROM audit_events WHERE action='organization.invitation.accepted' AND target_id=?", invitation.id).length, 1);
    assert.ok(storedInvitation(invitation.id).responded_at);
    await api(recipient, `/projects/${projectId}`);
    await api(recipient, `/workspace/projects/${projectId}`);
    assert.equal(canCollaborateProject(recipient.id, projectId), true);
    assert.equal(canManageProject(recipient.id, projectId), false);
    await api(owner, `/people/organizations/${organizationId}/members/${recipient.id}`, 200, 'PATCH', { role: 'admin' });
    run('UPDATE organization_invitations SET expires_at=? WHERE id=?', '2000-01-01T00:00:00.000Z', invitation.id);
    const retry = await api<{ member: Member }>(recipient, `/people/invitations/${invitation.id}/accept`, 200, 'POST');
    assert.equal(retry.member.role, 'admin');
    await api(owner, `/people/organizations/${organizationId}/invitations`, 409, 'POST', { user_id: recipient.id, role: 'member' });
    await api(recipient, `/people/invitations/${invitation.id}/decline`, 409, 'POST');
    await api(owner, `/people/invitations/${invitation.id}/revoke`, 409, 'POST');
  });

  await t.test('duplicate invitations are rejected, including simultaneous sends', async () => {
    const { organizationId } = await team();
    const path = `/people/organizations/${organizationId}/invitations`;
    const results = await Promise.all(Array.from({ length: 3 }, () =>
      request(owner, path, [201, 409], 'POST', { user_id: recipient.id, role: 'member' })));
    assert.deepEqual(results.map((result) => result.status).sort(), [201, 409, 409]);
    assert.equal(all("SELECT id FROM organization_invitations WHERE organization_id=? AND invitee_id=? AND status='pending'", organizationId, recipient.id).length, 1);
    await api(owner, path, 409, 'POST', { user_id: owner.id, role: 'member' });
    await api(owner, path, 404, 'POST', { user_id: 'missing-profile', role: 'member' });
    for (const role of ['owner', 'moderator', '', null]) {
      await api(owner, path, 400, 'POST', { user_id: outsider.id, role });
    }
    await api(owner, path, 400, 'POST', { user_id: outsider.id, role: 'member', status: 'accepted' });
    await api(owner, path, 400, 'POST', { user_id: '../not-an-id', role: 'member' });
  });

  await t.test('expiry is effective on reads and acceptance; expired invitations do not block reinvitation', async () => {
    const { organizationId } = await team();
    const invitation = await invite(organizationId);
    run('UPDATE organization_invitations SET expires_at=? WHERE id=?', '2000-01-01T00:00:00.000Z', invitation.id);
    for (const [account, path] of [
      [recipient, '/people/invitations?limit=100'],
      [owner, `/people/organizations/${organizationId}/invitations`],
    ] as const) {
      const list = await api<Invitations>(account, path);
      assert.equal(list.invitations.find((item) => item.id === invitation.id)?.status, 'expired');
    }
    await api(recipient, `/people/invitations/${invitation.id}/accept`, 409, 'POST');
    await api(recipient, `/people/invitations/${invitation.id}/decline`, 409, 'POST');
    await api(owner, `/people/invitations/${invitation.id}/revoke`, 409, 'POST');
    assert.equal(membership(organizationId, recipient.id), undefined);
    const replacement = await invite(organizationId, recipient, 'admin');
    assert.notEqual(replacement.id, invitation.id);
    assert.equal(storedInvitation(invitation.id).status, 'expired');
    await api(recipient, `/people/invitations/${invitation.id}/accept`, 409, 'POST');
    await api(recipient, `/people/invitations/${replacement.id}/accept`, 200, 'POST');
    assert.equal(membership(organizationId, recipient.id)?.role, 'admin');
  });

  await t.test('decline and owner-only revocation are terminal; fresh consent is required to rejoin', async () => {
    const { organizationId } = await team();
    const declined = await invite(organizationId);
    for (const account of [recipient, outsider, moderator]) await api(account, `/people/invitations/${declined.id}/revoke`, 403, 'POST');
    const refusal = await api<{ invitation: Invitation }>(recipient, `/people/invitations/${declined.id}/decline`, 200, 'POST');
    assert.equal(refusal.invitation.status, 'declined');
    assert.ok(refusal.invitation.responded_at);
    await api(recipient, `/people/invitations/${declined.id}/accept`, 409, 'POST');
    const revoked = await invite(organizationId);
    await api(owner, `/people/invitations/${revoked.id}/revoke`, 200, 'POST');
    assert.equal(storedInvitation(revoked.id).status, 'revoked');
    await api(recipient, `/people/invitations/${revoked.id}/accept`, 409, 'POST');
    await api(recipient, `/people/invitations/${revoked.id}/decline`, 409, 'POST');
    assert.equal(membership(organizationId, recipient.id), undefined);
    const fresh = await invite(organizationId);
    await api(recipient, `/people/invitations/${fresh.id}/accept`, 200, 'POST');
    await api(recipient, `/people/invitations/missing-invitation/accept`, 404, 'POST');
  });

  await t.test('an acceptance/revocation race cannot leave an unauthorized membership', async () => {
    const { organizationId } = await team();
    const invitation = await invite(organizationId);
    const results = await Promise.all([
      request(recipient, `/people/invitations/${invitation.id}/accept`, [200, 409], 'POST'),
      request(owner, `/people/invitations/${invitation.id}/revoke`, [200, 409], 'POST'),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
    const status = storedInvitation(invitation.id).status;
    assert.ok(status === 'accepted' || status === 'revoked');
    assert.equal(!!membership(organizationId, recipient.id), status === 'accepted');
  });

  await t.test('acceptance rolls back membership and status when a transactional side effect fails', async (subtest) => {
    const { organizationId } = await team();
    const invitation = await invite(organizationId);
    db.exec(`CREATE TRIGGER fail_team_acceptance BEFORE INSERT ON audit_events
      WHEN NEW.action='organization.invitation.accepted'
      BEGIN SELECT RAISE(ABORT,'Expected test failure: rollback acceptance'); END`);
    const errorLog = subtest.mock.method(console, 'error', () => undefined);
    try {
      await api(recipient, `/people/invitations/${invitation.id}/accept`, 500, 'POST');
      assert.equal(membership(organizationId, recipient.id), undefined);
      assert.equal(storedInvitation(invitation.id).status, 'pending');
      assert.equal(storedInvitation(invitation.id).responded_at, null);
      assert.equal(errorLog.mock.callCount(), 1);
    } finally {
      errorLog.mock.restore();
      db.exec('DROP TRIGGER fail_team_acceptance');
    }
    await api(recipient, `/people/invitations/${invitation.id}/accept`, 200, 'POST');
  });

  await t.test('existing-member role controls preserve compatibility without owner escalation', async () => {
    const { organizationId, projectId } = await team();
    const invitation = await invite(organizationId, recipient, 'admin');
    await api(recipient, `/people/invitations/${invitation.id}/accept`, 200, 'POST');
    assert.equal(canManageProject(recipient.id, projectId), true);
    for (const account of [recipient, outsider, moderator]) {
      await api(account, `/people/organizations/${organizationId}/members/${recipient.id}`, 403, 'PATCH', { role: 'member' });
      await api(account, `/people/organizations/${organizationId}/members`, 403, 'POST', { user_id: recipient.id, role: 'admin' });
      await api(account, `/people/organizations/${organizationId}/members/${owner.id}`, 403, 'DELETE');
      await api(account, `/people/organizations/${organizationId}/invitations`, 403);
      await api(account, `/people/organizations/${organizationId}/invitations`, 403, 'POST', { user_id: outsider.id, role: 'member' });
    }
    const demoted = await api<{ member: Member }>(owner, `/people/organizations/${organizationId}/members/${recipient.id}`, 200, 'PATCH', { role: 'member' });
    assert.equal(demoted.member.role, 'member');
    assert.equal(canManageProject(recipient.id, projectId), false);
    assert.equal(canCollaborateProject(recipient.id, projectId), true);
    const legacy = await api<{ member: Member }>(owner, `/people/organizations/${organizationId}/members`, 200, 'POST', { user_id: recipient.id, role: 'admin' });
    assert.equal(legacy.member.role, 'admin');
    assert.equal(canManageProject(recipient.id, projectId), true);
    await api(owner, `/people/organizations/${organizationId}/members/${recipient.id}`, 400, 'PATCH', { role: 'owner' });
    await api(owner, `/people/organizations/${organizationId}/members`, 400, 'POST', { user_id: recipient.id, role: 'owner' });
    await api(owner, `/people/organizations/${organizationId}/members/${owner.id}`, 409, 'PATCH', { role: 'member' });
    await api(owner, `/people/organizations/${organizationId}/members`, 409, 'POST', { user_id: owner.id, role: 'admin' });
    await api(owner, `/people/organizations/${organizationId}/members/${owner.id}`, 409, 'DELETE');
    await api(owner, `/people/organizations/${organizationId}/leave`, 409, 'POST');
    assert.equal(membership(organizationId, owner.id)?.role, 'owner');
  });

  await t.test('removal and self-leave withdraw live project/workspace access and invalidate old acceptance', async () => {
    const { organizationId, projectId } = await team();
    const invitation = await invite(organizationId, recipient, 'admin');
    await api(recipient, `/people/invitations/${invitation.id}/accept`, 200, 'POST');
    const taskId = randomUUID();
    run('INSERT INTO project_tasks (id,project_id,creator_id,assignee_id,title) VALUES (?,?,?,?,?)', taskId, projectId, owner.id, recipient.id, 'Historical assignment');
    await api(recipient, `/workspace/projects/${projectId}`);
    await api(owner, `/people/organizations/${organizationId}/members/${recipient.id}`, 200, 'DELETE');
    assert.equal(storedInvitation(invitation.id).status, 'revoked');
    await api(recipient, `/people/invitations/${invitation.id}/accept`, 409, 'POST');
    await api(owner, `/people/organizations/${organizationId}/members/${recipient.id}`, 404, 'DELETE');
    async function assertRemoved() {
      assert.equal(membership(organizationId, recipient.id), undefined);
      assert.equal(canReadProject(recipient.id, projectId), false);
      assert.equal(canManageProject(recipient.id, projectId), false);
      assert.equal(canCollaborateProject(recipient.id, projectId), false);
      await api(recipient, `/projects/${projectId}`, 404);
      await api(recipient, `/workspace/projects/${projectId}`, 404);
      await api(recipient, `/workspace/tasks/${taskId}`, 404, 'PATCH', { status: 'done', version: 1 });
      await api(recipient, `/people/organizations/${organizationId}/members`, 403);
      const list = await api<{ organizations: { id: string }[] }>(recipient, '/people/organizations?limit=100');
      assert.ok(!list.organizations.some((organization) => organization.id === organizationId));
      assert.equal(one<{ assignee_id: string }>('SELECT assignee_id FROM project_tasks WHERE id=?', taskId)!.assignee_id, recipient.id);
    }
    await assertRemoved();
    const fresh = await invite(organizationId);
    await api(recipient, `/people/invitations/${fresh.id}/accept`, 200, 'POST');
    await api(recipient, `/people/invitations/${invitation.id}/accept`, 409, 'POST');
    assert.equal(membership(organizationId, recipient.id)?.role, 'member');
    await api(outsider, `/people/organizations/${organizationId}/leave`, 403, 'POST');
    await api(recipient, `/people/organizations/${organizationId}/leave`, 400, 'POST', { user_id: owner.id });
    await api(recipient, `/people/organizations/${organizationId}/leave`, 200, 'POST');
    await api(recipient, `/people/invitations/${fresh.id}/accept`, 409, 'POST');
    await assertRemoved();
    await api(owner, `/projects/${projectId}`);
    await api(owner, `/workspace/projects/${projectId}`);
  });

  await t.test('team mutations produce audit evidence and notifications with working settings links', () => {
    for (const action of ['created', 'accepted', 'declined', 'revoked']) {
      assert.ok(one('SELECT id FROM audit_events WHERE action=?', `organization.invitation.${action}`));
    }
    for (const action of ['role_changed', 'removed', 'left']) {
      assert.ok(one('SELECT id FROM audit_events WHERE action=?', `organization.member.${action}`));
    }
    const notifications = all<{ user_id: string; link: string }>("SELECT user_id,link FROM notifications WHERE kind='organization'");
    assert.ok(notifications.some((notification) => notification.user_id === recipient.id));
    assert.ok(notifications.some((notification) => notification.user_id === owner.id));
    assert.ok(notifications.every((notification) => notification.link === '/settings?tab=teams'));
  });
});
