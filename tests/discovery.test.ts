import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';

process.env.DATABASE_PATH = ':memory:';
const { attachUser, authRouter } = await import('../server/auth.js');
const { default: discovery } = await import('../server/modules/discovery.js');
const { errorHandler } = await import('../server/core.js');
const { db, run, one } = await import('../server/db.js');
interface Actor { id: string; cookie: string }
interface Resource { id: string; type: string; saved: boolean; title: string; href: string }
interface Page { items: Resource[]; total: number; limit: number; offset: number }

test('V3 discovery and bookmarks keep public results and private collections separate', async (t) => {
  const app = express();
  app.use(express.json(), attachUser);
  app.use('/auth', authRouter);
  app.use('/discovery', discovery);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections();
    });
    db.close();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function request<T = Page>(actor: Actor | null, path: string, status = 200, method = 'GET', body?: unknown): Promise<T> {
    const response = await fetch(base + path, { method,
      headers: { 'Content-Type': 'application/json', 'X-Alpha-Client': 'web', ...(actor?.cookie ? { Cookie: actor.cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(result)}`);
    if (actor && response.headers.get('set-cookie')) actor.cookie = response.headers.get('set-cookie')!.split(';')[0];
    if (status >= 400) assert.equal(typeof result.error, 'string');
    if (path.startsWith('/discovery')) {
      assert.ok(!/"(?:password_hash|token_hash|email|delivery_text|buyer_id|follower_id)":/.test(JSON.stringify(result)));
    }
    return result as T;
  }
  async function account(name: string) {
    const actor = { id: '', cookie: '' };
    const result = await request<{ user: { id: string } }>(actor, '/auth/register', 201, 'POST', {
      name, email: `${name}@discovery.example.test`, password: 'Discovery-fixture-password',
    });
    actor.id = result.user.id; return actor;
  }
  const owner = await account('Owner');
  const reader = await account('Reader');
  const stranger = await account('Stranger');
  run("UPDATE users SET skills='[\"Rust\"]' WHERE id=?", owner.id);
  for (const [id, visibility, title] of [['public', 'public', 'Atlas shared project'], ['private', 'private', 'Atlas secret project'], ['literal', 'public', '100%_literal\\term']] as const) {
    run('INSERT INTO projects(id,owner_id,title,summary,description,category,visibility) VALUES (?,?,?,?,?,?,?)',
      id, owner.id, title, 'Public summary', 'Atlas technology description', 'Web', visibility);
    run('INSERT INTO campaigns(id,project_id,owner_id,title,description,reward_cents,slots,deadline) VALUES (?,?,?,?,?,1000,3,?)',
      `campaign-${id}`, id, owner.id, `Atlas campaign ${id}`, 'A detailed test campaign', '2099-01-01T00:00:00.000Z');
  }
  for (const [id, status] of [['active', 'active'], ['archive', 'archived']] as const) {
    run('INSERT INTO listings(id,seller_id,project_id,title,description,kind,price_cents,license,deliverables,status) VALUES (?,?,?,?,?,?,?,?,?,?)',
      id, owner.id, 'private', `Atlas offer ${id}`, 'Public offer, unrelated to private delivery content', 'software', 2500, 'Nonexclusive rights', 'Source package', status);
  }
  const bookmark = (type: string, id: string) => `/discovery/bookmarks/${type}/${id}`;
  await t.test('search spans types, public skills and literal strings without exposing private project links', async () => {
    const page = await request(null, '/discovery/search?q=Atlas');
    assert.equal(page.total, 5);
    assert.ok(page.items.some((item) => item.type === 'listing' && item.id === 'active'));
    assert.ok(!page.items.some((item) => item.id === 'private' || item.id === 'campaign-private' || item.id === 'archive'));
    assert.deepEqual((await request(owner, '/discovery/search?q=Atlas')).items, page.items);
    const skills = await request(null, '/discovery/search?q=Rust&type=person');
    assert.deepEqual(skills.items.map((item) => item.id), [owner.id]);
    assert.ok(skills.items[0].href.startsWith('/people/'));
    assert.equal((await request(null, `/discovery/search?${new URLSearchParams({ q: '%_literal\\', type: 'project' })}`)).total, 1);
    assert.equal((await request(null, `/discovery/search?${new URLSearchParams({ q: "' OR 1=1 --" })}`)).total, 0);
    assert.equal((await request(null, '/discovery/search?q=Atlas&type=campaign')).total, 2);
  });
  await t.test('pagination is deterministic, bounded and validates repeated or malformed query values', async () => {
    const page1 = await request(null, '/discovery/search?q=Atlas&limit=2');
    const page2 = await request(null, '/discovery/search?q=Atlas&limit=2&offset=2');
    assert.equal(page1.total, 5);
    assert.equal(page2.total, 5);
    assert.equal(page1.items.length, 2);
    assert.equal(page2.items.length, 2);
    assert.equal(new Set([...page1.items, ...page2.items].map((item) => `${item.type}:${item.id}`)).size, 4);
    for (const query of ['limit=0', 'limit=51', 'limit=2&limit=3', 'offset=-1', 'offset=1e2', 'offset=10001', 'type=order', 'q=a&q=b', 'user=someone', `q=${'x'.repeat(121)}`]) {
      await request(null, `/discovery/search?${query}`, 400);
    }
  });
  await t.test('favorites are authenticated, idempotent and invisible to anyone except their owner', async () => {
    await request(null, '/discovery/bookmarks', 401);
    await request(null, bookmark('project', 'public'), 401, 'POST');
    await request(null, bookmark('project', 'public'), 401, 'DELETE');
    await request(null, bookmark('project', 'public'), 401);
    const notifications = one<{ count: number }>('SELECT COUNT(*) AS count FROM notifications')!.count;
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.deepEqual(await request(reader, bookmark('project', 'public'), 200, 'POST'), { saved: true });
    }
    await request(reader, bookmark('campaign', 'campaign-public'), 200, 'POST');
    await request(reader, bookmark('listing', 'active'), 200, 'POST');
    assert.equal((await request(reader, '/discovery/bookmarks')).total, 3);
    assert.equal((await request(stranger, '/discovery/bookmarks')).total, 0);
    assert.equal((await request(owner, '/discovery/bookmarks')).total, 0);
    assert.equal(one<{ count: number }>('SELECT COUNT(*) AS count FROM notifications')!.count, notifications);
    assert.deepEqual(await request(stranger, bookmark('project', 'public')), { saved: false });
    assert.equal((await request(reader, '/discovery/search?q=Atlas&type=project')).items.find((item) => item.id === 'public')!.saved, true);
    assert.equal((await request(stranger, '/discovery/search?q=Atlas&type=project')).items.find((item) => item.id === 'public')!.saved, false);
    await request(reader, '/discovery/bookmarks?type=person', 400);
    await request(reader, '/discovery/bookmarks?user=someone', 400);
    await request(reader, bookmark('person', owner.id), 400, 'POST');
  });
  await t.test('visibility changes remove results and counts; owners cannot save their private resources', async () => {
    await request(owner, bookmark('project', 'private'), 404, 'POST');
    await request(reader, bookmark('listing', 'archive'), 404, 'POST');
    await request(reader, bookmark('campaign', 'missing'), 404, 'POST');
    run("UPDATE projects SET visibility='private' WHERE id='public'");
    run("UPDATE listings SET status='archived' WHERE id='active'");
    const saved = await request(reader, '/discovery/bookmarks');
    assert.deepEqual(saved.items, []);
    assert.equal(saved.total, 0);
    assert.equal((await request(reader, '/discovery/search?q=Atlas')).total, 2);
    await request(reader, bookmark('project', 'public'), 404);
    await request(reader, bookmark('campaign', 'campaign-public'), 404, 'POST');
    assert.deepEqual(await request(reader, bookmark('project', 'public'), 200, 'DELETE'), { saved: false });
    assert.deepEqual(await request(reader, bookmark('project', 'public'), 200, 'DELETE'), { saved: false });
    run("UPDATE projects SET visibility='public' WHERE id='public'");
    run("UPDATE listings SET status='active' WHERE id='active'");
    assert.equal((await request(reader, '/discovery/bookmarks')).total, 2);
    assert.equal((await request(reader, '/discovery/bookmarks?type=campaign&q=Atlas&limit=1')).total, 1);
  });
});
