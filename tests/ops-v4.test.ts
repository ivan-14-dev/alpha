import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

// Temporary directories live under the project (never the system temp dir) and are removed afterwards.
const scratch = mkdtempSync(join(process.cwd(), '.ops-test-'));
process.env.DATABASE_PATH = ':memory:';
process.env.BACKUP_DIR = join(scratch, 'app-backups');
process.env.FILES_DIR = join(scratch, 'app-files');
delete process.env.METRICS_TOKEN;
delete process.env.CLAMAV_HOST;

const { app } = await import('../server/app.js');
const { db, one, run } = await import('../server/db.js');
const { runJob, listJobs } = await import('../server/platform/jobs.js');
const { latestSchemaVersion } = await import('../server/migrations.js');
const { createBackup, listBackups, restoreBackup, verifyChecksum, databaseInUse } = await import('../server/ops/backup-core.js');
const { promoteAdmin } = await import('../server/ops/admin-tools.js');
const { routeLabel } = await import('../server/ops/metrics.js');
const { appVersion } = await import('../server/ops/paths.js');

interface Actor { id: string; email: string; cookie: string }

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

test('V4 operations module', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const base = `${origin}/api`;
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(scratch, { recursive: true, force: true });
  });

  async function call(actor: Actor | null, path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        'X-Alpha-Client': 'web',
        Origin: 'http://127.0.0.1:5173',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(actor ? { Cookie: actor.cookie } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, json: () => JSON.parse(text) };
  }

  async function register(name: string): Promise<Actor> {
    const email = `${name.toLowerCase()}@ops.example.test`;
    const response = await fetch(`${base}/auth/register`, {
      method: 'POST',
      headers: { 'X-Alpha-Client': 'web', Origin: 'http://127.0.0.1:5173', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password: 'Alpha-ops-password-2026!' }),
    });
    assert.equal(response.status, 201, await response.clone().text());
    const data = await response.json() as { user: { id: string } };
    return { id: data.user.id, email, cookie: response.headers.get('set-cookie')!.split(';', 1)[0] };
  }

  const admin = await register('Opsadmin');
  const member = await register('Opsmember');
  run("UPDATE users SET role='admin' WHERE id=?", admin.id);

  await t.test('readiness reports ok, and 503 when migrations are behind', async () => {
    const ready = await call(null, '/system/ready');
    assert.equal(ready.status, 200, ready.text);
    assert.deepEqual(ready.json().checks, { database: 'ok', migrations: 'ok', secrets: 'ok' });
    assert.equal(ready.json().status, 'ready');
    const latest = one<{ version: number; name: string; checksum: string; applied_at: string }>('SELECT * FROM schema_migrations WHERE version=?', latestSchemaVersion)!;
    run('DELETE FROM schema_migrations WHERE version=?', latestSchemaVersion);
    try {
      const notReady = await call(null, '/system/ready');
      assert.equal(notReady.status, 503);
      assert.equal(notReady.json().status, 'not_ready');
      assert.equal(notReady.json().checks.migrations, 'failed');
      assert.equal(notReady.json().checks.database, 'ok');
    } finally {
      run('INSERT INTO schema_migrations(version,name,checksum,applied_at) VALUES (?,?,?,?)', latest.version, latest.name, latest.checksum, latest.applied_at);
    }
    assert.equal((await call(null, '/system/ready')).status, 200);
  });

  await t.test('metrics require a configured bearer token and expose Prometheus text without identifiers', async () => {
    assert.equal((await call(null, '/system/metrics')).status, 404);
    process.env.METRICS_TOKEN = 'too-short';
    assert.equal((await call(null, '/system/metrics', 'GET', undefined, { Authorization: 'Bearer too-short' })).status, 404);
    const token = 'metrics-token-for-tests-0123456789';
    process.env.METRICS_TOKEN = token;
    t.after(() => { delete process.env.METRICS_TOKEN; });

    const anonymous = await call(null, '/system/metrics');
    assert.equal(anonymous.status, 401);
    assert.match(anonymous.headers.get('www-authenticate') ?? '', /^Bearer/);
    assert.equal((await call(null, '/system/metrics', 'GET', undefined, { Authorization: `Bearer ${token}x` })).status, 401);
    assert.equal((await call(null, '/system/metrics', 'GET', undefined, { Authorization: `Basic ${token}` })).status, 401);

    await call(null, '/health');
    await call(null, `/system/admin/jobs/ops.backup/run`, 'POST');
    await call(member, `/projects/${member.id}`);
    await call(null, `/no-such-route/${admin.id}`);
    const metrics = await call(null, '/system/metrics', 'GET', undefined, { Authorization: `Bearer ${token}` });
    assert.equal(metrics.status, 200, metrics.text);
    assert.match(metrics.headers.get('content-type') ?? '', /^text\/plain; version=0\.0\.4/);
    const text = metrics.text;
    assert.match(text, /# TYPE alpha_http_requests_total counter/);
    assert.match(text, /alpha_http_requests_total\{method="GET",route="\/api\/health",status="200"\} [1-9]/);
    assert.match(text, /alpha_http_requests_total\{method="POST",route="\/api\/system\/admin\/jobs\/:name\/run",status="401"\} 1/);
    assert.match(text, /alpha_http_requests_total\{method="GET",route="\(unmatched\)",status="404"\}/);
    assert.match(text, /alpha_http_request_duration_seconds_bucket\{method="GET",route="\/api\/health",le="\+Inf"\} [1-9]/);
    assert.match(text, /# TYPE alpha_http_request_duration_seconds histogram/);
    assert.match(text, /alpha_job_runs_total\{job="ops\.backup"\} \d+/);
    assert.match(text, /alpha_job_failures_total\{job="mail\.deliver"\} \d+/);
    assert.match(text, /alpha_email_outbox\{status="queued"\} \d+/);
    assert.match(text, /alpha_db_size_bytes [1-9]\d*/);
    assert.match(text, /process_resident_memory_bytes [1-9]\d*/);
    assert.match(text, /process_uptime_seconds \d+/);
    assert.match(text, new RegExp(`alpha_schema_version ${latestSchemaVersion}`));
    assert.match(text, /alpha_users 2/);
    if (one("SELECT name FROM sqlite_master WHERE type='table' AND name='payment_intents'")) assert.match(text, /# TYPE alpha_payment_intents gauge/);
    for (const secret of [admin.id, member.id, admin.email, member.email, token, 'no-such-route']) assert.ok(!text.includes(secret), `metrics leak ${secret}`);
    for (const line of text.trim().split('\n')) {
      assert.match(line, /^(# (HELP|TYPE) [a-z_]+ .+|[a-z_]+(\{[a-z_]+="[^"]*"(,[a-z_]+="[^"]*")*\})? -?[\d.e+-]+|[a-z_]+(\{.*\})? \+Inf)$/, `invalid exposition line: ${line}`);
    }
  });

  await t.test('route labels never contain raw identifiers', () => {
    assert.equal(routeLabel('/api/projects', '/:id', true, '/api/projects/abc'), '/api/projects/:id');
    assert.equal(routeLabel('/api/projects/6f9619ff-8b86-d011-b42d-00cf4fc964ff/files', '/', true, '/api/x'), '/api/projects/:id/files');
    assert.equal(routeLabel('', undefined, false, '/api/unknown/123'), '(unmatched)');
    assert.equal(routeLabel('', undefined, false, '/assets/app.js'), '(static)');
  });

  await t.test('admin endpoints require an authenticated admin', async () => {
    const paths = ['/system/admin/overview', '/system/admin/backups', '/system/admin/jobs', '/system/admin/settings-audit', '/system/admin/environment'];
    for (const path of paths) {
      assert.equal((await call(null, path)).status, 401, path);
      assert.equal((await call(member, path)).status, 403, path);
      assert.equal((await call(admin, path)).status, 200, path);
    }
    assert.equal((await call(member, '/system/admin/backups', 'POST', {})).status, 403);
    assert.equal((await call(member, '/system/admin/jobs/ops.backup/run', 'POST', {})).status, 403);
    assert.equal((await call(member, '/system/admin/backups/settings', 'PUT', { enabled: true, keep: 3, include_files: false })).status, 403);
    assert.equal((await call(admin, '/system/admin/backups', 'POST', {}, { 'X-Alpha-Client': 'other' })).status, 403);

    const overview = (await call(admin, '/system/admin/overview')).json();
    assert.equal(overview.counts.users, 2);
    assert.equal(overview.counts.admins, 1);
    assert.equal(overview.counts.signups_7d, 2);
    assert.ok(overview.counts.active_sessions >= 2);
    assert.equal(overview.payment_mode, 'demo');
    assert.equal(overview.version, appVersion);
    assert.ok(overview.jobs.items.some((job: { name: string }) => job.name === 'ops.backup'));
    assert.equal(typeof overview.outbox.failed, 'number');
    assert.ok(Array.isArray(overview.recent_audit));
  });

  await t.test('the ops.backup job and the admin API create verifiable backups, audited', async () => {
    assert.equal(listBackups(process.env.BACKUP_DIR!).length, 0);
    mkdirSync(process.env.FILES_DIR!, { recursive: true });
    writeFileSync(join(process.env.FILES_DIR!, 'stored.bin'), 'contenu chiffré');
    assert.equal(await runJob('ops.backup'), true);
    const afterJob = listBackups(process.env.BACKUP_DIR!);
    assert.equal(afterJob.length, 1);
    assert.ok(afterJob[0].files, 'files archive included by default');
    assert.equal(await runJob('ops.backup'), true);
    assert.equal(listBackups(process.env.BACKUP_DIR!).length, 1, 'a recent backup makes the hourly job a no-op');
    assert.equal(listJobs().find((job) => job.name === 'ops.backup')!.last_status, 'ok');

    assert.equal((await call(admin, '/system/admin/backups', 'POST', { include_files: 'yes' })).status, 400);
    assert.equal((await call(admin, '/system/admin/backups', 'POST', { unknown: true })).status, 400);
    const created = await call(admin, '/system/admin/backups', 'POST', { include_files: false });
    assert.equal(created.status, 201, created.text);
    const manifest = created.json().backup;
    assert.equal(manifest.files, null);
    assert.equal(manifest.schema_version, latestSchemaVersion);
    await verifyChecksum(join(process.env.BACKUP_DIR!, manifest.database.file));
    assert.ok(one("SELECT id FROM audit_events WHERE action='ops.backup_created' AND actor_id=? AND target_id=?", admin.id, manifest.id));
    const listed = (await call(admin, '/system/admin/backups')).json();
    assert.equal(listed.backups.length, 2);
    assert.equal(listed.backups[0].id, manifest.id);

    assert.equal((await call(admin, '/system/admin/backups/settings', 'PUT', { enabled: true, keep: 0, include_files: true })).status, 400);
    const saved = await call(admin, '/system/admin/backups/settings', 'PUT', { enabled: true, keep: 1, include_files: false });
    assert.equal(saved.status, 200, saved.text);
    assert.deepEqual(saved.json().settings, { enabled: true, keep: 1, include_files: false });
    assert.equal(one<{ updated_by: string }>("SELECT updated_by FROM platform_settings WHERE key='ops.backup'")!.updated_by, admin.id);
    assert.ok(one("SELECT id FROM audit_events WHERE action='ops.backup_settings_updated' AND actor_id=?", admin.id));
    assert.equal((await call(admin, '/system/admin/backups', 'POST', {})).status, 201);
    assert.equal(listBackups(process.env.BACKUP_DIR!).length, 1, 'retention keeps the configured number of sets');

    const audit = (await call(admin, '/system/admin/settings-audit')).json();
    const setting = audit.settings.find((item: { key: string }) => item.key === 'ops.backup');
    assert.equal(setting.updated_by_name, 'Opsadmin');
    assert.equal(setting.secret_configured, false);
    assert.ok(audit.events.some((event: { action: string }) => event.action === 'ops.backup_settings_updated'));
  });

  await t.test('jobs can be listed and run on demand by admins only', async () => {
    assert.equal((await call(admin, '/system/admin/jobs/unknown.job/run', 'POST', {})).status, 404);
    assert.equal((await call(admin, '/system/admin/jobs/..%2Fx/run', 'POST', {})).status, 404);
    const ran = await call(admin, '/system/admin/jobs/mail.deliver/run', 'POST', {});
    assert.equal(ran.status, 200, ran.text);
    assert.equal(ran.json().status, 'ok');
    assert.equal(ran.json().job.name, 'mail.deliver');
    assert.ok(one("SELECT id FROM audit_events WHERE action='ops.job_run_requested' AND target_id='mail.deliver' AND actor_id=?", admin.id));
    const jobs = (await call(admin, '/system/admin/jobs')).json().jobs as Array<{ name: string; runs: number }>;
    assert.ok(jobs.find((job) => job.name === 'mail.deliver')!.runs >= 1);
  });

  await t.test('environment checks probe ClamAV and never return secret values', async () => {
    const clamd = createServer((socket) => socket.on('data', (chunk) => { if (chunk.toString().startsWith('zPING')) socket.end('PONG\0'); }));
    clamd.listen(0, '127.0.0.1');
    await once(clamd, 'listening');
    process.env.CLAMAV_HOST = '127.0.0.1';
    process.env.CLAMAV_PORT = String((clamd.address() as AddressInfo).port);
    process.env.METRICS_TOKEN = 'environment-check-token-0123456789';
    try {
      const response = await call(admin, '/system/admin/environment');
      assert.equal(response.status, 200, response.text);
      const checks = response.json().checks as Array<{ id: string; status: string; label: string; detail: string }>;
      const byId = Object.fromEntries(checks.map((check) => [check.id, check]));
      assert.equal(byId.clamav.status, 'ok');
      assert.equal(byId.metrics_token.status, 'ok');
      assert.equal(byId.backups.status, 'ok');
      for (const id of ['secrets_key', 'app_origin', 'smtp', 'sandbox', 'jobs', 'payment_mode', 'sqlite']) assert.ok(byId[id], `missing check ${id}`);
      assert.ok(!response.text.includes('environment-check-token-0123456789'));
      process.env.CLAMAV_PORT = '1';
      const down = (await call(admin, '/system/admin/environment')).json().checks.find((check: { id: string }) => check.id === 'clamav');
      assert.equal(down.status, 'error');
    } finally {
      delete process.env.CLAMAV_HOST;
      delete process.env.CLAMAV_PORT;
      delete process.env.METRICS_TOKEN;
      clamd.close();
    }
  });

  await t.test('backup -> restore round trip, retention and integrity', async () => {
    const backupDir = join(scratch, 'direct-backups');
    const filesDir = join(scratch, 'direct-files');
    mkdirSync(join(filesDir, 'ab'), { recursive: true });
    writeFileSync(join(filesDir, 'ab', 'file-1'), 'pièce jointe');
    run("INSERT INTO platform_settings(key,value) VALUES ('ops.test.marker','\"avant\"')");
    const first = await createBackup({ source: db, backupDir, filesDir, keep: 5, appVersion, now: new Date('2026-01-01T00:00:00Z') });
    const databaseArchive = join(backupDir, first.database.file);
    assert.equal(sha256(databaseArchive), first.database.sha256);
    assert.equal(readFileSync(`${databaseArchive}.sha256`, 'utf8'), `${first.database.sha256}  ${first.database.file}\n`);
    assert.ok(first.files && existsSync(join(backupDir, first.files.file)));

    const target = join(scratch, 'restore', 'alpha.sqlite');
    const restoredFiles = join(scratch, 'restore', 'files');
    const result = await restoreBackup({ archive: join(backupDir, `${first.id}.json`), databasePath: target, filesDir: restoredFiles });
    assert.equal(result.pre_restore_copy, null);
    assert.equal(result.files_restored, true);
    assert.equal(result.schema_version, latestSchemaVersion);
    const restored = new DatabaseSync(target, { readOnly: true });
    assert.equal((restored.prepare("SELECT value FROM platform_settings WHERE key='ops.test.marker'").get() as { value: string }).value, '"avant"');
    assert.equal((restored.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
    assert.equal((restored.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count, 2);
    restored.close();
    assert.equal(readFileSync(join(restoredFiles, 'ab', 'file-1'), 'utf8'), 'pièce jointe');

    run("UPDATE platform_settings SET value='\"après\"' WHERE key='ops.test.marker'");
    const second = await createBackup({ source: db, backupDir, filesDir: null, keep: 5, now: new Date('2026-01-02T00:00:00Z') });
    const again = await restoreBackup({ archive: join(backupDir, second.database.file), databasePath: target, filesDir: null });
    assert.ok(again.pre_restore_copy && existsSync(again.pre_restore_copy));
    const previous = new DatabaseSync(again.pre_restore_copy!, { readOnly: true });
    assert.equal((previous.prepare("SELECT value FROM platform_settings WHERE key='ops.test.marker'").get() as { value: string }).value, '"avant"');
    previous.close();

    await createBackup({ source: db, backupDir, filesDir: null, keep: 2, now: new Date('2026-01-03T00:00:00Z') });
    const kept = listBackups(backupDir);
    assert.deepEqual(kept.map((item) => item.created_at), ['2026-01-03T00:00:00.000Z', '2026-01-02T00:00:00.000Z']);
    assert.ok(!existsSync(databaseArchive), 'pruned archives are deleted');
    assert.ok(!existsSync(join(backupDir, first.files!.file)));
    run("DELETE FROM platform_settings WHERE key='ops.test.marker'");
  });

  await t.test('restore refuses tampered archives and running databases', async () => {
    const backupDir = join(scratch, 'refusal-backups');
    const manifest = await createBackup({ source: db, backupDir, filesDir: null });
    const archive = join(backupDir, manifest.database.file);
    const target = join(scratch, 'refusal', 'alpha.sqlite');
    mkdirSync(join(scratch, 'refusal'), { recursive: true });
    const live = new DatabaseSync(target);
    live.exec("PRAGMA journal_mode=WAL; CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES ('courant');");
    const before = sha256(target);

    const checksum = readFileSync(`${archive}.sha256`, 'utf8');
    writeFileSync(`${archive}.sha256`, checksum.replace(/^./, (char) => (char === '0' ? '1' : '0')));
    await assert.rejects(restoreBackup({ archive, databasePath: target, force: true }), /Somme de contrôle invalide/);
    writeFileSync(`${archive}.sha256`, checksum);
    const original = readFileSync(archive);
    const tampered = Buffer.from(original);
    tampered[tampered.length - 5] ^= 0xff;
    writeFileSync(archive, tampered);
    await assert.rejects(restoreBackup({ archive: join(backupDir, `${manifest.id}.json`), databasePath: target, force: true }), /Somme de contrôle invalide/);
    writeFileSync(archive, original);
    await assert.rejects(restoreBackup({ archive: `${archive}.sha256`, databasePath: target, force: true }), /Indiquez un manifeste/);
    rmSync(`${archive}.sha256`);
    await assert.rejects(restoreBackup({ archive, databasePath: target, force: true }), /somme de contrôle introuvable/i);
    writeFileSync(`${archive}.sha256`, checksum);

    assert.equal(databaseInUse(target), true);
    await assert.rejects(restoreBackup({ archive, databasePath: target }), /ouverte par un autre processus/);
    assert.equal(sha256(target), before, 'refused restores leave the database untouched');
    live.close();
    assert.equal(databaseInUse(target), false);
    const result = await restoreBackup({ archive, databasePath: target });
    assert.ok(result.pre_restore_copy);
    await assert.rejects(restoreBackup({ archive, databasePath: ':memory:' }), /mémoire/);
  });

  await t.test('promote-admin grants the admin role once and records an audit event', () => {
    const result = promoteAdmin('  OPSMEMBER@ops.example.test ');
    assert.deepEqual({ id: result.id, already: result.already_admin }, { id: member.id, already: false });
    assert.equal(one<{ role: string }>('SELECT role FROM users WHERE id=?', member.id)!.role, 'admin');
    assert.ok(one("SELECT id FROM audit_events WHERE action='ops.admin_promoted' AND target_id=? AND actor_id IS NULL", member.id));
    assert.equal(promoteAdmin(member.email).already_admin, true);
    assert.throws(() => promoteAdmin('unknown@ops.example.test'), /Aucun compte/);
    assert.throws(() => promoteAdmin('pas-une-adresse'), /invalide/);
  });
});
