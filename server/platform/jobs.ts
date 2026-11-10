import { all, run } from '../db.js';
import { log } from './log.js';

export interface JobDefinition {
  name: string;
  intervalMs: number;
  description: string;
  run: () => void | Promise<void>;
  /** Evaluated before each scheduled run; manual runs ignore it. */
  enabled?: () => boolean;
}

const jobs = new Map<string, JobDefinition>();
const running = new Set<string>();
const timers = new Map<string, NodeJS.Timeout>();

/** Register at module import time. Jobs only start when `startJobs()` is called (server/index.ts), never in tests. */
export function registerJob(job: JobDefinition) {
  if (!/^[a-z0-9][a-z0-9.-]{2,60}$/.test(job.name)) throw new Error(`Nom de tache invalide: ${job.name}`);
  if (job.intervalMs < 1000) throw new Error(`Intervalle trop court pour ${job.name}`);
  jobs.set(job.name, job);
}

function record(name: string, sql: string, ...params: (string | null)[]) {
  try { run(sql, ...params); } catch (error) { log.warn('job.record_failed', { job: name, error }); }
}

/** Runs a job once, without overlap. Returns false when the job was already running. */
export async function runJob(name: string): Promise<boolean> {
  const job = jobs.get(name);
  if (!job) throw new Error(`Tache inconnue: ${name}`);
  if (running.has(name)) return false;
  running.add(name);
  const started = new Date().toISOString();
  record(name, `INSERT INTO job_runs(name,runs,last_started_at,last_status) VALUES (?,1,?,'running')
    ON CONFLICT(name) DO UPDATE SET runs=runs+1,last_started_at=excluded.last_started_at,last_status='running'`, name, started);
  try {
    await job.run();
    record(name, "UPDATE job_runs SET last_finished_at=?,last_status='ok',last_error='' WHERE name=?", new Date().toISOString(), name);
    return true;
  } catch (error) {
    log.error('job.failed', { job: name, error });
    record(name, "UPDATE job_runs SET last_finished_at=?,last_status='failed',failures=failures+1,last_error=? WHERE name=?",
      new Date().toISOString(), error instanceof Error ? error.message.slice(0, 500) : 'Erreur inconnue', name);
    throw error;
  } finally {
    running.delete(name);
  }
}

export function startJobs() {
  for (const job of jobs.values()) {
    if (timers.has(job.name)) continue;
    const timer = setInterval(() => {
      if (job.enabled && !job.enabled()) return;
      void runJob(job.name).catch(() => undefined);
    }, job.intervalMs);
    timer.unref();
    timers.set(job.name, timer);
  }
  log.info('jobs.started', { jobs: [...jobs.keys()] });
}

export function stopJobs() {
  for (const timer of timers.values()) clearInterval(timer);
  timers.clear();
}

export function listJobs() {
  const rows = all<{ name: string; runs: number; failures: number; last_started_at: string | null; last_finished_at: string | null; last_status: string | null; last_error: string }>(
    'SELECT * FROM job_runs');
  return [...jobs.values()].map((job) => ({
    name: job.name,
    description: job.description,
    interval_ms: job.intervalMs,
    enabled: job.enabled ? job.enabled() : true,
    running: running.has(job.name),
    ...(({ name: _name, ...stats }) => stats)(rows.find((row) => row.name === job.name) ?? { name: job.name, runs: 0, failures: 0, last_started_at: null, last_finished_at: null, last_status: null, last_error: '' }),
  }));
}

export function jobExists(name: string) { return jobs.has(name); }
