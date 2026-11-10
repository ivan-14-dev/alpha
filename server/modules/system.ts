import { Router } from 'express';
import { z } from 'zod';
import { all, one, transaction } from '../db.js';
import { audit, HttpError, param, requireAdmin } from '../core.js';
import { jobExists, listJobs, runJob } from '../platform/jobs.js';
import { outboxStats } from '../platform/mailer.js';
import { safeEqual, sha256Hex } from '../platform/secrets.js';
import { setSetting } from '../platform/settings.js';
import { paymentMode } from '../payments/mode.js';
import { listBackups } from '../ops/backup-core.js';
import { BACKUP_SETTING, BackupBusyError, backupInProgress, backupSettings, backupSettingsSchema, runBackup } from '../ops/backup.js';
import { environmentChecks } from '../ops/environment.js';
import { readiness } from '../ops/health.js';
import { renderMetrics } from '../ops/prometheus.js';
import { appVersion, backupDirectory, databaseSizes, dataDirectory, diskSpace, startedAt, tableExists } from '../ops/runtime.js';

/** System module: readiness, Prometheus metrics and the admin operations console (/api/system). */
const router = Router();

router.get('/ready', (_req, res) => {
  const state = readiness();
  res.status(state.ready ? 200 : 503).json({ status: state.ready ? 'ready' : 'not_ready', checks: state.checks, version: appVersion });
});

/** Shorter tokens are treated as unset so a guessable value never exposes metrics. */
export const minimumMetricsTokenLength = 24;

router.get('/metrics', (req, res) => {
  const token = process.env.METRICS_TOKEN ?? '';
  if (token.length < minimumMetricsTokenLength) throw new HttpError(404, 'Route introuvable.');
  const header = req.headers.authorization ?? '';
  const provided = /^Bearer /i.test(header) ? header.slice(7).trim() : '';
  if (!provided || !safeEqual(sha256Hex(provided), sha256Hex(token))) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="alpha-metrics"');
    throw new HttpError(401, 'Jeton de métriques invalide.');
  }
  res.type('text/plain; version=0.0.4; charset=utf-8').send(renderMetrics());
});

function count(sql: string, ...params: string[]): number {
  return one<{ count: number }>(sql, ...params)?.count ?? 0;
}

function recentAudit(limit: number) {
  return all<{ id: string; action: string; target_type: string; target_id: string; detail: string; created_at: string; actor_id: string | null; actor_name: string | null }>(
    `SELECT a.id,a.action,a.target_type,a.target_id,substr(a.detail,1,200) AS detail,a.created_at,a.actor_id,u.name AS actor_name
     FROM audit_events a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.created_at DESC, a.rowid DESC LIMIT ?`, limit);
}

function fileStats() {
  if (!tableExists('files')) return null;
  try {
    return one<{ total: number; bytes: number; pending_scan: number; infected: number }>(
      `SELECT COUNT(*) AS total, COALESCE(SUM(size_bytes),0) AS bytes, COALESCE(SUM(scan_status='pending'),0) AS pending_scan,
       COALESCE(SUM(scan_status='infected'),0) AS infected FROM files WHERE deleted_at IS NULL`) ?? null;
  } catch {
    return null;
  }
}

function paymentIntentStatuses(): Record<string, number> | null {
  if (!tableExists('payment_intents')) return null;
  try {
    return Object.fromEntries(all<{ status: string; count: number }>('SELECT status, COUNT(*) AS count FROM payment_intents GROUP BY status')
      .map((row) => [row.status, row.count]));
  } catch {
    return null;
  }
}

router.get('/admin/overview', (req, res) => {
  requireAdmin(req);
  const nowIso = new Date().toISOString();
  const jobs = listJobs();
  const backups = listBackups(backupDirectory());
  const disk = diskSpace(dataDirectory());
  res.json({
    version: appVersion,
    node_version: process.version,
    environment: process.env.NODE_ENV ?? 'development',
    started_at: startedAt.toISOString(),
    uptime_seconds: Math.round(process.uptime()),
    payment_mode: paymentMode(),
    counts: {
      users: count('SELECT COUNT(*) AS count FROM users'),
      admins: count("SELECT COUNT(*) AS count FROM users WHERE role='admin'"),
      signups_7d: count('SELECT COUNT(*) AS count FROM users WHERE created_at >= ?', new Date(Date.now() - 7 * 86_400_000).toISOString()),
      active_sessions: count('SELECT COUNT(*) AS count FROM sessions WHERE expires_at > ?', nowIso),
      projects: count('SELECT COUNT(*) AS count FROM projects'),
      campaigns: count('SELECT COUNT(*) AS count FROM campaigns'),
      campaigns_open: count("SELECT COUNT(*) AS count FROM campaigns WHERE status='open'"),
      orders: count('SELECT COUNT(*) AS count FROM orders'),
      orders_disputed: count("SELECT COUNT(*) AS count FROM orders WHERE status='disputed'"),
    },
    files: fileStats(),
    disk: {
      ...databaseSizes(),
      backups_bytes: backups.reduce((sum, item) => sum + item.database.bytes + (item.files?.bytes ?? 0), 0),
      free_bytes: disk?.free_bytes ?? null,
      total_bytes: disk?.total_bytes ?? null,
    },
    jobs: {
      total: jobs.length,
      failing: jobs.filter((job) => job.last_status === 'failed').length,
      running: jobs.filter((job) => job.running).length,
      disabled: jobs.filter((job) => !job.enabled).length,
      scheduler: process.env.ALPHA_JOBS === 'off' ? 'off' : 'on',
      items: jobs,
    },
    outbox: {
      ...outboxStats(),
      failed_24h: count("SELECT COUNT(*) AS count FROM email_outbox WHERE status='failed' AND created_at >= ?", new Date(Date.now() - 86_400_000).toISOString()),
    },
    payment_intents: paymentIntentStatuses(),
    backups: { count: backups.length, latest: backups[0] ?? null, items: backups.slice(0, 5), settings: backupSettings(), in_progress: backupInProgress() },
    recent_audit: recentAudit(15),
  });
});

router.get('/admin/backups', (req, res) => {
  requireAdmin(req);
  res.json({ directory: backupDirectory(), settings: backupSettings(), in_progress: backupInProgress(), backups: listBackups(backupDirectory()) });
});

router.post('/admin/backups', async (req, res) => {
  const admin = requireAdmin(req);
  const input = z.object({ include_files: z.boolean().optional() }).strict().parse(req.body ?? {});
  let manifest;
  try {
    manifest = await runBackup({ includeFiles: input.include_files });
  } catch (error) {
    if (error instanceof BackupBusyError) throw new HttpError(409, error.message);
    const message = error instanceof Error ? error.message.slice(0, 300) : 'erreur inconnue';
    transaction(() => audit(admin.id, 'ops.backup_failed', 'backup', 'manual', message));
    throw new HttpError(500, `La sauvegarde a échoué : ${message}`);
  }
  const created = manifest;
  transaction(() => audit(admin.id, 'ops.backup_created', 'backup', created.id, `${created.database.bytes} octets${created.files ? ', fichiers inclus' : ''}`));
  res.status(201).json({ backup: created });
});

router.put('/admin/backups/settings', (req, res) => {
  const admin = requireAdmin(req);
  const input = backupSettingsSchema.parse(req.body);
  transaction(() => {
    setSetting(BACKUP_SETTING, input, admin.id);
    audit(admin.id, 'ops.backup_settings_updated', 'setting', BACKUP_SETTING, JSON.stringify(input));
  });
  res.json({ settings: backupSettings() });
});

router.get('/admin/jobs', (req, res) => {
  requireAdmin(req);
  res.json({ jobs: listJobs(), scheduler: process.env.ALPHA_JOBS === 'off' ? 'off' : 'on' });
});

router.post('/admin/jobs/:name/run', async (req, res) => {
  const admin = requireAdmin(req);
  const name = param(req, 'name');
  if (!/^[a-z0-9][a-z0-9.-]{2,60}$/.test(name) || !jobExists(name)) throw new HttpError(404, 'Tâche introuvable.');
  transaction(() => audit(admin.id, 'ops.job_run_requested', 'job', name));
  let status: 'ok' | 'failed' | 'already_running' = 'ok';
  let error = '';
  try {
    if (!(await runJob(name))) {
      status = 'already_running';
      error = 'La tâche est déjà en cours d’exécution.';
    }
  } catch (failure) {
    status = 'failed';
    error = failure instanceof Error ? failure.message.slice(0, 500) : 'Erreur inconnue';
  }
  res.status(status === 'already_running' ? 409 : 200).json({ status, error, job: listJobs().find((job) => job.name === name) ?? null });
});

router.get('/admin/settings-audit', (req, res) => {
  requireAdmin(req);
  const settings = all<{ key: string; updated_at: string; secret_configured: number; updated_by: string | null; updated_by_name: string | null }>(
    `SELECT s.key, s.updated_at, s.secret IS NOT NULL AS secret_configured, s.updated_by, u.name AS updated_by_name
     FROM platform_settings s LEFT JOIN users u ON u.id=s.updated_by ORDER BY s.updated_at DESC LIMIT 200`)
    .map((row) => ({ ...row, secret_configured: !!row.secret_configured }));
  const events = all<{ id: string; action: string; target_type: string; target_id: string; detail: string; created_at: string; actor_name: string | null }>(
    `SELECT a.id,a.action,a.target_type,a.target_id,substr(a.detail,1,200) AS detail,a.created_at,u.name AS actor_name
     FROM audit_events a JOIN users u ON u.id=a.actor_id WHERE u.role='admin' ORDER BY a.created_at DESC, a.rowid DESC LIMIT 100`);
  res.json({ settings, events });
});

router.get('/admin/environment', async (req, res) => {
  requireAdmin(req);
  res.json({ checks: await environmentChecks() });
});

export default router;
