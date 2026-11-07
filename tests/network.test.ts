import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';

process.env.DATABASE_PATH = ':memory:';
const { attachUser, authRouter } = await import('../server/auth.js');
const { default: network } = await import('../server/modules/network.js');
const { default: community } = await import('../server/modules/community.js');
const { errorHandler } = await import('../server/core.js');
const { db, one, run } = await import('../server/db.js');

interface Actor { id: string; cookie: string; name: string }
interface Status { following: boolean; followers: number; can_follow: boolean }
interface Post { id: string; body: string; project_id: string | null; project_title: string | null }
interface Page { total: number; page: number; page_size: number; has_more: boolean }
interface Feed extends Page { posts: Post[] }
interface Following extends Page { items: { id: string; followers: number }[] }

function assertNoSecrets(value: unknown) {
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    assert.ok(!['email', 'password_hash', 'token_hash'].includes(key), `Private field leaked: ${key}`);
    assertNoSecrets(nested);
  }
}

test('network and community HTTP integration: follows, feeds, project updates and current visibility', async (t) => {
  const app = express();
  app.use(express.json(), attachUser);
  app.use('/api/auth', authRouter);
  app.use('/api/network', network);
  app.use('/api/community', community);
  app.use(errorHandler);
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
  async function api<T = Record<string, unknown>>(actor: Actor | null, path: string, expected = 200, method = 'GET', body?: unknown): Promise<T> {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { 'X-Alpha-Client': 'web', 'Content-Type': 'application/json', ...(actor?.cookie ? { Cookie: actor.cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    assert.equal(response.status, expected, `${method} ${path}: ${text}`);
    const value = JSON.parse(text);
    if (expected >= 400) assert.equal(typeof value.error, 'string');
    if (actor && response.headers.get('set-cookie')) actor.cookie = response.headers.get('set-cookie')!.split(';', 1)[0];
    if (!path.startsWith('/auth/')) assertNoSecrets(value);
    return value as T;
  }
  async function account(name: string) {
    const actor = { id: '', cookie: '', name };
    const result = await api<{ user: { id: string } }>(actor, '/auth/register', 201, 'POST', {
      name, email: `${name}@network.example.test`, password: 'Network-test-password-2026!',
    });
    actor.id = result.user.id;
    return actor;
  }
  const owner = await account('Owner');
  const author = await account('Author');
  const reader = await account('Reader');
  const other = await account('Other');
  const manager = await account('Manager');
  const member = await account('Member');
  run("INSERT INTO organizations (id,owner_id,name) VALUES ('org',?,'Public team')", owner.id);
  for (const [actor, role] of [[owner, 'owner'], [manager, 'admin'], [member, 'member']] as const) {
    run('INSERT INTO organization_members (organization_id,user_id,role) VALUES (?,?,?)', 'org', actor.id, role);
  }
  function project(id: string, actor: Actor, visibility = 'public', organization: string | null = null) {
    run(`INSERT INTO projects (id,owner_id,organization_id,title,summary,category,visibility)
      VALUES (?,?,?,?,?,?,?)`, id, actor.id, organization, `${id} project title`, 'A public project summary', 'Web', visibility);
  }
  project('followed-project', owner, 'public', 'org');
  project('unfollowed-project', owner);
  project('author-project', author);
  project('private-project', owner, 'private', 'org');
  const followUser = (id: string) => `/network/users/${id}/follow`;
  const followProject = (id: string) => `/network/projects/${id}/follow`;
  const statusPath = (type: 'user' | 'project', id: string) => `/network/status?target_type=${type}&target_id=${id}`;
  const notificationCount = (kind?: string) => one<{ count: number }>(`SELECT COUNT(*) AS count FROM notifications${kind ? ' WHERE kind=?' : ''}`, ...(kind ? [kind] : []))!.count;
  const createPost = async (actor: Actor, body: string, context: Record<string, string> = {}) =>
    (await api<{ post: Post }>(actor, '/community/posts', 201, 'POST', { body, ...context })).post;
  let projectPost: Post;
  let authorPost: Post;
  let ownPost: Post;
  let joinedPost: Post;
  let authorProjectPost: Post;
  let groupId: string;
  let commentId: string;

  await t.test('user follows are authenticated, non-self, idempotent and private-data free', async () => {
    assert.deepEqual(await api(null, statusPath('user', author.id)), { following: false, followers: 0, can_follow: false });
    assert.deepEqual(await api(author, statusPath('user', author.id)), { following: false, followers: 0, can_follow: false });
    await api(null, followUser(author.id), 401, 'POST');
    await api(null, followUser(author.id), 401, 'DELETE');
    await api(null, '/network/following', 401);
    await api(reader, followUser(reader.id), 400, 'POST');
    await api(reader, followUser('missing-user'), 404, 'POST');
    await api(reader, '/network/status?target_type=team&target_id=x', 400);
    await api(reader, '/network/status?target_type=user', 400);
    const before = notificationCount();
    for (let i = 0; i < 2; i++) {
      assert.deepEqual(await api(reader, followUser(author.id), 200, 'POST'), { following: true, followers: 1, can_follow: true });
    }
    assert.equal(notificationCount(), before + 1);
    assert.deepEqual(await api(null, statusPath('user', author.id)), { following: false, followers: 1, can_follow: false });
    assert.equal((await api<Following>(other, '/network/following?type=users')).total, 0);
    assert.equal((await api<Following>(reader, `/network/following?type=users&user_id=${other.id}`)).items[0].id, author.id);
    const notification = one<{ title: string; body: string }>("SELECT title,body FROM notifications WHERE kind='network.follow'")!;
    assert.ok(!JSON.stringify(notification).includes('@'));
  });

  await t.test('public project follows are idempotent; private status and targets are hidden even from owners', async () => {
    await api(null, followProject('followed-project'), 401, 'POST');
    await api(null, followProject('followed-project'), 401, 'DELETE');
    const before = notificationCount();
    for (let i = 0; i < 2; i++) {
      assert.deepEqual(await api(reader, followProject('followed-project'), 200, 'POST'), { following: true, followers: 1, can_follow: true });
    }
    assert.equal(notificationCount(), before + 1);
    assert.equal((await api<Status>(null, statusPath('project', 'followed-project'))).followers, 1);
    for (const actor of [null, reader, owner, manager]) {
      await api(actor, statusPath('project', 'private-project'), 404);
      if (actor) await api(actor, followProject('private-project'), 404, 'POST');
    }
    await api(reader, followProject('missing-project'), 404, 'POST');
    assert.deepEqual(await api(reader, followProject('missing-project'), 200, 'DELETE'), { following: false });
  });

  await t.test('own following lists paginate with correct counts and do not expose another account', async () => {
    await api(reader, followUser(other.id), 200, 'POST');
    const first = await api<Following>(reader, '/network/following?type=users&page_size=1');
    const second = await api<Following>(reader, '/network/following?type=users&page_size=1&page=2');
    assert.equal(first.total, 2); assert.equal(first.has_more, true); assert.equal(first.page_size, 1);
    assert.equal(second.total, 2); assert.equal(second.has_more, false);
    assert.deepEqual(new Set([...first.items, ...second.items].map((item) => item.id)), new Set([author.id, other.id]));
    assert.equal((await api<Following>(reader, '/network/following?type=users&page=9')).items.length, 0);
    for (const query of ['page=0', 'page=1.5', 'page_size=51', 'page_size=-1', 'type=all']) {
      await api(reader, `/network/following?${query}`, 400);
    }
    const before = notificationCount();
    for (let i = 0; i < 2; i++) assert.deepEqual(await api(reader, followUser(other.id), 200, 'DELETE'), { following: false });
    assert.equal(notificationCount(), before);
    assert.equal((await api<Status>(reader, statusPath('user', other.id))).followers, 0);
    await api(reader, followProject('unfollowed-project'), 200, 'POST');
    const projects = await api<Following>(reader, '/network/following?type=projects&page_size=1');
    assert.equal(projects.total, 2); assert.equal(projects.items.length, 1); assert.equal(projects.has_more, true);
    await api(reader, followProject('unfollowed-project'), 200, 'DELETE');
  });

  await t.test('publication choices and writes require a public project manager; group/project contexts are exclusive', async () => {
    await api(null, '/community/publishable-projects', 401);
    await api(null, '/community/posts', 401, 'POST', { body: 'Guest update', project_id: 'followed-project' });
    const choices = await api<{ projects: { id: string; title: string }[] }>(manager, '/community/publishable-projects');
    assert.deepEqual(choices.projects.map((project) => project.id), ['followed-project']);
    assert.equal((await api<{ projects: unknown[] }>(member, '/community/publishable-projects')).projects.length, 0);
    assert.equal((await api<{ projects: unknown[] }>(owner, '/community/publishable-projects?project=private-project')).projects.length, 0);
    const ownChoices = await api<Page & { projects: { id: string }[] }>(owner, '/community/publishable-projects?page_size=1');
    assert.equal(ownChoices.total, 2); assert.equal(ownChoices.has_more, true); assert.equal(ownChoices.projects.length, 1);
    for (const actor of [reader, member, other]) {
      await api(actor, '/community/posts', 403, 'POST', { body: 'Unauthorized update', project_id: 'followed-project' });
    }
    for (const actor of [owner, manager, reader]) {
      await api(actor, '/community/posts', 404, 'POST', { body: 'Private content', project_id: 'private-project' });
    }
    const group = await api<{ group: { id: string } }>(other, '/community/groups', 201, 'POST', { name: 'Joined group', description: 'Our public group', category: 'Web' });
    groupId = group.group.id;
    await api(reader, `/community/groups/${groupId}/join`, 200, 'POST');
    await api(other, '/community/posts', 400, 'POST', { body: 'Both contexts', group_id: groupId, project_id: 'followed-project' });
    const update = await createPost(manager, 'Manager-authorized update', { project_id: 'followed-project' });
    await api(manager, `/community/posts/${update.id}`, 200, 'DELETE');
    assert.equal((await api<{ projects: { id: string }[] }>(owner, '/community/publishable-projects?project=followed-project')).projects[0].id, 'followed-project');
  });

  await t.test('following feed is the union of own posts, followed authors, followed public projects and joined groups', async () => {
    await api(null, '/community/posts?feed=following', 401);
    await api(null, '/community/posts?feed=unknown', 400);
    const before = notificationCount();
    ownPost = await createPost(reader, 'My own public post');
    authorPost = await createPost(author, 'A followed author post');
    await createPost(other, 'Unrelated global post');
    joinedPost = await createPost(other, 'A joined-group post', { group_id: groupId });
    const unrelated = await api<{ group: { id: string } }>(other, '/community/groups', 201, 'POST', { name: 'Unjoined group', description: 'Another public group', category: 'Web' });
    await createPost(other, 'Unjoined-group post', { group_id: unrelated.group.id });
    await createPost(owner, 'Unfollowed-project post', { project_id: 'unfollowed-project' });
    authorProjectPost = await createPost(author, 'Followed author project post', { project_id: 'author-project' });
    assert.equal(notificationCount(), before, 'General and non-followed project posts must not broadcast notifications');
    projectPost = await createPost(owner, 'Sensitive public update later made private', { project_id: 'followed-project' });
    assert.equal(notificationCount(), before + 1);
    const notification = one<{ title: string; body: string; link: string }>(`SELECT title,body,link FROM notifications
      WHERE user_id=? AND kind='community.project_update' ORDER BY created_at DESC LIMIT 1`, reader.id)!;
    assert.equal(notification.link, '/community?project=followed-project');
    assert.ok(!notification.body.includes(projectPost.body));
    assert.ok(!JSON.stringify(notification).includes('project title'));
    const expected = new Set([ownPost.id, authorPost.id, joinedPost.id, authorProjectPost.id, projectPost.id]);
    const feed = await api<Feed>(reader, '/community/posts?feed=following');
    assert.equal(feed.total, 5);
    assert.deepEqual(new Set(feed.posts.map((post) => post.id)), expected);
    const first = await api<Feed>(reader, '/community/posts?feed=following&page_size=2');
    const second = await api<Feed>(reader, '/community/posts?feed=following&page_size=2&page=2');
    const third = await api<Feed>(reader, '/community/posts?feed=following&page_size=2&page=3');
    assert.equal(first.total, 5); assert.equal(first.has_more, true);
    assert.equal(second.total, 5); assert.equal(third.has_more, false);
    assert.deepEqual(new Set([...first.posts, ...second.posts, ...third.posts].map((post) => post.id)), expected);
    const discovery = await api<Feed>(null, '/community/posts');
    assert.equal(discovery.total, 8);
    assert.equal((await api<Feed>(null, '/community/posts?feed=discovery')).total, discovery.total);
    assert.equal((await api<Feed>(reader, `/community/posts?feed=following&group=${groupId}`)).total, 1);
    assert.equal((await api<Feed>(reader, '/community/posts?project=followed-project')).posts[0].id, projectPost.id);
    assert.equal((await api<Feed>(other, '/community/posts?feed=following&project=followed-project')).total, 0);
    await api(reader, followUser(owner.id), 200, 'POST');
    const overlap = await api<Feed>(reader, '/community/posts?feed=following');
    assert.equal(overlap.posts.filter((post) => post.id === projectPost.id).length, 1, 'OR membership must not duplicate posts');
    await api(reader, followUser(owner.id), 200, 'DELETE');
  });

  await t.test('public project comments and likes work before privatization', async () => {
    const result = await api<{ comment: { id: string }; comment_count: number }>(reader, `/community/posts/${projectPost.id}/comments`, 201, 'POST', { body: 'Comment hidden with project' });
    commentId = result.comment.id;
    assert.equal(result.comment_count, 1);
    assert.equal((await api<Feed>(null, '/community/posts?project=followed-project')).total, 1);
    assert.equal((await api<Page>(null, `/community/posts/${projectPost.id}/comments`)).total, 1);
    assert.deepEqual(await api(reader, `/community/posts/${projectPost.id}/like`, 200, 'POST'), { liked: true, like_count: 1 });
    assert.deepEqual(await api(null, `/community/posts/${projectPost.id}/like`), { liked: false, like_count: 1 });
    await api(reader, `/community/posts/${projectPost.id}`, 403, 'DELETE');
  });

  await t.test('privatization hides all lists, counts, direct posts, comment deletion and likes, including from the author', async () => {
    run("UPDATE projects SET visibility='private' WHERE id='followed-project'");
    const notificationsBefore = notificationCount();
    const countBefore = one<{ count: number }>('SELECT COUNT(*) AS count FROM comments WHERE post_id=?', projectPost.id)!.count;
    for (const actor of [null, reader, owner, manager]) {
      const discovery = await api<Feed>(actor, '/community/posts');
      assert.equal(discovery.total, 7);
      assert.ok(!JSON.stringify(discovery).includes(projectPost.id));
      assert.ok(!JSON.stringify(discovery).includes('"followed-project"'));
      assert.ok(!JSON.stringify(discovery).includes('"followed-project project title"'));
      assert.ok(!JSON.stringify(discovery).includes(projectPost.body));
      await api(actor, '/community/posts?project=followed-project', 404);
      await api(actor, statusPath('project', 'followed-project'), 404);
      await api(actor, `/community/posts/${projectPost.id}`, 404);
      await api(actor, `/community/posts/${projectPost.id}/comments`, 404);
      await api(actor, `/community/posts/${projectPost.id}/like`, 404);
      if (actor) {
        await api(actor, followProject('followed-project'), 404, 'POST');
        await api(actor, `/community/posts/${projectPost.id}/like`, 404, 'POST');
        await api(actor, `/community/posts/${projectPost.id}/comments`, 404, 'POST', { body: 'Hidden comment attempt' });
        await api(actor, `/community/comments/${commentId}`, 404, 'DELETE');
        await api(actor, `/community/posts/${projectPost.id}/comments/${commentId}`, 404, 'DELETE');
        await api(actor, `/community/posts/${projectPost.id}`, 404, 'DELETE');
        assert.ok(!(await api<Feed>(actor, '/community/posts?feed=following')).posts.some((post) => post.id === projectPost.id));
      }
    }
    assert.equal(notificationCount(), notificationsBefore);
    assert.equal(one<{ count: number }>('SELECT COUNT(*) AS count FROM comments WHERE post_id=?', projectPost.id)!.count, countBefore);
    assert.equal((await api<Feed>(reader, '/community/posts?feed=following')).total, 4);
    const following = await api<Following>(reader, '/network/following?type=projects');
    assert.equal(following.total, 0); assert.deepEqual(following.items, []);
    assert.ok(!JSON.stringify(await api(owner, '/community/publishable-projects')).includes('"followed-project"'));
    for (let i = 0; i < 2; i++) assert.deepEqual(await api(reader, followProject('followed-project'), 200, 'DELETE'), { following: false });
    assert.equal(one('SELECT user_id FROM project_follows WHERE project_id=? AND user_id=?', 'followed-project', reader.id), undefined);
  });

  await t.test('removing follows and memberships changes the personal feed, and deleted routes reveal no old data', async () => {
    await api(reader, followUser(author.id), 200, 'DELETE');
    assert.deepEqual(new Set((await api<Feed>(reader, '/community/posts?feed=following')).posts.map((post) => post.id)), new Set([ownPost.id, joinedPost.id]));
    await api(reader, `/community/groups/${groupId}/leave`, 200, 'POST');
    assert.deepEqual((await api<Feed>(reader, '/community/posts?feed=following')).posts.map((post) => post.id), [ownPost.id]);
    run("UPDATE projects SET visibility='public' WHERE id='followed-project'");
    assert.deepEqual(await api(reader, statusPath('project', 'followed-project')), { following: false, followers: 0, can_follow: true });
    const before = notificationCount('network.follow');
    await api(reader, followProject('followed-project'), 200, 'POST');
    await api(reader, followProject('followed-project'), 200, 'POST');
    assert.equal(notificationCount('network.follow'), before + 1, 'A removed follow can be re-created, but duplicates do not notify');
    const second = await api<{ comment: { id: string } }>(owner, `/community/posts/${projectPost.id}/comments`, 201, 'POST', { body: 'Owner comment' });
    assert.deepEqual(await api(reader, `/community/comments/${commentId}`, 200, 'DELETE'), { deleted: true, comment_count: 1 });
    await api(owner, `/community/posts/${projectPost.id}`, 200, 'DELETE');
    await api(null, `/community/posts/${projectPost.id}`, 404);
    await api(null, `/community/posts/${projectPost.id}/comments`, 404);
    await api(reader, `/community/posts/${projectPost.id}/like`, 404, 'POST');
    await api(owner, `/community/comments/${second.comment.id}`, 404, 'DELETE');
    await api(owner, `/community/posts/${projectPost.id}/comments/${second.comment.id}`, 404, 'DELETE');
    await api(owner, `/community/posts/${projectPost.id}`, 404, 'DELETE');
    assert.equal((await api<Feed>(null, '/community/posts?project=followed-project')).total, 0);
    assert.equal(one('SELECT post_id FROM post_likes WHERE post_id=?', projectPost.id), undefined);
  });
});
