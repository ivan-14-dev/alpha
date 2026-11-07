import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

process.env.DATABASE_PATH = ':memory:';
const { app } = await import('../server/app.js');
const { db, run } = await import('../server/db.js');

test('V2 privacy stays consistent across projects, the social feed, dashboard and moderation', async (t) => {
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
  const cookies = new Map<string, string>();
  for (const user of ['owner', 'member', 'tester', 'visitor']) {
    run('INSERT INTO users(id,name,email,password_hash) VALUES (?,?,?,?)', user, user, `${user}@example.test`, 'not-a-login-hash');
    const token = randomBytes(32).toString('hex');
    run('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?,?,?)',
      createHash('sha256').update(token).digest('hex'), user, '2099-01-01T00:00:00.000Z');
    cookies.set(user, `alpha_session=${token}`);
  }
  run("INSERT INTO organizations(id,owner_id,name) VALUES ('org','owner','A private team')");
  run("INSERT INTO organization_members(organization_id,user_id,role) VALUES ('org','owner','owner'),('org','member','member')");
  run("INSERT INTO projects(id,owner_id,organization_id,title,summary,category) VALUES ('project','owner','org','A project that may become private','A sufficiently detailed project summary.','saas')");
  run("INSERT INTO campaigns(id,project_id,owner_id,title,description,reward_cents,slots,deadline) VALUES ('campaign','project','owner','Testing','Test instructions',1000,1,'2099-01-01T00:00:00.000Z')");
  run("INSERT INTO applications(id,campaign_id,tester_id,motivation,status) VALUES ('application','campaign','tester','Testing application','accepted')");
  run("INSERT INTO missions(id,campaign_id,tester_id,application_id) VALUES ('mission','campaign','tester','application')");

  async function request<T>(actor: string | null, path: string, expected = 200, method = 'GET', body?: unknown): Promise<T> {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { 'X-Alpha-Client': 'web', 'Content-Type': 'application/json', ...(actor ? { Cookie: cookies.get(actor)! } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json();
    assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(data)}`);
    return data as T;
  }

  const update = (await request<{ post: { id: string } }>('owner', '/community/posts', 201, 'POST', {
    project_id: 'project', body: 'Public update that must disappear after project visibility changes.',
  })).post;
  await request('visitor', `/community/posts/${update.id}/comments`, 201, 'POST', { body: 'A public comment before the visibility change.' });

  await t.test('social project references appear while public and disappear everywhere when private', async () => {
    const before = await request<{ posts: { id: string }[] }>(null, '/dashboard');
    assert.ok(before.posts.some((post) => post.id === update.id));
    await request('owner', '/projects/project', 200, 'PATCH', { visibility: 'private' });
    for (const actor of [null, 'visitor', 'owner', 'member', 'tester']) {
      const dashboard = await request<{ posts: { id: string }[] }>(actor, '/dashboard');
      assert.ok(!dashboard.posts.some((post) => post.id === update.id));
      const feed = await request<{ posts: { id: string }[]; total: number }>(actor, '/community/posts');
      assert.ok(!feed.posts.some((post) => post.id === update.id));
      assert.equal(feed.total, 0);
      await request(actor, `/community/posts/${update.id}/comments`, 404);
      if (actor) {
        await request(actor, `/community/posts/${update.id}/like`, 404, 'POST', {});
        await request(actor, '/trust/reports', 404, 'POST', {
          target_type: 'post', target_id: update.id, reason: 'A hidden post must not grant access through moderation.',
        });
      }
    }
  });

  await t.test('viewing a private test project does not grant access to the private team workspace', async () => {
    const owner = await request<{ project: { can_collaborate: boolean; can_manage: boolean } }>('owner', '/projects/project');
    const member = await request<{ project: { can_collaborate: boolean; can_manage: boolean } }>('member', '/projects/project');
    const tester = await request<{ project: { can_collaborate: boolean; can_manage: boolean } }>('tester', '/projects/project');
    assert.deepEqual([owner.project.can_collaborate, owner.project.can_manage], [true, true]);
    assert.deepEqual([member.project.can_collaborate, member.project.can_manage], [true, false]);
    assert.deepEqual([tester.project.can_collaborate, tester.project.can_manage], [false, false]);
    await request('visitor', '/projects/project', 404);
    await request('owner', '/people/organizations/org/members/member', 200, 'DELETE');
    await request('member', '/projects/project', 404);
    const stillTester = await request<{ project: { can_collaborate: boolean } }>('tester', '/projects/project');
    assert.equal(stillTester.project.can_collaborate, false);
  });

  await t.test('republication restores social access without changing team membership', async () => {
    await request('owner', '/projects/project', 200, 'PATCH', { visibility: 'public' });
    const dashboard = await request<{ posts: { id: string }[] }>(null, '/dashboard');
    assert.ok(dashboard.posts.some((post) => post.id === update.id));
    const feed = await request<{ posts: { id: string }[]; total: number }>(null, '/community/posts');
    assert.equal(feed.total, 1);
    assert.equal(feed.posts[0].id, update.id);
    await request(null, `/community/posts/${update.id}/comments`);
    const profile = await request<{ project: { can_collaborate: boolean } }>('member', '/projects/project');
    assert.equal(profile.project.can_collaborate, false);
  });
});
