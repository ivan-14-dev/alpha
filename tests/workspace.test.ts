import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';

process.env.DATABASE_PATH = ':memory:';
const { all, db, one, run } = await import('../server/db.js');
const { attachUser } = await import('../server/auth.js');
const { canCollaborateProject, canReadProject, errorHandler } = await import('../server/core.js');
const { default: workspace } = await import('../server/modules/workspace.js');

interface Actor { id: string; cookie: string }
interface Project { id: string; title: string }
interface Task {
  id: string; project_id: string; title: string; description: string;
  status: string; priority: string; due_at: string | null; version: number; assignee_id: string | null;
  assignee: { id: string; name: string; is_former_member: boolean } | null;
}
interface Board {
  project: Project; can_manage: boolean; tasks: Task[];
  eligible_assignees: { id: string; name: string }[];
  total: number; limit: number; offset: number;
  stats: { total: number; done: number; todo: number; in_progress: number };
}
interface Projects { projects: Project[]; total: number; offset: number; limit: number }

function noSecrets(value: unknown) {
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    assert.ok(!['email', 'password_hash', 'token_hash'].includes(key), `Private field leaked: ${key}`);
    noSecrets(nested);
  }
}

test('workspace HTTP: private team authorization, versioned mutations and pagination', async (t) => {
  const app = express();
  app.use(express.json({ limit: '128kb' }), attachUser);
  app.use('/api/workspace', workspace);
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
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/workspace`;
  async function request<T>(actor: Actor | null, path: string, expected = 200, method = 'GET', body?: unknown): Promise<T> {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        'X-Alpha-Client': 'web', ...(actor ? { Cookie: actor.cookie } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    assert.equal(response.status, expected, `${method} ${path}: ${text}`);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const data = JSON.parse(text);
    noSecrets(data);
    if (expected >= 400) assert.equal(typeof data.error, 'string');
    return data as T;
  }
  function actor(name: string, role = 'member'): Actor {
    const id = randomUUID();
    const token = randomBytes(32).toString('hex');
    run('INSERT INTO users(id,name,email,password_hash,role) VALUES (?,?,?,?,?)', id, name, `${id}@example.test`, 'unused-test-hash', role);
    run('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?,?,?)',
      createHash('sha256').update(token).digest('hex'), id, '2099-01-01T00:00:00.000Z');
    return { id, cookie: `alpha_session=${token}` };
  }
  const owner = actor('Project owner');
  const orgOwner = actor('Organization owner');
  const admin = actor('Organization admin');
  const member = actor('Organization member');
  const colleague = actor('Other member');
  const tester = actor('External selected tester');
  const outsider = actor('Public visitor');
  const moderator = actor('Platform administrator', 'admin');
  const organizationId = randomUUID();
  run('INSERT INTO organizations(id,owner_id,name) VALUES (?,?,?)', organizationId, orgOwner.id, 'Workspace team');
  for (const [user, role] of [[owner, 'member'], [orgOwner, 'owner'], [admin, 'admin'], [member, 'member'], [colleague, 'member']] as const) {
    run('INSERT INTO organization_members(organization_id,user_id,role) VALUES (?,?,?)', organizationId, user.id, role);
  }
  function project(title: string, visibility = 'private', organization: string | null = organizationId) {
    const id = randomUUID();
    run('INSERT INTO projects(id,owner_id,organization_id,title,summary,category,visibility) VALUES (?,?,?,?,?,?,?)',
      id, owner.id, organization, title, 'Private team work', 'saas', visibility);
    return id;
  }
  const privateProject = project('Confidential workspace');
  const publicProject = project('Public project, private tasks', 'public');
  const personalProject = project('Personal owner-only project', 'private', null);
  const campaign = randomUUID();
  const application = randomUUID();
  run(`INSERT INTO campaigns(id,project_id,owner_id,title,description,reward_cents,slots,deadline)
    VALUES (?,?,?,?,?,?,?,?)`, campaign, privateProject, owner.id, 'Test campaign', 'External testers', 100, 1, '2099-01-01T00:00:00.000Z');
  run('INSERT INTO applications(id,campaign_id,tester_id,motivation,status) VALUES (?,?,?,?,?)',
    application, campaign, tester.id, 'Selected tester', 'accepted');
  run('INSERT INTO missions(id,campaign_id,tester_id,application_id) VALUES (?,?,?,?)',
    randomUUID(), campaign, tester.id, application);
  async function create(actor: Actor, projectId = privateProject, input: Record<string, unknown> = {}) {
    return (await request<{ task: Task }>(actor, `/projects/${projectId}/tasks`, 201, 'POST', {
      title: 'Private task', ...input,
    })).task;
  }
  const notificationCount = () => one<{ count: number }>("SELECT COUNT(*) AS count FROM notifications WHERE kind='task_assignment'")!.count;
  const auditCount = () => one<{ count: number }>("SELECT COUNT(*) AS count FROM audit_events WHERE target_type='project_task'")!.count;

  await t.test('only project owners and current organization members can discover or read team data', async () => {
    for (const user of [owner, orgOwner, admin, member, colleague]) {
      assert.equal(canCollaborateProject(user.id, privateProject), true);
      const board = await request<Board>(user, `/projects/${privateProject}`);
      assert.equal(board.can_manage, [owner, orgOwner, admin].includes(user));
      assert.equal(board.tasks.length, 0);
      assert.equal(board.eligible_assignees.length, 5);
      assert.equal(new Set(board.eligible_assignees.map((person) => person.id)).size, 5);
      assert.ok(board.eligible_assignees.some((person) => person.id === owner.id));
      assert.ok(!board.eligible_assignees.some((person) => person.id === tester.id));
      const projects = await request<Projects>(user, '/projects');
      assert.equal(projects.total, user === owner ? 3 : 2);
      assert.equal(projects.projects.some((project) => project.id === personalProject), user === owner);
    }
    assert.equal(canReadProject(tester.id, privateProject), true);
    for (const user of [outsider, tester, moderator]) {
      assert.equal(canCollaborateProject(user.id, privateProject), false);
      assert.equal(canReadProject(user.id, publicProject), true);
      assert.deepEqual((await request<Projects>(user, '/projects')).projects, []);
      for (const project of [privateProject, publicProject, personalProject]) {
        await request(user, `/projects/${project}`, 404);
        await request(user, `/projects/${project}/tasks`, 404, 'POST', { title: 'Forbidden' });
      }
    }
    await request(member, `/projects/${personalProject}`, 404);
    await request(null, '/projects', 401);
    await request(null, `/projects/${publicProject}`, 401);
    await request(null, `/projects/${publicProject}/tasks`, 401, 'POST', { title: 'Forbidden' });
    await request(owner, '/projects/not-present', 404);
    await request(owner, '/projects/bad%20identifier', 400);
  });

  await t.test('managers create tasks; assignees are only owners or current members', async () => {
    for (const manager of [owner, orgOwner, admin]) {
      const task = await create(manager, privateProject, { assignee_id: member.id });
      assert.equal(task.version, 1);
      assert.equal(task.status, 'todo');
      assert.equal(task.priority, 'normal');
      assert.equal(task.description, '');
      assert.equal(task.due_at, null);
      assert.equal(task.assignee?.is_former_member, false);
    }
    for (const collaborator of [member, colleague]) {
      await request(collaborator, `/projects/${privateProject}/tasks`, 403, 'POST', { title: 'Not a manager' });
    }
    const before = notificationCount();
    await create(owner, privateProject, { assignee_id: null });
    assert.equal(notificationCount(), before);
    for (const assignee_id of [tester.id, outsider.id, moderator.id, 'not-present']) {
      await request(owner, `/projects/${privateProject}/tasks`, 400, 'POST', { title: 'Ineligible', assignee_id });
    }
    await request(owner, `/projects/${personalProject}/tasks`, 400, 'POST', { title: 'No shared organization', assignee_id: member.id });
    const personal = await create(owner, personalProject, { assignee_id: owner.id });
    assert.equal(personal.assignee_id, owner.id);
    const publicTask = await create(owner, publicProject, { description: 'Secret public-project plan' });
    for (const visitor of [outsider, tester, moderator]) {
      await request(visitor, `/tasks/${publicTask.id}`, 404);
      await request(visitor, `/tasks/${publicTask.id}`, 404, 'PATCH', { version: 1, status: 'done' });
      await request(visitor, `/tasks/${publicTask.id}?version=1`, 404, 'DELETE');
    }
  });

  await t.test('strict create/update validation rejects malformed fields, dates, and versions without writes', async () => {
    const count = one<{ count: number }>('SELECT COUNT(*) AS count FROM project_tasks')!.count;
    for (const invalid of [
      { title: '' }, { title: '   ' }, { title: 'a'.repeat(161) }, { title: 7 }, { description: 'a'.repeat(12001) },
      { priority: 'urgent' }, { due_at: '' }, { due_at: 'tomorrow' }, { due_at: '2026-02-30T12:00:00Z' },
      { due_at: '2026-01-01' }, { due_at: 123 }, { assignee_id: '' }, { status: 'done' }, { project_id: publicProject },
      { creator_id: tester.id }, { version: 2 },
    ]) await request(owner, `/projects/${privateProject}/tasks`, 400, 'POST', { title: 'Valid title', ...invalid });
    assert.equal(one<{ count: number }>('SELECT COUNT(*) AS count FROM project_tasks')!.count, count);
    const task = await create(owner, privateProject, { due_at: '2026-01-02T03:04:00+02:00' });
    assert.equal(task.due_at, '2026-01-02T01:04:00.000Z');
    const beforeAudit = auditCount();
    for (const invalid of [
      {}, { version: 1 }, { status: 'done' }, { version: 0, status: 'done' }, { version: -1, status: 'done' },
      { version: 1.5, status: 'done' }, { version: '1', status: 'done' }, { version: null, status: 'done' },
      { version: Number.MAX_SAFE_INTEGER, status: 'done' }, { version: 1, status: 'bad' },
      { version: 1, title: ' ' }, { version: 1, priority: 'critical' },
      { version: 1, due_at: 'invalid' }, { version: 1, assignee_id: tester.id },
      { version: 1, project_id: publicProject }, { version: 1, creator_id: tester.id },
    ]) await request(owner, `/tasks/${task.id}`, 400, 'PATCH', invalid);
    assert.equal(auditCount(), beforeAudit);
    assert.equal((await request<{ task: Task }>(owner, `/tasks/${task.id}`)).task.version, 1);
    const cleared = await request<{ task: Task }>(owner, `/tasks/${task.id}`, 200, 'PATCH', { version: 1, due_at: null });
    assert.equal(cleared.task.due_at, null);
    assert.equal(cleared.task.version, 2);
  });

  await t.test('assignees can only change status; managers can edit every allowed field', async () => {
    const task = await create(owner, privateProject, { assignee_id: member.id });
    for (const fields of [
      { title: 'Changed' }, { description: 'Changed' }, { priority: 'high' }, { due_at: null },
      { assignee_id: colleague.id }, { project_id: publicProject }, { version: 1, extra: true },
    ]) {
      await request(member, `/tasks/${task.id}`, 403, 'PATCH', { version: 1, status: 'done', ...fields });
    }
    await request(colleague, `/tasks/${task.id}`, 403, 'PATCH', { version: 1, status: 'done' });
    await request(member, `/tasks/${task.id}?version=1`, 403, 'DELETE');
    const changed = await request<{ task: Task }>(member, `/tasks/${task.id}`, 200, 'PATCH', { version: 1, status: 'in_progress' });
    assert.equal(changed.task.version, 2);
    assert.equal(changed.task.status, 'in_progress');
    const edited = await request<{ task: Task }>(admin, `/tasks/${task.id}`, 200, 'PATCH', {
      version: 2, title: 'Updated title', description: 'Updated description', priority: 'high',
      due_at: '2030-01-02T00:00:00Z', assignee_id: colleague.id, status: 'done',
    });
    assert.equal(edited.task.version, 3);
    assert.equal(edited.task.title, 'Updated title');
    assert.equal(edited.task.description, 'Updated description');
    assert.equal(edited.task.assignee_id, colleague.id);
    await request(member, `/tasks/${task.id}`, 403, 'PATCH', { version: 3, status: 'todo' });
  });

  await t.test('atomic concurrent updates cannot overwrite a stale version, including status and deletion', async () => {
    const task = await create(owner);
    const auditBefore = auditCount();
    const responses = await Promise.all(['First writer', 'Second writer'].map((title) => fetch(`${base}/tasks/${task.id}`, {
      method: 'PATCH', headers: { Cookie: owner.cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 1, title }),
    })));
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
    const winner = await responses.find((response) => response.status === 200)!.json() as { task: Task };
    const conflict = await responses.find((response) => response.status === 409)!.json() as { error: string };
    assert.match(conflict.error, /Rechargez/);
    const current = (await request<{ task: Task }>(owner, `/tasks/${task.id}`)).task;
    assert.equal(current.title, winner.task.title);
    assert.equal(current.version, 2);
    assert.equal(auditCount(), auditBefore + 1);
    await request(owner, `/tasks/${task.id}`, 409, 'PATCH', { version: 1, title: current.title });
    await request(owner, `/tasks/${task.id}`, 409, 'PATCH', { version: 1, status: 'done' });
    await request(owner, `/tasks/${task.id}?version=1`, 409, 'DELETE');
    assert.equal((await request<{ task: Task }>(owner, `/tasks/${task.id}`)).task.version, 2);
    for (const suffix of ['', '?version=0', '?version=-1', '?version=1.5', '?version=1e2', '?version=2&version=2', '?version=2&extra=true']) {
      await request(owner, `/tasks/${task.id}${suffix}`, 400, 'DELETE');
    }
    await request(owner, `/tasks/${task.id}?version=2`, 200, 'DELETE');
    assert.equal(one('SELECT id FROM project_tasks WHERE id=?', task.id), undefined);
    assert.equal(auditCount(), auditBefore + 2);
    await request(owner, `/tasks/${task.id}?version=2`, 404, 'DELETE');
  });

  await t.test('notifications are generic, assignment-only and once per actual mutation; all mutations are audited', async () => {
    const notificationsBefore = notificationCount();
    const auditsBefore = auditCount();
    const task = await create(owner, privateProject, {
      title: 'Secret title never sent in notifications', description: 'Secret description',
      assignee_id: member.id,
    });
    assert.equal(notificationCount(), notificationsBefore + 1);
    const noChange = await request<{ task: Task }>(owner, `/tasks/${task.id}`, 200, 'PATCH', { version: 1, assignee_id: member.id, status: 'todo' });
    assert.equal(noChange.task.version, 1);
    assert.equal(auditCount(), auditsBefore + 1);
    assert.equal(notificationCount(), notificationsBefore + 1);
    await request(member, `/tasks/${task.id}`, 200, 'PATCH', { version: 1, status: 'in_progress' });
    assert.equal(notificationCount(), notificationsBefore + 1);
    await request(owner, `/tasks/${task.id}`, 200, 'PATCH', { version: 2, assignee_id: colleague.id });
    assert.equal(notificationCount(), notificationsBefore + 2);
    await request(owner, `/tasks/${task.id}`, 409, 'PATCH', { version: 2, assignee_id: colleague.id });
    assert.equal(notificationCount(), notificationsBefore + 2);
    await request(owner, `/tasks/${task.id}`, 200, 'PATCH', { version: 3, assignee_id: null });
    assert.equal(notificationCount(), notificationsBefore + 2);
    await request(owner, `/tasks/${task.id}?version=4`, 200, 'DELETE');
    assert.equal(auditCount(), auditsBefore + 5);
    const notifications = all<{ title: string; body: string; link: string }>("SELECT title,body,link FROM notifications WHERE kind='task_assignment'");
    for (const notification of notifications) {
      assert.ok(!`${notification.title} ${notification.body}`.includes('Secret'));
      assert.ok(!`${notification.title} ${notification.body}`.includes('Confidential'));
      assert.match(notification.link, /^\/workspace\?project=[a-zA-Z0-9-]+$/);
    }
  });

  await t.test('audit failures roll back the mutation and its assignment notification', async () => {
    const task = await create(owner, privateProject, { assignee_id: member.id });
    const notificationsBefore = notificationCount();
    const auditsBefore = auditCount();
    db.exec(`CREATE TRIGGER reject_test_task_audit BEFORE INSERT ON audit_events
      WHEN NEW.action='task.updated' BEGIN SELECT RAISE(ABORT,'test audit failure'); END;`);
    try {
      await request(owner, `/tasks/${task.id}`, 500, 'PATCH', { version: 1, title: 'Must roll back', assignee_id: colleague.id });
    } finally { db.exec('DROP TRIGGER reject_test_task_audit'); }
    const unchanged = (await request<{ task: Task }>(owner, `/tasks/${task.id}`)).task;
    assert.equal(unchanged.title, task.title);
    assert.equal(unchanged.assignee_id, member.id);
    assert.equal(unchanged.version, 1);
    assert.equal(notificationCount(), notificationsBefore);
    assert.equal(auditCount(), auditsBefore);
  });

  await t.test('removed members lose all reads and mutations immediately; old assignees remain visible as former members', async () => {
    const task = await create(owner, privateProject, { assignee_id: colleague.id });
    run('DELETE FROM organization_members WHERE organization_id=? AND user_id=?', organizationId, colleague.id);
    assert.equal(canCollaborateProject(colleague.id, privateProject), false);
    assert.equal((await request<Projects>(colleague, '/projects')).total, 0);
    for (const project of [privateProject, publicProject]) {
      await request(colleague, `/projects/${project}`, 404);
      await request(colleague, `/projects/${project}/tasks`, 404, 'POST', { title: 'Removed member' });
    }
    await request(colleague, `/tasks/${task.id}`, 404);
    await request(colleague, `/tasks/${task.id}`, 404, 'PATCH', { version: 1, status: 'done' });
    await request(colleague, `/tasks/${task.id}?version=1`, 404, 'DELETE');
    const board = await request<Board>(owner, `/projects/${privateProject}`);
    assert.ok(!board.eligible_assignees.some((person) => person.id === colleague.id));
    const old = board.tasks.find((candidate) => candidate.id === task.id)!;
    assert.equal(old.assignee_id, colleague.id);
    assert.equal(old.assignee?.is_former_member, true);
    assert.equal(old.assignee?.name, 'Other member');
    await request(owner, `/tasks/${task.id}`, 400, 'PATCH', { version: 1, assignee_id: colleague.id });
    const preserved = await request<{ task: Task }>(owner, `/tasks/${task.id}`, 200, 'PATCH', { version: 1, title: 'Unrelated edit preserves former assignee' });
    assert.equal(preserved.task.assignee_id, colleague.id);
    assert.equal(preserved.task.assignee?.is_former_member, true);
    const removedAdmin = await create(admin, privateProject, { assignee_id: admin.id });
    run('DELETE FROM organization_members WHERE organization_id=? AND user_id=?', organizationId, admin.id);
    await request(admin, `/tasks/${removedAdmin.id}`, 404, 'PATCH', { version: 1, title: 'Old admin cannot edit' });
    await request(admin, `/tasks/${removedAdmin.id}?version=1`, 404, 'DELETE');
  });

  await t.test('projects paginate and search only collaboration projects, including direct links past page one', async () => {
    const ids = Array.from({ length: 107 }, (_, index) => project(`Paged ${String(index).padStart(3, '0')}`));
    const first = await request<Projects>(member, '/projects?q=Paged&limit=100');
    const second = await request<Projects>(member, '/projects?q=Paged&limit=100&offset=100');
    assert.equal(first.total, 107);
    assert.equal(first.projects.length, 100);
    assert.equal(second.projects.length, 7);
    assert.equal(new Set([...first.projects, ...second.projects].map((project) => project.id)).size, 107);
    const linked = second.projects[0].id;
    assert.ok(!first.projects.some((project) => project.id === linked));
    assert.equal((await request<Board>(member, `/projects/${linked}`)).project.id, linked);
    assert.equal((await request<Projects>(outsider, '/projects?q=Paged')).total, 0);
    const exact = await request<Projects>(owner, '/projects?q=Paged%20045');
    assert.equal(exact.projects[0].id, ids[45]);
    assert.equal(exact.total, 1);
    project('Literal 100%_match');
    assert.equal((await request<Projects>(owner, '/projects?q=%25_')).total, 1);
    assert.equal((await request<Projects>(owner, '/projects?q=Paged&offset=1000')).projects.length, 0);
  });

  await t.test('task pages and filters use SQL before pagination and completion totals stay truthful', async () => {
    const projectId = project('Large task board');
    const past = '2000-01-02T00:00:00.000Z';
    const future = '2099-01-02T00:00:00.000Z';
    for (let index = 0; index < 205; index++) {
      run(`INSERT INTO project_tasks(id,project_id,creator_id,assignee_id,title,status,priority,due_at)
        VALUES (?,?,?,?,?,?,?,?)`, `paged-task-${String(index).padStart(3, '0')}`, projectId, owner.id,
      index % 2 ? owner.id : member.id, `Task ${index}`, index < 50 ? 'done' : 'todo',
      index % 2 ? 'normal' : 'high', index < 100 ? past : index < 200 ? future : null);
    }
    const first = await request<Board>(member, `/projects/${projectId}`);
    const second = await request<Board>(member, `/projects/${projectId}?offset=100`);
    const third = await request<Board>(member, `/projects/${projectId}?offset=200`);
    assert.equal(first.tasks.length, 100);
    assert.equal(second.tasks.length, 100);
    assert.equal(third.tasks.length, 5);
    assert.equal(first.total, 205);
    assert.equal(new Set([...first.tasks, ...second.tasks, ...third.tasks].map((task) => task.id)).size, 205);
    assert.deepEqual(first.stats, { total: 205, done: 50, todo: 155, in_progress: 0 });
    const mine = await request<Board>(member, `/projects/${projectId}?assigned_to_me=true&limit=10&offset=100`);
    assert.equal(mine.total, 103);
    assert.equal(mine.tasks.length, 3);
    assert.ok(mine.tasks.every((task) => task.assignee_id === member.id));
    const overdue = await request<Board>(member, `/projects/${projectId}?priority=high&overdue=true`);
    assert.equal(overdue.total, 25);
    assert.ok(overdue.tasks.every((task) => task.status !== 'done' && task.priority === 'high' && task.due_at === past));
    assert.deepEqual(overdue.stats, first.stats);
    const due = await request<Board>(owner, `/projects/${projectId}?due_from=${encodeURIComponent(future)}&due_to=${encodeURIComponent(future)}`);
    assert.equal(due.total, 100);
    assert.ok(due.tasks.every((task) => task.due_at === future));
  });

  await t.test('query validation rejects coercion surprises, repeated values and unbounded requests', async () => {
    for (const query of [
      'limit=0', 'limit=101', 'limit=-1', 'limit=1.2', 'limit=1e2', 'limit=abc', 'limit=', 'limit=2&limit=3',
      'offset=-1', 'offset=1.5', 'offset=1000001', 'offset=', 'offset=9007199254740993', 'unknown=1',
    ]) {
      await request(owner, `/projects?${query}`, 400);
      await request(owner, `/projects/${privateProject}?${query}`, 400);
    }
    await request(owner, `/projects?q=${'a'.repeat(121)}`, 400);
    await request(owner, '/projects?q=a&q=b', 400);
    for (const query of [
      'priority=urgent', 'assigned_to_me=1', 'overdue=yes', 'due_from=invalid', 'due_to=2026-02-30T00:00:00Z',
      'due_from=2030-01-02T00:00:00Z&due_to=2030-01-01T00:00:00Z',
    ]) await request(owner, `/projects/${privateProject}?${query}`, 400);
  });
});
