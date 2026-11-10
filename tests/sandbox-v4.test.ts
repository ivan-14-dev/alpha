import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import test from 'node:test';

process.env.DATABASE_PATH = ':memory:';
const WORK_DIR = resolve(`data/sandbox-test-work-${process.pid}`);
process.env.ALPHA_SANDBOX_WORK_DIR = WORK_DIR;
const FILES_DIR = resolve(`data/sandbox-test-files-${process.pid}`);
process.env.FILES_DIR = FILES_DIR;
delete process.env.ALPHA_SANDBOX_IMAGE_ALLOWLIST;

const { app } = await import('../server/app.js');
const { all, one, run } = await import('../server/db.js');
const { runJob } = await import('../server/platform/jobs.js');
const { resetHits } = await import('../server/platform/rateLimit.js');
const { personalDataHandlers } = await import('../server/platform/privacy.js');
const { defaultConfig, saveConfig, validateConfig, isPinned, imageAllowed, sandboxConfig } = await import('../server/sandbox/config.js');
const { LogCollector, LOG_CAP_BYTES, sanitizeLog } = await import('../server/sandbox/logs.js');
const { safeBuildName, resolveCommand } = await import('../server/sandbox/runner.js');
const { dockerRunArgs, dockerRunner } = await import('../server/sandbox/docker.js');
const sandbox = await import('../server/sandbox/service.js');
type SandboxExecution = import('../server/sandbox/runner.js').SandboxExecution;
type SandboxIo = import('../server/sandbox/runner.js').SandboxIo;
type SandboxOutcome = import('../server/sandbox/runner.js').SandboxOutcome;
type SandboxRunner = import('../server/sandbox/runner.js').SandboxRunner;
type SandboxConfig = import('../server/sandbox/config.js').SandboxConfig;

interface Actor { id: string; name: string; email: string; cookie: string }
const WEB_HEADERS = { 'X-Alpha-Client': 'web', Origin: 'http://127.0.0.1:5173' };

type Behaviour = (job: SandboxExecution, io: SandboxIo) => Promise<SandboxOutcome>;

/** Deterministic in-process runner: no Docker involved. */
class FakeRunner implements SandboxRunner {
  readonly name = 'fake';
  executed: SandboxExecution[] = [];
  killed: string[] = [];
  leftovers: string[] = [];
  behaviour: Behaviour = async (_job, io) => { io.onOutput(Buffer.from('hello from fake\n')); return { exitCode: 0 }; };
  async check() { return { ok: true, version: 'fake-1' }; }
  async execute(job: SandboxExecution, io: SandboxIo) { this.executed.push(job); return this.behaviour(job, io); }
  async kill(name: string) { this.killed.push(name); }
  async removeLeftovers(keep: Set<string>) {
    const removed = this.leftovers.filter((name) => !keep.has(name));
    this.leftovers = this.leftovers.filter((name) => keep.has(name));
    return removed.length;
  }
}

/** Blocks until the run is aborted (cancel/timeout), like a container that never exits. */
const untilAborted: Behaviour = (_job, io) => new Promise((resolvePromise) => {
  io.onOutput(Buffer.from('started\n'));
  if (io.signal.aborted) resolvePromise({ exitCode: 137 });
  io.signal.addEventListener('abort', () => resolvePromise({ exitCode: 137 }), { once: true });
});

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const tick = (ms = 20) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

test('V4 sandbox module', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const fake = new FakeRunner();
  const builds = new Map<string, Buffer>();
  const artifacts: { runId: string; size: number }[] = [];
  const deletedArtifacts: string[] = [];
  const insertArtifact = (ownerId: string, runId: string, data: Buffer) => {
    const fileId = randomUUID();
    run(`INSERT INTO files(id,owner_id,purpose,original_name,mime_type,size_bytes,sha256,storage_key,scan_status,resource_type,resource_id)
      VALUES (?,?,'sandbox_artifact',?,'text/plain',?,?,?,'skipped','sandbox_run',?)`, fileId, ownerId, `sandbox-${runId}.log`, data.length, sha(data), `test/${fileId}`, runId);
    return fileId;
  };
  sandbox.setSandboxRunner(fake);
  sandbox.setSandboxStorage({
    async readBuild(file) {
      const data = builds.get(file.id);
      if (!data) throw new Error('missing build');
      return data;
    },
    async storeArtifact({ ownerId, runId, data }) {
      artifacts.push({ runId, size: data.length });
      return insertArtifact(ownerId, runId, data);
    },
    deleteArtifact(fileId) { deletedArtifacts.push(fileId); },
  });
  t.after(async () => {
    await sandbox.waitForSandboxIdle();
    sandbox.setSandboxRunner(null);
    sandbox.setSandboxStorage(null);
    rmSync(WORK_DIR, { recursive: true, force: true });
    rmSync(FILES_DIR, { recursive: true, force: true });
    await new Promise<void>((resolvePromise) => { server.close(() => resolvePromise()); server.closeAllConnections(); });
  });

  async function request<T = Record<string, unknown>>(actor: Actor | null, path: string, expected = 200, method = 'GET', body?: unknown) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(method === 'GET' ? {} : WEB_HEADERS),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(actor?.cookie ? { Cookie: actor.cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    assert.equal(response.status, expected, `${method} ${path}: ${text}`);
    const cookie = response.headers.get('set-cookie');
    if (actor && cookie) actor.cookie = cookie.split(';', 1)[0];
    const contentType = response.headers.get('content-type') ?? '';
    const data = (text && contentType.includes('json') ? JSON.parse(text) : text) as T;
    if (expected >= 400) assert.equal(typeof (data as { error?: unknown }).error, 'string', 'Errors must be actionable JSON');
    return data;
  }

  const actors: Record<string, Actor> = {};
  for (const name of ['Admin', 'Olivia', 'Tom', 'Paul', 'Carl', 'Oscar', 'Tina']) {
    const actor: Actor = { id: '', name, email: `${name.toLowerCase()}-sbx@example.test`, cookie: '' };
    const data = await request<{ user: { id: string } }>(actor, '/auth/register', 201, 'POST', {
      name, email: actor.email, password: 'Alpha-sandbox-password-2026!', accept_terms: true,
    });
    actor.id = data.user.id;
    actors[name] = actor;
  }
  const { Admin: admin, Olivia: owner, Tom: tester, Paul: applicant, Carl: cancelledTester, Oscar: outsider, Tina: otherTester } = actors;
  run("UPDATE users SET role='admin' WHERE id=?", admin.id);

  // Fixtures: a public and a private project, campaigns, applications/missions and campaign builds.
  run(`INSERT INTO projects(id,owner_id,title,summary,category,visibility) VALUES ('p-pub',?,'Projet public','Résumé','tech','public'),
    ('p-priv',?,'Projet privé','Résumé','tech','private'),('p-other',?,'Autre projet','Résumé','tech','public')`, owner.id, owner.id, admin.id);
  const campaign = (campaignId: string, projectId: string, ownerId: string) => run(`INSERT INTO campaigns(id,project_id,owner_id,title,description,reward_cents,slots,deadline)
    VALUES (?,?,?,?,'Description',1000,5,'2099-01-01')`, campaignId, projectId, ownerId, `Campagne ${campaignId}`);
  campaign('c-pub', 'p-pub', owner.id);
  campaign('c-priv', 'p-priv', owner.id);
  campaign('c-other', 'p-other', admin.id);
  const application = (applicationId: string, campaignId: string, testerId: string, status: string) =>
    run("INSERT INTO applications(id,campaign_id,tester_id,motivation,status) VALUES (?,?,?,'Motivé',?)", applicationId, campaignId, testerId, status);
  application('a-tom', 'c-pub', tester.id, 'accepted');
  application('a-tina', 'c-pub', otherTester.id, 'accepted');
  application('a-paul', 'c-pub', applicant.id, 'pending');
  application('a-carl', 'c-pub', cancelledTester.id, 'accepted');
  run("INSERT INTO missions(id,campaign_id,tester_id,application_id,status) VALUES ('m-tom','c-pub',?,'a-tom','in_progress')", tester.id);
  run("INSERT INTO missions(id,campaign_id,tester_id,application_id,status) VALUES ('m-carl','c-pub',?,'a-carl','cancelled')", cancelledTester.id);

  const addFile = (fileId: string, options: { campaignId?: string; purpose?: string; scan?: string; data?: Buffer; size?: number; name?: string; deleted?: boolean } = {}) => {
    const data = options.data ?? Buffer.from(`#!/bin/sh\necho build ${fileId}\n`);
    builds.set(fileId, data);
    run(`INSERT INTO files(id,owner_id,purpose,original_name,mime_type,size_bytes,sha256,storage_key,scan_status,resource_type,resource_id,deleted_at)
      VALUES (?,?,?,?,'application/octet-stream',?,?,?,?,'campaign',?,?)`, fileId, owner.id, options.purpose ?? 'campaign_build', options.name ?? `${fileId}.sh`,
    options.size ?? data.length, sha(data), `test/${fileId}`, options.scan ?? 'clean', options.campaignId ?? 'c-pub', options.deleted ? new Date().toISOString() : null);
  };
  addFile('f-build');
  addFile('f-skipped', { scan: 'skipped' });
  addFile('f-infected', { scan: 'infected' });
  addFile('f-pending', { scan: 'pending' });
  addFile('f-error', { scan: 'error' });
  addFile('f-other', { campaignId: 'c-other' });
  addFile('f-attachment', { purpose: 'mission_attachment' });
  addFile('f-deleted', { deleted: true });
  addFile('f-big', { size: 150 * 1024 * 1024 });
  addFile('f-priv', { campaignId: 'c-priv' });

  const configure = (patch: Partial<SandboxConfig> = {}) => saveConfig(validateConfig({ ...sandboxConfig(), ...patch }), admin.id);
  const resetQuota = () => {
    run('DELETE FROM sandbox_daily_usage');
    for (const actor of Object.values(actors)) resetHits(`sandbox.run:${actor.id}`);
  };
  const clearRuns = async () => {
    await sandbox.waitForSandboxIdle();
    run('DELETE FROM sandbox_runs');
    resetQuota();
  };
  const runRow = (runId: string) => sandbox.getRunRow(runId)!;
  const create = (actor: Actor, fileId = 'f-build', profileId = 'linux-shell', campaignId = 'c-pub') =>
    sandbox.createRun(actor.id, { campaign_id: campaignId, file_id: fileId, profile_id: profileId });
  const dispatchAndWait = async () => {
    const { claimed, executions } = sandbox.dispatchQueued();
    await Promise.all(executions);
    return claimed;
  };

  await t.test('the sandbox is disabled by default and refuses runs with 503', async () => {
    const status = await request<{ enabled: boolean; available: boolean; message: string }>(tester, '/sandbox/status');
    assert.equal(status.enabled, false);
    assert.equal(status.available, false);
    assert.match(status.message, /désactivé/);
    await request(tester, '/sandbox/runs', 503, 'POST', { campaign_id: 'c-pub', file_id: 'f-build', profile_id: 'linux-shell' });
    assert.equal(sandbox.dispatchQueued().claimed.length, 0);
    const profiles = await request<{ id: string; image: string }[]>(tester, '/sandbox/profiles');
    assert.deepEqual(profiles.map((profile) => profile.id), ['linux-shell', 'node', 'python', 'java']);
    assert.ok(profiles.every((profile) => isPinned(profile.image)));
    await request(null, '/sandbox/status', 401);
  });

  await t.test('admin configuration is validated: pinned allowlisted images, bounded limits, safe placeholders', async () => {
    await request(owner, '/sandbox/admin/config', 403);
    await request(owner, '/sandbox/admin/config', 403, 'PUT', defaultConfig);
    const current = await request<{ config: SandboxConfig; environment: { allowlist_locked: boolean } }>(admin, '/sandbox/admin/config');
    assert.equal(current.config.enabled, false);
    assert.equal(current.environment.allowlist_locked, false);
    const withProfile = (patch: Record<string, unknown>) => ({ ...defaultConfig, profiles: [{ ...defaultConfig.profiles[0], ...patch }] });
    const rejected: [unknown, RegExp][] = [
      [withProfile({ image: 'alpine' }), /épinglez/],
      [withProfile({ image: 'alpine:latest' }), /épinglez/],
      [withProfile({ image: 'evil/miner:1.0' }), /liste blanche/],
      [withProfile({ image: 'alpine:3.20; rm -rf /' }), /épinglez|invalide/],
      [withProfile({ memory_mb: 100000 }), /.+/],
      [withProfile({ timeout_s: 1 }), /.+/],
      [withProfile({ cpus: 64 }), /.+/],
      [withProfile({ pids: 1 }), /.+/],
      [withProfile({ command: ['sh', '-c', 'cat {input}'] }), /argument entier/],
      [withProfile({ command: ['{secret}'] }), /argument entier/],
      [withProfile({ command: ['{entry}'], entry_candidates: [] }), /point d’entrée/],
      [withProfile({ entry_candidates: ['../etc/passwd'] }), /.+/],
      [withProfile({ extra: true }), /.+/],
      [{ ...defaultConfig, profiles: [defaultConfig.profiles[0], defaultConfig.profiles[0]] }, /double/],
      [{ ...defaultConfig, max_concurrent: 0 }, /.+/],
      [{ ...defaultConfig, daily_quota: 0 }, /.+/],
      [{ ...defaultConfig, allowed_images: ['alpine:latest'] }, /liste blanche invalide/],
      [{ ...defaultConfig, allowed_images: ['alpine node'] }, /liste blanche invalide/],
      [{ ...defaultConfig, allowed_images: ['alpine:3.19', 'node', 'python', 'eclipse-temurin'] }, /alpine:3\.20.*liste blanche/],
      [{ ...defaultConfig, run_retention_days: 1, log_retention_days: 30 }, /conservation/],
      [{ ...defaultConfig, oci_runtime: 'runsc --privileged' }, /Runtime OCI/],
    ];
    for (const [body, message] of rejected) {
      const response = await request<{ error: string }>(admin, '/sandbox/admin/config', 400, 'PUT', body);
      assert.match(response.error, message, JSON.stringify(body).slice(0, 200));
    }
    const digest = `alpine@sha256:${'a'.repeat(64)}`;
    assert.ok(isPinned(digest) && imageAllowed(digest, ['alpine']));
    assert.ok(imageAllowed('ghcr.io/alpha/runner:1.2', ['ghcr.io/alpha/*']));
    assert.ok(!imageAllowed('ghcr.io/alphaevil/runner:1.2', ['ghcr.io/alpha/*']));
    assert.ok(!imageAllowed('docker.io/library/alpine:latest', ['alpine']));
    assert.ok(imageAllowed('docker.io/library/alpine:3.20', ['alpine']));
    assert.ok(imageAllowed('alpine:3.20', ['docker.io/library/alpine:3.20']));
    assert.ok(!imageAllowed('alpine:3.21', ['alpine:3.20']));
    assert.ok(imageAllowed(digest, [digest]) && !imageAllowed(`alpine@sha256:${'b'.repeat(64)}`, [digest]));
    assert.ok(!imageAllowed('alpine:3.20', ['alpine:latest']));

    process.env.ALPHA_SANDBOX_IMAGE_ALLOWLIST = 'alpine';
    try {
      const locked = await request<{ error: string }>(admin, '/sandbox/admin/config', 400, 'PUT', defaultConfig);
      assert.match(locked.error, /node:22-alpine.*liste blanche/);
      process.env.ALPHA_SANDBOX_IMAGE_ALLOWLIST = 'alpine:3.20, node:22-alpine,python:3.12-alpine,eclipse-temurin:21-jre-alpine,bad entry';
      await request(admin, '/sandbox/admin/config', 200, 'PUT', defaultConfig);
      const environment = await request<{ environment: { allowlist_locked: boolean; effective_allowlist: string[] } }>(admin, '/sandbox/admin/config', 200);
      assert.equal(environment.environment.allowlist_locked, true);
      assert.deepEqual(environment.environment.effective_allowlist, ['alpine:3.20', 'node:22-alpine', 'python:3.12-alpine', 'eclipse-temurin:21-jre-alpine']);
      const pinned = defaultConfig.profiles.map((profile) => profile.id === 'node' ? { ...profile, image: 'node:22.11-alpine' } : profile);
      assert.match((await request<{ error: string }>(admin, '/sandbox/admin/config', 400, 'PUT', { ...defaultConfig, profiles: pinned })).error, /node:22\.11-alpine.*liste blanche/);
    } finally { delete process.env.ALPHA_SANDBOX_IMAGE_ALLOWLIST; }

    const saved = await request<{ config: SandboxConfig }>(admin, '/sandbox/admin/config', 200, 'PUT', { ...defaultConfig, enabled: true });
    assert.equal(saved.config.enabled, true);
    assert.ok(one("SELECT 1 FROM audit_events WHERE actor_id=? AND action='sandbox.config_updated'", admin.id));
  });

  await t.test('authorization matrix and request validation for POST /runs', async () => {
    await clearRuns();
    configure({ enabled: true, max_pending_per_user: 20, daily_quota: 100 });
    const body = (patch: Record<string, unknown> = {}) => ({ campaign_id: 'c-pub', file_id: 'f-build', profile_id: 'linux-shell', ...patch });
    await request(null, '/sandbox/runs', 401, 'POST', body());
    const mine = await request<{ id: string; status: string; mission_id: string | null; viewer_role: string; logs?: string }>(owner, '/sandbox/runs', 202, 'POST', body());
    assert.equal(mine.status, 'queued');
    assert.equal(mine.mission_id, null);
    assert.equal(mine.logs, undefined);
    const tested = await request<{ id: string; mission_id: string | null; container_name?: string }>(tester, '/sandbox/runs', 202, 'POST', body());
    assert.equal(tested.mission_id, 'm-tom');
    assert.equal(tested.container_name, undefined, 'container names are only shown to admins');
    await request(otherTester, '/sandbox/runs', 202, 'POST', body());
    await request(applicant, '/sandbox/runs', 403, 'POST', body());
    await request(cancelledTester, '/sandbox/runs', 403, 'POST', body());
    await request(outsider, '/sandbox/runs', 403, 'POST', body());
    await request(outsider, '/sandbox/runs', 404, 'POST', body({ campaign_id: 'c-priv', file_id: 'f-priv' }));
    await request(admin, '/sandbox/runs', 403, 'POST', body());
    await request(tester, '/sandbox/runs', 404, 'POST', body({ campaign_id: 'missing' }));
    await request(tester, '/sandbox/runs', 404, 'POST', body({ file_id: 'f-other' }));
    await request(tester, '/sandbox/runs', 404, 'POST', body({ file_id: 'f-attachment' }));
    await request(tester, '/sandbox/runs', 404, 'POST', body({ file_id: 'f-deleted' }));
    await request(tester, '/sandbox/runs', 404, 'POST', body({ file_id: 'missing' }));
    await request(tester, '/sandbox/runs', 409, 'POST', body({ file_id: 'f-infected' }));
    await request(tester, '/sandbox/runs', 409, 'POST', body({ file_id: 'f-pending' }));
    await request(tester, '/sandbox/runs', 409, 'POST', body({ file_id: 'f-error' }));
    await request(tester, '/sandbox/runs', 413, 'POST', body({ file_id: 'f-big' }));
    await request(tester, '/sandbox/runs', 404, 'POST', body({ profile_id: 'unknown' }));
    await request(tester, '/sandbox/runs', 400, 'POST', { campaign_id: 'c-pub', file_id: 'f-build' });
    await request(tester, '/sandbox/runs', 400, 'POST', body({ image: 'evil:1' }));
    await request(tester, '/sandbox/runs', 400, 'POST', body({ campaign_id: 42 }));
    await request(tester, '/sandbox/runs', 202, 'POST', body({ file_id: 'f-skipped' }));
    configure({ require_clean_scan: true });
    await request(tester, '/sandbox/runs', 409, 'POST', body({ file_id: 'f-skipped' }));
    configure({ require_clean_scan: false, profiles: defaultConfig.profiles.map((profile) => ({ ...profile, enabled: profile.id !== 'python' })) });
    await request(tester, '/sandbox/runs', 404, 'POST', body({ profile_id: 'python' }));
    const profiles = await request<{ id: string }[]>(tester, '/sandbox/profiles');
    assert.ok(!profiles.some((profile) => profile.id === 'python'));
    configure({ profiles: defaultConfig.profiles });
    assert.ok(one("SELECT 1 FROM audit_events WHERE actor_id=? AND action='sandbox.run_requested'", tester.id));

    // Read access: requester, campaign owner and admins only; others get 404 (no existence leak).
    await request(tester, `/sandbox/runs/${tested.id}`);
    await request(owner, `/sandbox/runs/${tested.id}`);
    const asAdmin = await request<{ container_name: string }>(admin, `/sandbox/runs/${tested.id}`);
    assert.equal(asAdmin.container_name, `alpha-sbx-${tested.id}`);
    await request(otherTester, `/sandbox/runs/${tested.id}`, 404);
    await request(outsider, `/sandbox/runs/${tested.id}`, 404);
    await request(outsider, `/sandbox/runs/${tested.id}/logs`, 404);
    await request(outsider, `/sandbox/runs/${tested.id}/cancel`, 404, 'POST', {});
    await request(otherTester, `/sandbox/runs/${mine.id}`, 404);
    assert.ok(sandbox.canReadSandboxRun(owner.id, tested.id));
    assert.ok(sandbox.canReadSandboxRun(admin.id, tested.id));
    assert.ok(!sandbox.canReadSandboxRun(outsider.id, tested.id));

    const ownerList = await request<{ requester_id: string; viewer_role: string }[]>(owner, '/sandbox/runs?campaign_id=c-pub');
    assert.ok(ownerList.some((item) => item.requester_id === tester.id && item.viewer_role === 'owner'));
    const testerList = await request<{ requester_id: string }[]>(tester, '/sandbox/runs');
    assert.ok(testerList.length > 0 && testerList.every((item) => item.requester_id === tester.id));
    assert.deepEqual(await request(outsider, '/sandbox/runs'), []);
    await request(tester, '/sandbox/runs?status=bogus', 400);

    const campaigns = await request<{ id: string; role: string }[]>(tester, '/sandbox/campaigns');
    assert.deepEqual(campaigns.map((item) => [item.id, item.role]), [['c-pub', 'tester']]);
    assert.deepEqual((await request<{ id: string }[]>(cancelledTester, '/sandbox/campaigns')).length, 0);
    const ownerCampaigns = await request<{ id: string; role: string }[]>(owner, '/sandbox/campaigns');
    assert.deepEqual(ownerCampaigns.map((item) => item.id).sort(), ['c-priv', 'c-pub']);
    const buildList = await request<{ id: string; eligible: boolean; reason: string | null }[]>(tester, '/sandbox/campaigns/c-pub/builds');
    assert.ok(buildList.find((item) => item.id === 'f-build')?.eligible);
    assert.equal(buildList.find((item) => item.id === 'f-infected')?.eligible, false);
    assert.ok(!buildList.some((item) => item.id === 'f-attachment' || item.id === 'f-deleted'));
    await request(outsider, '/sandbox/campaigns/c-pub/builds', 404);
    await request(applicant, '/sandbox/campaigns/c-pub/builds', 404);
  });

  await t.test('quotas: pending runs per user and daily quota (cancelled queued runs are refunded)', async () => {
    await clearRuns();
    configure({ max_pending_per_user: 2, daily_quota: 100 });
    create(tester);
    const second = create(tester);
    assert.throws(() => create(tester), (error: { status?: number; message: string }) => error.status === 429 && /en attente/.test(error.message));
    await sandbox.cancelRun({ id: tester.id, role: 'member' }, second.id);
    create(tester);

    await clearRuns();
    configure({ max_pending_per_user: 10, daily_quota: 2 });
    const first = create(tester);
    create(tester);
    const response = await request<{ error: string }>(tester, '/sandbox/runs', 429, 'POST', { campaign_id: 'c-pub', file_id: 'f-build', profile_id: 'linux-shell' });
    assert.match(response.error, /Quota quotidien/);
    const cancelled = await request<{ status: string }>(tester, `/sandbox/runs/${first.id}/cancel`, 200, 'POST', {});
    assert.equal(cancelled.status, 'cancelled');
    create(tester);
    assert.throws(() => create(tester), (error: { status?: number }) => error.status === 429);
    await request(tester, `/sandbox/runs/${first.id}/cancel`, 409, 'POST', {});
    const status = await request<{ used_today: number; pending: number }>(tester, '/sandbox/status');
    assert.equal(status.used_today, 2);
    assert.equal(status.pending, 2);
    configure({ max_pending_per_user: 3, daily_quota: 20 });
  });

  await t.test('the dispatcher claims atomically up to max_concurrent and keeps the rest queued', async () => {
    await clearRuns();
    configure({ max_concurrent: 2, max_pending_per_user: 10 });
    const gates: (() => void)[] = [];
    fake.behaviour = (_job, io) => new Promise((resolvePromise) => {
      gates.push(() => resolvePromise({ exitCode: 0 }));
      io.signal.addEventListener('abort', () => resolvePromise({ exitCode: 137 }), { once: true });
    });
    const runs = [create(tester)];
    await tick(5);
    runs.push(create(owner));
    await tick(5);
    runs.push(create(otherTester));
    const firstWave = sandbox.dispatchQueued();
    const secondWave = sandbox.dispatchQueued();
    assert.equal(firstWave.claimed.length, 2);
    assert.equal(secondWave.claimed.length, 0, 'no slot left: nothing more is claimed');
    assert.deepEqual(firstWave.claimed, runs.slice(0, 2).map((item) => item.id), 'FIFO order');
    assert.equal(one<{ n: number }>("SELECT COUNT(*) AS n FROM sandbox_runs WHERE status='running'")!.n, 2);
    assert.equal(runRow(runs[2].id).status, 'queued');
    await tick();
    assert.equal(gates.length, 2);
    gates.shift()!();
    await Promise.race(firstWave.executions);
    assert.equal(one<{ n: number }>("SELECT COUNT(*) AS n FROM sandbox_runs WHERE status='succeeded'")!.n, 1);
    const thirdWave = sandbox.dispatchQueued();
    assert.deepEqual(thirdWave.claimed, [runs[2].id]);
    await tick();
    while (gates.length) gates.shift()!();
    await Promise.all([...firstWave.executions, ...thirdWave.executions]);
    assert.ok(runs.every((item) => runRow(item.id).status === 'succeeded'));
  });

  await t.test('disabled sandbox never dispatches queued runs', async () => {
    configure({ enabled: true });
    await clearRuns();
    const queued = create(tester);
    configure({ enabled: false });
    assert.equal(sandbox.dispatchQueued().claimed.length, 0);
    assert.equal(runRow(queued.id).status, 'queued');
    await request(tester, '/sandbox/runs', 503, 'POST', { campaign_id: 'c-pub', file_id: 'f-build', profile_id: 'linux-shell' });
    configure({ enabled: true });
  });

  await t.test('fake runner: success, failure, OOM-like kill, engine error and setup failures', async () => {
    await clearRuns();
    configure({ max_concurrent: 5, max_pending_per_user: 10 });
    fake.behaviour = async (job, io) => {
      io.onOutput(Buffer.from(`\x1b[32mrunning ${job.command.join(' ')}\x1b[0m\r\n`));
      return { exitCode: 0 };
    };
    const ok = create(tester);
    await dispatchAndWait();
    const succeeded = runRow(ok.id);
    assert.equal(succeeded.status, 'succeeded');
    assert.equal(succeeded.exit_code, 0);
    assert.ok(succeeded.finished_at && succeeded.started_at && succeeded.duration_ms !== null);
    assert.match(succeeded.logs, /running \{entry\}\n/);
    assert.ok(!succeeded.logs.includes('\x1b'), 'ANSI escapes are stripped');
    const job = fake.executed.at(-1)!;
    assert.equal(job.containerName, `alpha-sbx-${ok.id}`);
    assert.equal(job.image, 'alpine:3.20');
    assert.equal(job.input.name, 'f-build.sh');
    assert.deepEqual(job.input.data, builds.get('f-build'));
    assert.equal(job.limits.memory_mb, 256);
    assert.ok(one("SELECT 1 FROM notifications WHERE user_id=? AND kind='sandbox.run' AND link=?", tester.id, `/sandbox/${ok.id}`));
    const detail = await request<{ logs: string; can_cancel: boolean; command: string[]; limits: { timeout_s: number }; isolation: { network: string } }>(tester, `/sandbox/runs/${ok.id}`);
    assert.equal(detail.can_cancel, false);
    assert.deepEqual(detail.command, ['{entry}']);
    assert.equal(detail.limits.timeout_s, 60);
    assert.equal(detail.isolation.network, 'none');
    const text = await request<string>(tester, `/sandbox/runs/${ok.id}/logs`);
    assert.match(text, /running/);
    assert.ok(sandbox.usageToday(tester.id).duration_ms >= 0);

    const outcomes: [SandboxOutcome, string, RegExp][] = [
      [{ exitCode: 3 }, 'failed', /code 3/],
      [{ exitCode: 137 }, 'failed', /mémoire/],
      [{ exitCode: 121 }, 'failed', /Préparation/],
      [{ exitCode: 127 }, 'failed', /introuvable/],
      [{ exitCode: 125 }, 'error', /moteur/],
      [{ exitCode: null, error: 'Démon Docker injoignable.' }, 'error', /injoignable/],
    ];
    for (const [outcome, status, message] of outcomes) {
      resetQuota();
      fake.behaviour = async () => outcome;
      const item = create(tester);
      await dispatchAndWait();
      const row = runRow(item.id);
      assert.equal(row.status, status, JSON.stringify(outcome));
      assert.match(row.error, message);
      if (status === 'error') assert.equal(sandbox.usageToday(tester.id).runs, 0, 'platform errors are refunded');
      else assert.equal(sandbox.usageToday(tester.id).runs, 1);
    }

    fake.behaviour = async () => { throw new Error('boom'); };
    const crashed = create(tester);
    await dispatchAndWait();
    assert.equal(runRow(crashed.id).status, 'error');
    assert.equal(runRow(crashed.id).error, 'Erreur interne du bac à sable.');

    // Integrity and late checks happen again at execution time.
    fake.behaviour = async () => ({ exitCode: 0 });
    const tampered = create(tester);
    builds.set('f-build', Buffer.from('tampered'));
    await dispatchAndWait();
    assert.equal(runRow(tampered.id).status, 'error');
    assert.match(runRow(tampered.id).error, /SHA-256/);
    builds.set('f-build', Buffer.from('#!/bin/sh\necho build f-build\n'));
    const infectedLater = create(tester, 'f-skipped');
    run("UPDATE files SET scan_status='infected' WHERE id='f-skipped'");
    await dispatchAndWait();
    assert.match(runRow(infectedLater.id).error, /antivirus/);
    run("UPDATE files SET scan_status='skipped' WHERE id='f-skipped'");
  });

  await t.test('timeouts kill the run and cancellations stop it (requester, owner, admin)', async () => {
    await clearRuns();
    fake.behaviour = untilAborted;
    const slow = create(tester);
    run("UPDATE sandbox_runs SET limits=json_set(limits,'$.timeout_s',0.2) WHERE id=?", slow.id);
    await dispatchAndWait();
    const timedOut = runRow(slow.id);
    assert.equal(timedOut.status, 'timeout');
    assert.match(timedOut.error, /Durée maximale/);
    assert.match(timedOut.logs, /Délai de 0.2 s dépassé/);

    const byRequester = create(tester);
    const execution = sandbox.dispatchQueued();
    await tick();
    assert.equal(runRow(byRequester.id).status, 'running');
    const live = await request<{ status: string; logs: string; can_cancel: boolean }>(tester, `/sandbox/runs/${byRequester.id}`);
    assert.equal(live.status, 'running');
    assert.equal(live.can_cancel, true);
    const notificationsBefore = all('SELECT id FROM notifications WHERE user_id=?', tester.id).length;
    const cancelled = await request<{ status: string; error: string }>(tester, `/sandbox/runs/${byRequester.id}/cancel`, 200, 'POST', {});
    await Promise.all(execution.executions);
    assert.equal(cancelled.status, 'cancelled');
    assert.match(cancelled.error, /demandeur/);
    assert.equal(all('SELECT id FROM notifications WHERE user_id=?', tester.id).length, notificationsBefore, 'no notification for a self-cancel');

    const byOwner = create(tester);
    const second = sandbox.dispatchQueued();
    await tick();
    const ownerCancel = await request<{ status: string; error: string }>(owner, `/sandbox/runs/${byOwner.id}/cancel`, 200, 'POST', {});
    await Promise.all(second.executions);
    assert.equal(ownerCancel.status, 'cancelled');
    assert.match(ownerCancel.error, /propriétaire/);
    assert.ok(one("SELECT 1 FROM notifications WHERE user_id=? AND link=? AND title LIKE '%annulée%'", tester.id, `/sandbox/${byOwner.id}`));

    const byAdmin = create(tester);
    const third = sandbox.dispatchQueued();
    await tick();
    await request(owner, `/sandbox/admin/runs/${byAdmin.id}/kill`, 403, 'POST', {});
    const killed = await request<{ status: string; error: string }>(admin, `/sandbox/admin/runs/${byAdmin.id}/kill`, 200, 'POST', {});
    await Promise.all(third.executions);
    assert.equal(killed.status, 'cancelled');
    assert.match(killed.error, /administration/);
    assert.ok(one("SELECT 1 FROM audit_events WHERE actor_id=? AND action='sandbox.run_cancelled' AND target_id=?", admin.id, byAdmin.id));
    const adminRuns = await request<{ runs: { id: string; container_name: string }[]; stats: { running: number } }>(admin, '/sandbox/admin/runs?status=cancelled');
    assert.ok(adminRuns.runs.some((item) => item.id === byAdmin.id && item.container_name === `alpha-sbx-${byAdmin.id}`));
    await request(owner, '/sandbox/admin/runs', 403);
    await request(admin, `/sandbox/admin/runs/${byAdmin.id}/kill`, 409, 'POST', {});
    assert.throws(() => run("UPDATE sandbox_runs SET status='running' WHERE id=?", byAdmin.id), /already finished/);
  });

  await t.test('logs are capped (head + tail), sanitised, and the longer copy is stored as an artifact', async () => {
    await clearRuns();
    fake.behaviour = async (_job, io) => {
      io.onOutput(Buffer.from('BEGIN-MARKER\n'));
      const line = Buffer.from(`${'x'.repeat(1023)}\n`);
      for (let index = 0; index < 1024; index += 1) io.onOutput(line);
      io.onOutput(Buffer.from('\x00\x07END-MARKER\n'));
      return { exitCode: 1 };
    };
    const noisy = create(tester);
    await dispatchAndWait();
    const row = runRow(noisy.id);
    assert.equal(row.status, 'failed');
    assert.ok(row.logs.length <= LOG_CAP_BYTES, `log length ${row.logs.length}`);
    assert.equal(row.logs_truncated, 1);
    assert.match(row.logs, /BEGIN-MARKER/);
    assert.match(row.logs, /END-MARKER\n/);
    assert.match(row.logs, /octets omis/);
    assert.ok(!row.logs.includes('\x00') && !row.logs.includes('\x07'));
    assert.ok(row.artifact_file_id, 'full log stored through the files module');
    assert.ok(artifacts.some((item) => item.runId === noisy.id && item.size > LOG_CAP_BYTES));

    const collector = new LogCollector(1000);
    for (let index = 0; index < 500; index += 1) collector.push(Buffer.from(`line ${index}\n`));
    assert.ok(collector.text().length <= 1000);
    assert.ok(collector.truncated);
    assert.match(collector.text(), /^line 0\n/);
    assert.match(collector.text(), /line 499\n$/);
    assert.equal(sanitizeLog('a\r\nb\x1b[1mc\x1b[0m', ['secret-value']), 'a\nbc');
    assert.equal(sanitizeLog('path /srv/work/run', ['/srv/work']), 'path [masqué]/run');
  });

  await t.test('startup recovery fails orphaned running runs and removes leftover containers', async () => {
    await clearRuns();
    const orphan = create(tester);
    run("UPDATE sandbox_runs SET status='running',started_at=? WHERE id=?", new Date().toISOString(), orphan.id);
    fake.leftovers = [`alpha-sbx-${orphan.id}`, 'alpha-sbx-ghost'];
    const before = sandbox.usageToday(tester.id).runs;
    const result = await sandbox.recoverSandbox();
    assert.deepEqual(result, { recovered: 1, removed: 2 });
    const row = runRow(orphan.id);
    assert.equal(row.status, 'error');
    assert.match(row.error, /redémarrage/);
    assert.equal(sandbox.usageToday(tester.id).runs, before - 1);
    assert.ok(one("SELECT 1 FROM notifications WHERE user_id=? AND link=?", tester.id, `/sandbox/${orphan.id}`));
    assert.deepEqual(fake.leftovers, []);

    // The scheduled job recovers once, then dispatches.
    fake.behaviour = async () => ({ exitCode: 0 });
    const queued = create(tester);
    await runJob('sandbox.dispatch');
    await sandbox.waitForSandboxIdle();
    assert.equal(runRow(queued.id).status, 'succeeded');
  });

  await t.test('cleanup job applies retention and expires stale queued runs', async () => {
    await clearRuns();
    fake.behaviour = async (_job, io) => { io.onOutput(Buffer.from('old output\n')); return { exitCode: 0 }; };
    const old = create(tester);
    const ancient = create(owner);
    await dispatchAndWait();
    const stale = create(otherTester);
    const day = 86400000;
    run('UPDATE sandbox_runs SET finished_at=? WHERE id=?', new Date(Date.now() - 40 * day).toISOString(), old.id);
    run('UPDATE sandbox_runs SET finished_at=? WHERE id=?', new Date(Date.now() - 400 * day).toISOString(), ancient.id);
    run('UPDATE sandbox_runs SET queued_at=? WHERE id=?', new Date(Date.now() - 2 * day).toISOString(), stale.id);
    const oldArtifact = insertArtifact(tester.id, old.id, Buffer.from('long log'));
    const ancientArtifact = insertArtifact(owner.id, ancient.id, Buffer.from('long log'));
    run('UPDATE sandbox_runs SET artifact_file_id=? WHERE id=?', oldArtifact, old.id);
    run('UPDATE sandbox_runs SET artifact_file_id=? WHERE id=?', ancientArtifact, ancient.id);
    const result = await sandbox.cleanupSandbox();
    assert.equal(result.pruned >= 1, true);
    assert.equal(result.deleted, 1);
    assert.equal(result.expired, 1);
    assert.equal(result.artifacts, 2, 'the long log copy follows log retention');
    assert.ok(deletedArtifacts.includes(oldArtifact) && deletedArtifacts.includes(ancientArtifact));
    assert.equal(runRow(old.id).artifact_file_id, null);
    assert.equal(runRow(old.id).logs, '');
    assert.ok(runRow(old.id).logs_pruned_at);
    assert.equal(sandbox.getRunRow(ancient.id), null);
    assert.equal(runRow(stale.id).status, 'cancelled');
    assert.match(runRow(stale.id).error, /Expirée/);
    const pruned = await request<{ logs_pruned_at: string | null; logs: string }>(tester, `/sandbox/runs/${old.id}`);
    assert.ok(pruned.logs_pruned_at);
    assert.ok(await runJob('sandbox.cleanup'));
  });

  await t.test('admin self-test reports isolation checks; admin endpoints are admin-only', async () => {
    fake.behaviour = async (job, io) => {
      assert.match(job.containerName, /^alpha-sbx-selftest-/);
      io.onOutput(Buffer.from('uid=65534 gid=65534\nrootfs=read-only\ninterfaces=lo \nnetwork=isolated\nalpha-sandbox-selftest-ok\n'));
      return { exitCode: 0 };
    };
    await request(owner, '/sandbox/admin/test', 403, 'POST', {});
    const result = await request<{ ok: boolean; checks: Record<string, boolean>; check: { version: string } }>(admin, '/sandbox/admin/test', 200, 'POST', { profile_id: 'linux-shell' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.checks, { non_root: true, read_only_root: true, network_isolated: true, completed: true });
    assert.equal(result.check.version, 'fake-1');
    fake.behaviour = async (_job, io) => { io.onOutput(Buffer.from('uid=0 gid=0\nrootfs=writable\ninterfaces=eth0 lo \nnetwork=reachable\nalpha-sandbox-selftest-ok\n')); return { exitCode: 0 }; };
    const unsafe = await request<{ ok: boolean; checks: Record<string, boolean> }>(admin, '/sandbox/admin/test', 200, 'POST', {});
    assert.equal(unsafe.ok, false);
    assert.deepEqual(unsafe.checks, { non_root: false, read_only_root: false, network_isolated: false, completed: true });
    assert.ok(one("SELECT 1 FROM audit_events WHERE actor_id=? AND action='sandbox.self_test'", admin.id));
    await request(admin, '/sandbox/admin/pull', 409, 'POST', { profile_id: 'linux-shell' });
    await request(admin, '/sandbox/admin/pull', 404, 'POST', { profile_id: 'nope' });
    await request(owner, '/sandbox/admin/pull', 403, 'POST', { profile_id: 'linux-shell' });
  });

  await t.test('personal data: export lists the runs, erase removes them and aborts running ones', async () => {
    await clearRuns();
    fake.behaviour = async () => ({ exitCode: 0 });
    const done = create(tester);
    await dispatchAndWait();
    fake.behaviour = untilAborted;
    const running = create(tester);
    const execution = sandbox.dispatchQueued();
    await tick();
    const handler = personalDataHandlers().find(([name]) => name === 'sandbox')?.[1];
    assert.ok(handler);
    const exported = handler.export(tester.id) as { runs: { id: string }[]; daily_usage: unknown[] };
    assert.deepEqual(exported.runs.map((item) => item.id).sort(), [done.id, running.id].sort());
    assert.ok(exported.daily_usage.length > 0);
    assert.ok(!JSON.stringify(exported).includes('"logs"'));
    const doneArtifact = insertArtifact(tester.id, done.id, Buffer.from('long log'));
    run('UPDATE sandbox_runs SET artifact_file_id=? WHERE id=?', doneArtifact, done.id);
    const { transaction } = await import('../server/db.js');
    transaction(() => handler.erase(tester.id));
    assert.ok(deletedArtifacts.includes(doneArtifact), 'erasure retires the artifact too');
    await Promise.all(execution.executions);
    assert.equal(sandbox.getRunRow(done.id), null);
    assert.equal(sandbox.getRunRow(running.id), null);
    assert.equal(sandbox.usageToday(tester.id).runs, 0);
    assert.equal(sandbox.activeRunIds().length, 0);
  });

  await t.test('docker argv: every isolation flag is present and the command is never a shell string', () => {
    const name = safeBuildName('a b$(x).sh');
    const job: SandboxExecution = {
      runId: 'run-1', containerName: 'alpha-sbx-run-1', image: 'alpine:3.20', command: resolveCommand(['{entry}', '{input}', '{app}'], name),
      input: { name, data: Buffer.from('x') }, extract: true, entryCandidates: ['run.sh'],
      limits: { timeout_s: 60, memory_mb: 256, cpus: 0.5, pids: 64, tmpfs_mb: 128 }, ociRuntime: 'runsc', inputMode: 'bind',
    };
    assert.equal(job.input.name, 'a_b_x_.sh');
    assert.equal(safeBuildName('../../etc/passwd'), 'etc_passwd');
    assert.equal(safeBuildName('.hidden'), 'hidden');
    const args = dockerRunArgs(job, 'bind', { inputDir: '/srv/in', entryScript: '/srv/entry.sh' });
    const joined = args.join(' ');
    for (const flag of ['--rm', '--network none', '--read-only', '--cap-drop ALL', '--security-opt no-new-privileges', '--pids-limit 64',
      '--memory 256m', '--memory-swap 256m', '--cpus 0.50', '--user 65534:65534', '--ulimit nofile=256:256', '--pull never', '--runtime runsc',
      '--label alpha.sandbox=1', '--volume /srv/in:/input:ro', '--volume /srv/entry.sh:/sandbox/entry.sh:ro', '--init']) {
      assert.ok(joined.includes(flag), `missing ${flag}`);
    }
    assert.ok(args.some((value) => value.startsWith('/work:rw,exec,nosuid,nodev,size=128m')));
    assert.ok(args.some((value) => value.startsWith('/tmp:rw,noexec,nosuid,nodev,size=32m')));
    assert.ok(!args.includes('--privileged') && !joined.includes('docker.sock'));
    assert.deepEqual(args.slice(-5), ['alpine:3.20', '/sandbox/entry.sh', '{entry}', '/work/build/a_b_x_.sh', '/work/app']);
    const stdinArgs = dockerRunArgs({ ...job, ociRuntime: null }, 'stdin', { entrySource: 'echo entry' });
    assert.ok(stdinArgs.includes('--interactive') && !stdinArgs.includes('--volume') && !stdinArgs.includes('--runtime'));
    assert.deepEqual(stdinArgs.slice(-7), ['alpine:3.20', '-c', 'echo entry', 'alpha-entry', '{entry}', '/work/build/a_b_x_.sh', '/work/app']);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Real Docker isolation tests (skipped automatically when no Docker daemon is reachable)
// ---------------------------------------------------------------------------------------------------------------------

const IMAGE = 'alpine:3.20';
function dockerAvailable(): string | null {
  const info = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 15000, encoding: 'utf8' });
  if (info.status !== 0) return 'Docker indisponible';
  if (spawnSync('docker', ['image', 'inspect', IMAGE], { timeout: 15000 }).status === 0) return null;
  return spawnSync('docker', ['pull', IMAGE], { timeout: 180000 }).status === 0 ? null : `image ${IMAGE} indisponible`;
}
const dockerSkip = dockerAvailable();

test('real Docker sandbox isolation', { skip: dockerSkip ?? false, timeout: 240000 }, async (t) => {
  t.after(() => { rmSync(WORK_DIR, { recursive: true, force: true }); rmSync(FILES_DIR, { recursive: true, force: true }); });
  const execute = async (script: string, options: { inputMode?: 'bind' | 'stdin'; memory_mb?: number; abortAfterMs?: number; name?: string } = {}) => {
    const runId = `test-${randomUUID().slice(0, 12)}`;
    const name = options.name ?? 'probe.sh';
    let output = '';
    const controller = new AbortController();
    const timer = options.abortAfterMs ? setTimeout(() => controller.abort('timeout'), options.abortAfterMs) : undefined;
    const started = Date.now();
    const outcome = await dockerRunner.execute({
      runId, containerName: `alpha-sbx-${runId}`, image: IMAGE, command: ['{entry}'], input: { name, data: Buffer.from(script) },
      extract: false, entryCandidates: [], limits: { timeout_s: 30, memory_mb: options.memory_mb ?? 128, cpus: 0.5, pids: 64, tmpfs_mb: 64 },
      ociRuntime: null, inputMode: options.inputMode ?? 'bind',
    }, { onOutput: (chunk) => { output += chunk.toString('utf8'); }, signal: controller.signal });
    clearTimeout(timer);
    const leftover = spawnSync('docker', ['ps', '-a', '--filter', `name=alpha-sbx-${runId}`, '--format', '{{.Names}}'], { encoding: 'utf8' }).stdout.trim();
    return { outcome, output, elapsed: Date.now() - started, leftover };
  };
  const probe = [
    'echo "uid=$(id -u)"',
    'if touch /etc/alpha-probe 2>/dev/null; then echo rootfs=writable; else echo rootfs=read-only; fi',
    'if wget -q -T 3 -O /dev/null http://1.1.1.1/ 2>/dev/null; then echo network=reachable; else echo network=isolated; fi',
    'if nc -w 3 1.1.1.1 53 </dev/null 2>/dev/null; then echo tcp=reachable; else echo tcp=isolated; fi',
    'echo "interfaces=$(ls /sys/class/net | tr "\\n" " ")"',
    'if touch /work/ok && touch /tmp/ok; then echo scratch=writable; fi',
    'cp /bin/busybox /tmp/bb 2>/dev/null && /tmp/bb true 2>/dev/null && echo tmp=exec || echo tmp=noexec',
    'echo "caps=$(grep CapEff /proc/self/status | tr -d "\\t")"',
  ].join('\n');

  for (const inputMode of ['bind', 'stdin'] as const) {
    await t.test(`network isolation, read-only root, non-root uid (${inputMode})`, async () => {
      const { outcome, output, leftover } = await execute(probe, { inputMode });
      assert.equal(outcome.exitCode, 0, output);
      assert.match(output, /^uid=65534$/m);
      assert.match(output, /^rootfs=read-only$/m);
      assert.match(output, /^network=isolated$/m);
      assert.match(output, /^tcp=isolated$/m);
      assert.match(output, /^interfaces=lo $/m);
      assert.match(output, /^scratch=writable$/m);
      assert.match(output, /^tmp=noexec$/m);
      assert.match(output, /^caps=CapEff:0000000000000000$/m);
      assert.equal(leftover, '', 'container removed (--rm)');
    });
  }

  await t.test('timeout kills the container promptly', async () => {
    const { outcome, elapsed, leftover } = await execute('echo start\nsleep 60\necho never', { abortAfterMs: 1500 });
    assert.notEqual(outcome.exitCode, 0);
    assert.ok(elapsed < 20000, `killed after ${elapsed} ms`);
    assert.equal(leftover, '');
  });

  await t.test('memory limit: allocations beyond the cgroup limit are OOM-killed', async () => {
    const { outcome, output } = await execute('head -c 300000000 /dev/zero | tail > /dev/null\necho "status=$?"', { memory_mb: 64 });
    assert.equal(outcome.exitCode, 0, output);
    assert.match(output, /^status=137$/m);
  });

  await t.test('pids limit stops fork bombs', async () => {
    const { outcome, output } = await execute('echo "pids.max=$(cat /sys/fs/cgroup/pids.max)"\n(i=0; while [ $i -lt 200 ]; do sleep 3 & i=$((i+1)); done; echo "forked=$i") 2>/dev/null\necho "subshell=$?"');
    assert.equal(outcome.exitCode, 0, output);
    assert.match(output, /^pids.max=64$/m);
    assert.match(output, /^subshell=[1-9]/m);
    assert.ok(!output.includes('forked=200'));
  });

  await t.test('end-to-end through the service with the real runner and the files module storage', async () => {
    const files = await import('../server/files/service.js');
    const admin = one<{ id: string }>("SELECT id FROM users WHERE role='admin' LIMIT 1");
    if (!admin) return;
    const owner = one<{ owner_id: string }>("SELECT owner_id FROM campaigns WHERE id='c-pub'")!.owner_id;
    sandbox.setSandboxRunner(dockerRunner);
    sandbox.setSandboxStorage(null);
    const script = '#!/bin/sh\necho "e2e uid=$(id -u)"\ni=0\nwhile [ $i -lt 6000 ]; do echo "ligne $i ..................................................."; i=$((i+1)); done\necho FIN\nexit 3\n';
    const build = await files.storeBuffer({ ownerId: owner, purpose: 'campaign_build', name: 'e2e.sh', mimeType: 'text/x-shellscript',
      data: Buffer.from(script), resourceType: 'campaign', resourceId: 'c-pub' });
    run('DELETE FROM sandbox_daily_usage');
    saveConfig(validateConfig({ ...defaultConfig, enabled: true }), admin.id);
    const created = sandbox.createRun(owner, { campaign_id: 'c-pub', file_id: build.id, profile_id: 'linux-shell' });
    const { executions } = sandbox.dispatchQueued();
    await Promise.all(executions);
    const row = sandbox.getRunRow(created.id)!;
    assert.equal(row.status, 'failed', row.logs.slice(0, 2000) + row.error);
    assert.equal(row.exit_code, 3);
    assert.match(row.logs, /e2e uid=65534/);
    assert.match(row.logs, /FIN\n/);
    assert.equal(row.logs_truncated, 1);
    assert.ok(row.artifact_file_id, 'longer log stored through storeBuffer');
    const artifact = files.getFile(row.artifact_file_id!)!;
    assert.equal(artifact.purpose, 'sandbox_artifact');
    assert.equal(artifact.resource_type, 'sandbox_run');
    assert.equal(artifact.resource_id, created.id);
    const content = (await files.readFileBuffer(artifact.id)).toString('utf8');
    assert.match(content, /^\[alpha-sandbox\] [^\n]*\ne2e uid=65534\nligne 0 /);
    assert.ok(content.length > row.logs.length);
    sandbox.setSandboxRunner(null);
  });
});
