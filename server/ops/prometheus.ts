import { all, one } from '../db.js';
import { latestSchemaVersion } from '../migrations.js';
import { listJobs } from '../platform/jobs.js';
import { log } from '../platform/log.js';
import { paymentMode } from '../payments/mode.js';
import { listBackups } from './backup-core.js';
import { MetricsWriter } from './metrics.js';
import { appVersion, backupDirectory, databaseSizes, startedAt, tableExists } from './runtime.js';

const seconds = (iso: string | null | undefined) => (iso ? Date.parse(iso) / 1000 : 0);

/** Full Prometheus exposition. Aggregates only: no user identifiers, emails or free text in labels. */
export function renderMetrics(): string {
  const writer = new MetricsWriter();
  writer.gauge('alpha_build_info', 'Alpha version and runtime.', 1, { version: appVersion, node: process.version });
  writer.gauge('alpha_payment_mode', 'Active payment mode (1 for the active mode).', 1, { mode: paymentMode() });

  const memory = process.memoryUsage();
  writer.gauge('process_resident_memory_bytes', 'Resident memory size in bytes.', memory.rss);
  writer.gauge('nodejs_heap_size_used_bytes', 'V8 heap used in bytes.', memory.heapUsed);
  writer.gauge('nodejs_heap_size_total_bytes', 'V8 heap total in bytes.', memory.heapTotal);
  writer.gauge('nodejs_external_memory_bytes', 'Memory used by C++ objects bound to JavaScript objects.', memory.external);
  writer.gauge('process_start_time_seconds', 'Start time of the process since unix epoch in seconds.', Math.floor(startedAt.getTime() / 1000));
  writer.gauge('process_uptime_seconds', 'Process uptime in seconds.', Math.round(process.uptime()));
  const cpu = process.cpuUsage();
  writer.family('process_cpu_seconds_total', 'counter', 'Total user and system CPU time spent in seconds.', [{ value: (cpu.user + cpu.system) / 1e6 }]);

  writer.http();

  const jobs = listJobs();
  writer.family('alpha_job_runs_total', 'counter', 'Background job executions.', jobs.map((job) => ({ labels: { job: job.name }, value: job.runs })));
  writer.family('alpha_job_failures_total', 'counter', 'Background job executions that failed.', jobs.map((job) => ({ labels: { job: job.name }, value: job.failures })));
  writer.family('alpha_job_last_run_failed', 'gauge', '1 when the latest execution of the job failed.', jobs.map((job) => ({ labels: { job: job.name }, value: job.last_status === 'failed' ? 1 : 0 })));
  writer.family('alpha_job_last_finished_timestamp_seconds', 'gauge', 'Unix time of the latest job completion (0 if never).', jobs.map((job) => ({ labels: { job: job.name }, value: seconds(job.last_finished_at) })));
  writer.family('alpha_job_running', 'gauge', '1 while the job is running.', jobs.map((job) => ({ labels: { job: job.name }, value: job.running ? 1 : 0 })));
  writer.family('alpha_job_enabled', 'gauge', '1 when scheduled executions are enabled.', jobs.map((job) => ({ labels: { job: job.name }, value: job.enabled ? 1 : 0 })));

  const outbox = all<{ status: string; count: number }>('SELECT status, COUNT(*) AS count FROM email_outbox GROUP BY status');
  const outboxStatuses = ['queued', 'sending', 'sent', 'failed', 'logged', 'cancelled'];
  writer.family('alpha_email_outbox', 'gauge', 'Emails in the outbox by status.',
    outboxStatuses.map((status) => ({ labels: { status }, value: outbox.find((row) => row.status === status)?.count ?? 0 })));
  const oldestQueued = one<{ oldest: string | null }>("SELECT MIN(send_after) AS oldest FROM email_outbox WHERE status='queued'")?.oldest;
  writer.gauge('alpha_email_outbox_oldest_queued_age_seconds', 'Age of the oldest queued email that is due (0 if none).',
    oldestQueued ? Math.max(0, Math.round((Date.now() - Date.parse(oldestQueued)) / 1000)) : 0);

  if (tableExists('payment_intents')) {
    try {
      const intents = all<{ status: string; mode: string; count: number }>('SELECT status, mode, COUNT(*) AS count FROM payment_intents GROUP BY status, mode');
      writer.family('alpha_payment_intents', 'gauge', 'Payment intents by status and mode.',
        intents.map((row) => ({ labels: { status: String(row.status), mode: String(row.mode) }, value: row.count })));
    } catch (error) {
      log.warn('ops.metrics.payment_intents', { error });
    }
  }

  const counts = one<{ users: number; sessions: number }>('SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM sessions WHERE expires_at > ?) AS sessions', new Date().toISOString())!;
  writer.gauge('alpha_users', 'Registered accounts.', counts.users);
  writer.gauge('alpha_active_sessions', 'Unexpired sessions.', counts.sessions);

  const sizes = databaseSizes();
  writer.gauge('alpha_db_size_bytes', 'SQLite database size (page_count * page_size).', sizes.database_bytes);
  writer.gauge('alpha_db_freelist_bytes', 'Unused pages inside the SQLite file.', sizes.free_pages_bytes);
  writer.gauge('alpha_db_wal_size_bytes', 'SQLite WAL file size.', sizes.wal_bytes);
  writer.gauge('alpha_schema_version', 'Applied database schema version.', one<{ version: number | null }>('SELECT MAX(version) AS version FROM schema_migrations')?.version ?? 0);
  writer.gauge('alpha_schema_latest_version', 'Schema version expected by this build.', latestSchemaVersion);

  const backups = listBackups(backupDirectory());
  writer.gauge('alpha_backups', 'Complete backup sets in BACKUP_DIR.', backups.length);
  writer.gauge('alpha_backup_last_success_timestamp_seconds', 'Unix time of the newest complete backup (0 if none).', seconds(backups[0]?.created_at));
  writer.gauge('alpha_backup_last_size_bytes', 'Compressed size of the newest database backup.', backups[0]?.database.bytes ?? 0);
  return writer.toString();
}
