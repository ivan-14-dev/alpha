import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { all, one, run, transaction } from '../db.js';
import { audit, HttpError, id, notify, now } from '../core.js';
import { getFile, filesFor, readFileBuffer, softDeleteFile, storeBuffer, type StoredFile } from '../files/service.js';
import { afterCommit, publishToUser } from '../platform/events.js';
import { registerJob } from '../platform/jobs.js';
import { log } from '../platform/log.js';
import { registerPersonalData } from '../platform/privacy.js';
import { getSetting } from '../platform/settings.js';
import { effectiveAllowlist, imageAllowed, sandboxActive, sandboxConfig, type SandboxConfig, type SandboxProfile } from './config.js';
import { dockerRunner, dockerSettings, pruneWorkDir } from './docker.js';
import { ARTIFACT_CAP_BYTES, LOG_CAP_BYTES, LogCollector } from './logs.js';
import { resolveCommand, safeBuildName, type RuntimeCheck, type SandboxLimits, type SandboxOutcome, type SandboxRunner } from './runner.js';

export const RUN_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'timeout', 'cancelled', 'error'] as const;
export type RunStatus = typeof RUN_STATUSES[number];
export const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set(['succeeded', 'failed', 'timeout', 'cancelled', 'error']);

const MB = 1024 * 1024;
const DAY_MS = 86400000;
/** Queued runs older than this are expired by the cleanup job (sandbox disabled, daemon down...). */
export const QUEUE_EXPIRY_MS = DAY_MS;
const USAGE_RETENTION_DAYS = 90;
/** Exit status of sandbox/entry.sh when the build cannot be prepared (copy, extraction, entry point). */
export const SETUP_FAILURE_EXIT = 121;

export interface RunRow {
  id: string;
  requester_id: string;
  campaign_id: string;
  mission_id: string | null;
  file_id: string | null;
  file_name: string;
  file_sha256: string;
  profile_id: string;
  profile_label: string;
  image: string;
  command: string;
  limits: string;
  runtime: string;
  status: RunStatus;
  exit_code: number | null;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  logs: string;
  logs_truncated: number;
  logs_pruned_at: string | null;
  container_name: string;
  cancelled_by: string | null;
  error: string;
  artifact_file_id: string | null;
}

/** Snapshot stored in `sandbox_runs.limits`: resource limits plus how the build is unpacked. */
export interface RunLimits extends SandboxLimits { extract: boolean; entry_candidates: string[] }

/** Where builds are read from and long logs are stored. Tests inject an in-memory implementation. */
export interface SandboxStorage {
  readBuild(file: StoredFile): Promise<Buffer>;
  storeArtifact(input: { ownerId: string; runId: string; name: string; data: Buffer }): Promise<string | null>;
  /** Synchronous (called inside retention / erasure transactions). Content is purged later by the files module. */
  deleteArtifact?(fileId: string): void;
}

const defaultStorage: SandboxStorage = {
  readBuild: (file) => readFileBuffer(file.id),
  async storeArtifact({ ownerId, runId, name, data }) {
    const stored = await storeBuffer({ ownerId, purpose: 'sandbox_artifact', name, mimeType: 'text/plain', data,
      resourceType: 'sandbox_run', resourceId: runId, skipScan: true });
    return stored.id;
  },
  deleteArtifact(fileId) { softDeleteFile(fileId, null); },
};

/** The artifact is the long copy of the log: it follows log retention and erasure. */
function retireArtifacts(where: string, ...params: (string | number)[]): number {
  const rows = all<{ id: string; artifact_file_id: string }>(
    `SELECT id,artifact_file_id FROM sandbox_runs WHERE artifact_file_id IS NOT NULL AND ${where}`, ...params);
  for (const row of rows) {
    storage.deleteArtifact?.(row.artifact_file_id);
    run('UPDATE sandbox_runs SET artifact_file_id=NULL WHERE id=?', row.id);
  }
  return rows.length;
}

let runner: SandboxRunner = dockerRunner;
let storage: SandboxStorage = defaultStorage;
let runtimeCache: { at: number; key: string; result: RuntimeCheck } | null = null;

export function setSandboxRunner(next: SandboxRunner | null) { runner = next ?? dockerRunner; runtimeCache = null; }
export function setSandboxStorage(next: SandboxStorage | null) { storage = next ?? defaultStorage; }
export function sandboxRunner(): SandboxRunner { return runner; }

/** Executions owned by THIS process. Registered synchronously right after the claim (no await in between). */
const active = new Map<string, { controller: AbortController; promise: Promise<void>; containerName: string }>();
/** Containers started by the admin self-test (never reaped while in flight). */
const selfTests = new Set<string>();

export function activeRunIds(): string[] { return [...active.keys()]; }
/** Test helper: resolves when every in-flight execution has been finalised. */
export async function waitForSandboxIdle() {
  while (active.size) await Promise.allSettled([...active.values()].map((entry) => entry.promise));
}

const delay = (ms: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
const utcDay = (date = new Date()) => date.toISOString().slice(0, 10);

class SetupError extends Error {}

// ---------------------------------------------------------------------------------------------------------------
// Runtime availability
// ---------------------------------------------------------------------------------------------------------------

export async function runtimeStatus(force = false): Promise<RuntimeCheck> {
  const config = sandboxConfig();
  if (config.runtime === 'disabled') return { ok: false, error: 'Aucun moteur d’exécution configuré.' };
  const key = `${runner.name}|${config.oci_runtime ?? ''}`;
  if (!force && runtimeCache && runtimeCache.key === key && Date.now() - runtimeCache.at < 30000) return runtimeCache.result;
  const result = await runner.check(config.oci_runtime).catch((): RuntimeCheck => ({ ok: false, error: 'Vérification du moteur impossible.' }));
  runtimeCache = { at: Date.now(), key, result };
  return result;
}

// ---------------------------------------------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------------------------------------------

interface CampaignRow { id: string; title: string; owner_id: string; project_id: string; status: string }
export interface CampaignAccess { campaign: CampaignRow; role: 'owner' | 'tester'; mission_id: string | null }

/** Campaign owner, or tester whose application was accepted and whose mission (if any) is not cancelled. */
export function campaignAccess(userId: string, campaignId: string): CampaignAccess | null {
  const campaign = one<CampaignRow>('SELECT id,title,owner_id,project_id,status FROM campaigns WHERE id=?', campaignId);
  if (!campaign) return null;
  if (campaign.owner_id === userId) return { campaign, role: 'owner', mission_id: null };
  const tester = one<{ mission_id: string | null; mission_status: string | null }>(`SELECT m.id AS mission_id, m.status AS mission_status
    FROM applications a LEFT JOIN missions m ON m.application_id=a.id
    WHERE a.campaign_id=? AND a.tester_id=? AND a.status='accepted'`, campaignId, userId);
  if (!tester || tester.mission_status === 'cancelled') return null;
  return { campaign, role: 'tester', mission_id: tester.mission_id };
}

function requireCampaignAccess(userId: string, campaignId: string): CampaignAccess {
  const access = campaignAccess(userId, campaignId);
  if (access) return access;
  const exists = one<{ project_id: string }>('SELECT project_id FROM campaigns WHERE id=?', campaignId);
  if (!exists) throw new HttpError(404, 'Campagne introuvable.');
  // Do not reveal private campaigns: same answer as a missing one unless the project is readable.
  const readable = !!one(`SELECT 1 FROM projects WHERE id=? AND visibility='public'`, exists.project_id);
  if (!readable) throw new HttpError(404, 'Campagne introuvable.');
  throw new HttpError(403, 'Seuls le propriétaire de la campagne et ses testeurs acceptés peuvent lancer une exécution.');
}

interface Actor { id: string; role: string }

export function runRole(actor: Actor, row: Pick<RunRow, 'requester_id' | 'campaign_id'>): 'requester' | 'owner' | 'admin' | null {
  if (row.requester_id === actor.id) return 'requester';
  if (one('SELECT 1 FROM campaigns WHERE id=? AND owner_id=?', row.campaign_id, actor.id)) return 'owner';
  if (actor.role === 'admin') return 'admin';
  return null;
}

/** Used by the files module to authorise sandbox artifacts (purpose sandbox_artifact, resource sandbox_run). */
export function canReadSandboxRun(userId: string, runId: string): boolean {
  const row = one<Pick<RunRow, 'requester_id' | 'campaign_id'>>('SELECT requester_id,campaign_id FROM sandbox_runs WHERE id=?', runId);
  if (!row) return false;
  const user = one<Actor>('SELECT id,role FROM users WHERE id=?', userId);
  return !!user && runRole(user, row) !== null;
}

// ---------------------------------------------------------------------------------------------------------------
// Builds
// ---------------------------------------------------------------------------------------------------------------

function filesRequireScan(): boolean {
  // Same setting and default as the files module (files.require_scan).
  return getSetting('files.require_scan', z.boolean(), process.env.NODE_ENV === 'production');
}

/** Null when the antivirus status allows execution, otherwise a French reason. */
export function scanProblem(file: Pick<StoredFile, 'scan_status'>, config: SandboxConfig): string | null {
  switch (file.scan_status) {
    case 'clean': return null;
    case 'skipped': return config.require_clean_scan || filesRequireScan() ? 'Ce build n’a pas été analysé par l’antivirus : exécution refusée.' : null;
    case 'pending': return 'Analyse antivirus en cours : réessayez dans quelques instants.';
    case 'infected': return 'Ce build a été signalé comme dangereux par l’antivirus : exécution refusée.';
    default: return 'L’analyse antivirus de ce build a échoué : exécution refusée.';
  }
}

function sizeProblem(file: Pick<StoredFile, 'size_bytes'>, config: SandboxConfig, profile?: SandboxProfile): string | null {
  if (file.size_bytes > config.max_build_mb * MB) return `Build trop volumineux pour le bac à sable (maximum ${config.max_build_mb} Mo).`;
  if (profile && file.size_bytes > profile.tmpfs_mb * MB * 0.9) return `Build plus volumineux que l’espace de travail du profil (${profile.tmpfs_mb} Mo).`;
  return null;
}

function campaignBuild(fileId: string, campaignId: string): StoredFile | null {
  const file = getFile(fileId);
  if (!file || file.purpose !== 'campaign_build' || file.resource_type !== 'campaign' || file.resource_id !== campaignId) return null;
  return file;
}

export function campaignBuilds(campaignId: string) {
  const config = sandboxConfig();
  return filesFor('campaign', campaignId).filter((file) => file.purpose === 'campaign_build').map((file) => {
    const reason = scanProblem(file, config) ?? sizeProblem(file, config);
    return { id: file.id, original_name: file.original_name, size_bytes: file.size_bytes, mime_type: file.mime_type,
      scan_status: file.scan_status, created_at: file.created_at, eligible: !reason, reason };
  }).reverse();
}

// ---------------------------------------------------------------------------------------------------------------
// Quotas
// ---------------------------------------------------------------------------------------------------------------

export function usageToday(userId: string) {
  return one<{ runs: number; duration_ms: number }>('SELECT runs,duration_ms FROM sandbox_daily_usage WHERE user_id=? AND day=?', userId, utcDay())
    ?? { runs: 0, duration_ms: 0 };
}

export function pendingCount(userId: string): number {
  return one<{ n: number }>("SELECT COUNT(*) AS n FROM sandbox_runs WHERE requester_id=? AND status IN ('queued','running')", userId)!.n;
}

/** A run that never consumed resources (platform error, cancelled while queued) gives its quota slot back. */
function refund(row: Pick<RunRow, 'requester_id' | 'queued_at'>) {
  run('UPDATE sandbox_daily_usage SET runs=MAX(runs-1,0) WHERE user_id=? AND day=?', row.requester_id, row.queued_at.slice(0, 10));
}

// ---------------------------------------------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------------------------------------------

export function getRunRow(runId: string): RunRow | null {
  return one<RunRow>('SELECT * FROM sandbox_runs WHERE id=?', runId) ?? null;
}

export function createRun(requesterId: string, input: { campaign_id: string; file_id: string; profile_id: string }): RunRow {
  const config = sandboxConfig();
  if (!sandboxActive(config)) throw new HttpError(503, 'Le bac à sable est désactivé par l’administration de la plateforme.');
  const profile = config.profiles.find((item) => item.id === input.profile_id && item.enabled);
  if (!profile) throw new HttpError(404, 'Profil d’exécution introuvable ou désactivé.');
  if (!imageAllowed(profile.image, effectiveAllowlist(config))) throw new HttpError(409, 'L’image de ce profil n’est plus autorisée : contactez l’administration.');
  return transaction(() => {
    const access = requireCampaignAccess(requesterId, input.campaign_id);
    const file = campaignBuild(input.file_id, input.campaign_id);
    if (!file) throw new HttpError(404, 'Build introuvable pour cette campagne.');
    const scan = scanProblem(file, config);
    if (scan) throw new HttpError(409, scan);
    const size = sizeProblem(file, config, profile);
    if (size) throw new HttpError(413, size);
    if (pendingCount(requesterId) >= config.max_pending_per_user) {
      throw new HttpError(429, `Vous avez déjà ${config.max_pending_per_user} exécution(s) en attente ou en cours : patientez ou annulez-en une.`);
    }
    const day = utcDay();
    if (usageToday(requesterId).runs >= config.daily_quota) {
      throw new HttpError(429, `Quota quotidien atteint (${config.daily_quota} exécutions par jour). Réessayez demain.`);
    }
    const runId = id();
    const limits: RunLimits = { timeout_s: profile.timeout_s, memory_mb: profile.memory_mb, cpus: profile.cpus, pids: profile.pids,
      tmpfs_mb: profile.tmpfs_mb, extract: profile.extract, entry_candidates: profile.entry_candidates };
    run(`INSERT INTO sandbox_runs (id,requester_id,campaign_id,mission_id,file_id,file_name,file_sha256,profile_id,profile_label,image,command,limits,
      runtime,status,queued_at,container_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'queued',?,?)`,
    runId, requesterId, access.campaign.id, access.mission_id, file.id, file.original_name.slice(0, 255), file.sha256, profile.id, profile.label,
    profile.image, JSON.stringify(profile.command), JSON.stringify(limits), runtimeLabel(config), now(), `alpha-sbx-${runId}`);
    run(`INSERT INTO sandbox_daily_usage(user_id,day,runs) VALUES (?,?,1)
      ON CONFLICT(user_id,day) DO UPDATE SET runs=runs+1`, requesterId, day);
    audit(requesterId, 'sandbox.run_requested', 'sandbox_run', runId, `${profile.id} ${file.id}`);
    return getRunRow(runId)!;
  });
}

function runtimeLabel(config: SandboxConfig) {
  return config.oci_runtime ? `${config.runtime}/${config.oci_runtime}` : config.runtime;
}

function statusTitle(status: RunStatus) {
  return ({ succeeded: 'réussie', failed: 'en échec', timeout: 'arrêtée (délai dépassé)', cancelled: 'annulée', error: 'en erreur', queued: 'en attente', running: 'en cours' })[status];
}

function notifyFinished(row: RunRow, status: RunStatus) {
  if (status === 'cancelled' && row.cancelled_by === row.requester_id) return;
  notify(row.requester_id, 'sandbox.run', `Exécution ${statusTitle(status)} : ${row.file_name || 'build'}`,
    `Profil ${row.profile_label || row.profile_id}.`, `/sandbox/${row.id}`);
}

function publish(row: Pick<RunRow, 'id' | 'requester_id'>, status: RunStatus) {
  publishToUser(row.requester_id, { type: 'sandbox.run', data: { id: row.id, status } });
}

/** Sync claim (short transaction) followed by asynchronous executions that the caller does not have to await. */
export function dispatchQueued(): { claimed: string[]; executions: Promise<void>[] } {
  const config = sandboxConfig();
  if (!sandboxActive(config)) return { claimed: [], executions: [] };
  const label = runtimeLabel(config);
  const claimed = transaction(() => {
    const running = one<{ n: number }>("SELECT COUNT(*) AS n FROM sandbox_runs WHERE status='running'")!.n;
    const free = config.max_concurrent - running;
    if (free <= 0) return [] as RunRow[];
    const startedAt = now();
    return all<RunRow>("SELECT * FROM sandbox_runs WHERE status='queued' ORDER BY queued_at, id LIMIT ?", free)
      .filter((row) => run("UPDATE sandbox_runs SET status='running',started_at=?,runtime=? WHERE id=? AND status='queued'", startedAt, label, row.id).changes === 1)
      .map((row) => ({ ...row, status: 'running' as const, started_at: startedAt, runtime: label }));
  });
  const executions = claimed.map((row) => {
    const controller = new AbortController();
    const entry = { controller, containerName: row.container_name, promise: Promise.resolve() };
    active.set(row.id, entry);
    entry.promise = execute(row, controller, config)
      .catch((error) => log.error('sandbox.execution_crashed', { error, run_id: row.id }))
      .finally(() => { active.delete(row.id); });
    publish(row, 'running');
    return entry.promise;
  });
  if (claimed.length) log.info('sandbox.dispatched', { runs: claimed.map((row) => row.id) });
  return { claimed: claimed.map((row) => row.id), executions };
}

function classify(row: RunRow, limits: RunLimits, outcome: SandboxOutcome, setupError: string, reason: unknown): { status: RunStatus; error: string } {
  if (reason === 'cancel') {
    const by = row.cancelled_by ? one<Actor>('SELECT id,role FROM users WHERE id=?', row.cancelled_by) : undefined;
    const role = by ? runRole(by, row) : null;
    return { status: 'cancelled', error: role === 'requester' ? 'Annulée par le demandeur.' : role === 'owner' ? 'Annulée par le propriétaire de la campagne.'
      : role === 'admin' ? 'Arrêtée par l’administration.' : 'Annulée.' };
  }
  if (reason === 'timeout') return { status: 'timeout', error: `Durée maximale dépassée (${limits.timeout_s} s) : le conteneur a été arrêté.` };
  if (setupError) return { status: 'error', error: setupError };
  if (outcome.error) return { status: 'error', error: outcome.error.slice(0, 500) };
  if (outcome.exitCode === null) return { status: 'error', error: 'Le conteneur s’est arrêté sans code de sortie.' };
  if (outcome.exitCode === 125) return { status: 'error', error: 'Le moteur a refusé de démarrer le conteneur (image absente du démon ? voir le journal).' };
  if (outcome.exitCode === 0) return { status: 'succeeded', error: '' };
  if (outcome.exitCode === SETUP_FAILURE_EXIT) return { status: 'failed', error: 'Préparation du build impossible (archive, point d’entrée) : voir le journal.' };
  if (outcome.exitCode === 137) return { status: 'failed', error: `Processus tué (SIGKILL) : mémoire épuisée (limite ${limits.memory_mb} Mo) ou chien de garde interne.` };
  if (outcome.exitCode === 126 || outcome.exitCode === 127) {
    return { status: 'failed', error: 'Programme introuvable ou non exécutable (architecture, bibliothèques ou point d’entrée incompatibles).' };
  }
  return { status: 'failed', error: `Le programme s’est terminé avec le code ${outcome.exitCode}.` };
}

async function execute(row: RunRow, controller: AbortController, config: SandboxConfig) {
  const limits = JSON.parse(row.limits) as RunLimits;
  const command = JSON.parse(row.command) as string[];
  const collector = new LogCollector(LOG_CAP_BYTES, ARTIFACT_CAP_BYTES, [dockerSettings().workDir]);
  const started = Date.now();
  let outcome: SandboxOutcome = { exitCode: null };
  let setupError = '';
  let timer: NodeJS.Timeout | undefined;
  let flushed = 0;
  const flush = () => {
    if (collector.version === flushed) return;
    flushed = collector.version;
    try {
      run("UPDATE sandbox_runs SET logs=?,logs_truncated=? WHERE id=? AND status='running'", collector.text(), collector.truncated ? 1 : 0, row.id);
    } catch (error) { log.warn('sandbox.log_flush_failed', { error, run_id: row.id }); }
  };
  const flusher = setInterval(flush, 1000);
  flusher.unref();
  try {
    // Re-validated at execution time: the allowlist, the file or its antivirus verdict may have changed while queued.
    if (!imageAllowed(row.image, effectiveAllowlist(sandboxConfig()))) throw new SetupError('L’image de ce profil n’est plus autorisée par l’administration.');
    const file = row.file_id ? getFile(row.file_id) : null;
    if (!file) throw new SetupError('Le build a été supprimé avant l’exécution.');
    const scan = scanProblem(file, sandboxConfig());
    if (scan) throw new SetupError(scan);
    let data: Buffer;
    try {
      data = await storage.readBuild(file);
    } catch (error) {
      log.warn('sandbox.build_read_failed', { error, run_id: row.id, file_id: file.id });
      throw new SetupError('Lecture du build impossible (stockage indisponible ou fichier refusé par l’antivirus).');
    }
    if (row.file_sha256 && createHash('sha256').update(data).digest('hex') !== row.file_sha256) {
      throw new SetupError('Empreinte SHA-256 du build différente de celle enregistrée : exécution refusée.');
    }
    const name = safeBuildName(row.file_name || 'build');
    collector.note(`${row.profile_label} · ${row.image} · réseau coupé · ${limits.memory_mb} Mo · ${String(limits.cpus).replace(".", ",")} CPU · ${limits.timeout_s} s max`);
    timer = setTimeout(() => controller.abort('timeout'), limits.timeout_s * 1000);
    outcome = await runner.execute({
      runId: row.id, containerName: row.container_name, image: row.image, command: resolveCommand(command, name),
      input: { name, data }, extract: limits.extract, entryCandidates: limits.entry_candidates,
      limits: { timeout_s: limits.timeout_s, memory_mb: limits.memory_mb, cpus: limits.cpus, pids: limits.pids, tmpfs_mb: limits.tmpfs_mb },
      ociRuntime: config.oci_runtime, inputMode: config.input_mode,
    }, { onOutput: (chunk) => collector.push(chunk), signal: controller.signal });
  } catch (error) {
    if (error instanceof SetupError) setupError = error.message;
    else {
      log.error('sandbox.execute_failed', { error, run_id: row.id });
      setupError = 'Erreur interne du bac à sable.';
    }
  } finally {
    clearTimeout(timer);
    clearInterval(flusher);
  }
  const reason = controller.signal.aborted ? controller.signal.reason : null;
  const fresh = getRunRow(row.id);
  if (!fresh) return; // erased meanwhile (privacy)
  const { status, error } = classify(fresh, limits, outcome, setupError, reason);
  if (status === 'timeout') collector.note(`Délai de ${limits.timeout_s} s dépassé : conteneur arrêté.`);
  if (status === 'cancelled') collector.note('Exécution annulée : conteneur arrêté.');
  const finished = finish(fresh, { status, error, exitCode: outcome.exitCode, logs: collector.text(), truncated: collector.truncated,
    durationMs: Date.now() - started });
  if (!finished) return;
  const artifact = collector.artifact();
  if (artifact) {
    try {
      const fileId = await storage.storeArtifact({ ownerId: row.requester_id, runId: row.id, name: `sandbox-${row.id}.log`, data: artifact });
      if (fileId && !Number(run('UPDATE sandbox_runs SET artifact_file_id=? WHERE id=?', fileId, row.id).changes)) {
        storage.deleteArtifact?.(fileId); // run erased while the artifact was being stored
      }
    } catch (error) { log.warn('sandbox.artifact_failed', { error, run_id: row.id }); }
  }
}

function finish(row: RunRow, result: { status: RunStatus; error: string; exitCode: number | null; logs: string; truncated: boolean; durationMs: number }) {
  return transaction(() => {
    const changed = run(`UPDATE sandbox_runs SET status=?,exit_code=?,finished_at=?,duration_ms=?,logs=?,logs_truncated=?,error=?
      WHERE id=? AND status='running'`, result.status, result.exitCode, now(), Math.max(0, result.durationMs), result.logs, result.truncated ? 1 : 0,
    result.error.slice(0, 2000), row.id).changes;
    if (!changed) return false;
    run(`INSERT INTO sandbox_daily_usage(user_id,day,runs,duration_ms) VALUES (?,?,0,?)
      ON CONFLICT(user_id,day) DO UPDATE SET duration_ms=duration_ms+excluded.duration_ms`, row.requester_id, row.queued_at.slice(0, 10), Math.max(0, result.durationMs));
    if (result.status === 'error') refund(row);
    notifyFinished(row, result.status);
    publish(row, result.status);
    return true;
  });
}

/**
 * Cancels a queued run immediately, or stops a running one (kills the container) and waits briefly for finalisation.
 * Allowed for the requester, the campaign owner and administrators.
 */
export async function cancelRun(actor: Actor, runId: string): Promise<RunRow> {
  let row = getRunRow(runId);
  if (!row || !runRole(actor, row)) throw new HttpError(404, 'Exécution introuvable.');
  if (row.status === 'queued') {
    const current = row;
    const done = transaction(() => {
      const changed = run(`UPDATE sandbox_runs SET status='cancelled',finished_at=?,duration_ms=0,cancelled_by=?,error=? WHERE id=? AND status='queued'`,
        now(), actor.id, actor.id === current.requester_id ? 'Annulée par le demandeur.' : 'Annulée avant son démarrage.', runId).changes;
      if (!changed) return false;
      refund(current);
      notifyFinished({ ...current, cancelled_by: actor.id }, 'cancelled');
      publish(current, 'cancelled');
      audit(actor.id, 'sandbox.run_cancelled', 'sandbox_run', runId, 'queued');
      return true;
    });
    if (done) return getRunRow(runId)!;
    row = getRunRow(runId)!;
  }
  if (row.status === 'running') {
    transaction(() => {
      run("UPDATE sandbox_runs SET cancelled_by=? WHERE id=? AND status='running'", actor.id, runId);
      audit(actor.id, 'sandbox.run_cancelled', 'sandbox_run', runId, 'running');
    });
    const entry = active.get(runId);
    if (entry) {
      entry.controller.abort('cancel');
      await Promise.race([entry.promise, delay(10000)]);
    } else {
      // Not executed by this process (crash leftover): finalise it here and remove its container.
      const current = row;
      transaction(() => {
        const changed = run(`UPDATE sandbox_runs SET status='cancelled',finished_at=?,error=? WHERE id=? AND status='running'`,
          now(), 'Arrêtée (exécution orpheline).', runId).changes;
        if (changed) { refund(current); publish(current, 'cancelled'); }
      });
      await runner.kill(row.container_name).catch((error) => log.warn('sandbox.kill_failed', { error, run_id: runId }));
    }
    return getRunRow(runId)!;
  }
  throw new HttpError(409, 'Cette exécution est déjà terminée.');
}

/** Startup recovery: runs left `running` by a previous process are failed and their containers removed. */
export async function recoverSandbox(): Promise<{ recovered: number; removed: number }> {
  const orphans = all<RunRow>("SELECT * FROM sandbox_runs WHERE status='running'").filter((row) => !active.has(row.id));
  for (const row of orphans) {
    transaction(() => {
      const changed = run(`UPDATE sandbox_runs SET status='error',finished_at=?,error=? WHERE id=? AND status='running'`,
        now(), 'Interrompue par un redémarrage du serveur : relancez l’exécution.', row.id).changes;
      if (!changed) return;
      refund(row);
      notifyFinished(row, 'error');
      publish(row, 'error');
    });
  }
  let removed = 0;
  const config = sandboxConfig();
  if (config.runtime === 'docker' && (sandboxActive(config) || orphans.length)) {
    try { removed = await runner.removeLeftovers(keepContainers()); }
    catch (error) { log.warn('sandbox.recovery_cleanup_failed', { error }); }
  }
  if (orphans.length || removed) log.warn('sandbox.recovered', { runs: orphans.length, containers: removed });
  return { recovered: orphans.length, removed };
}

function keepContainers() {
  return new Set([...[...active.values()].map((entry) => entry.containerName), ...selfTests]);
}

/** Retention, queue expiry, usage pruning and orphan containers/directories. */
export async function cleanupSandbox(at = Date.now()) {
  const config = sandboxConfig();
  const iso = (ms: number) => new Date(ms).toISOString();
  const result = transaction(() => {
    const artifacts = retireArtifacts('finished_at IS NOT NULL AND finished_at<?', iso(at - config.log_retention_days * DAY_MS));
    const pruned = run(`UPDATE sandbox_runs SET logs='',logs_pruned_at=? WHERE finished_at IS NOT NULL AND finished_at<? AND logs_pruned_at IS NULL`,
      iso(at), iso(at - config.log_retention_days * DAY_MS)).changes;
    const deleted = run('DELETE FROM sandbox_runs WHERE finished_at IS NOT NULL AND finished_at<?', iso(at - config.run_retention_days * DAY_MS)).changes;
    const stale = all<RunRow>("SELECT * FROM sandbox_runs WHERE status='queued' AND queued_at<?", iso(at - QUEUE_EXPIRY_MS));
    for (const row of stale) {
      if (!run(`UPDATE sandbox_runs SET status='cancelled',finished_at=?,duration_ms=0,error=? WHERE id=? AND status='queued'`,
        iso(at), 'Expirée : aucune capacité d’exécution disponible pendant 24 h.', row.id).changes) continue;
      refund(row);
      notifyFinished(row, 'cancelled');
    }
    const usage = run('DELETE FROM sandbox_daily_usage WHERE day<?', utcDay(new Date(at - USAGE_RETENTION_DAYS * DAY_MS))).changes;
    return { pruned, deleted, expired: stale.length, usage, artifacts };
  });
  let reaped = 0;
  if (config.runtime === 'docker' && sandboxActive(config)) {
    try { reaped = await runner.removeLeftovers(keepContainers()); }
    catch (error) { log.warn('sandbox.reap_failed', { error }); }
    if (runner === dockerRunner) await pruneWorkDir(3600000, new Set(active.keys())).catch(() => undefined);
  }
  return { ...result, reaped };
}

// ---------------------------------------------------------------------------------------------------------------
// Admin tools
// ---------------------------------------------------------------------------------------------------------------

const selfTestScript = [
  'echo "uid=$(id -u) gid=$(id -g)"',
  'if touch /alpha-rootfs-probe 2>/dev/null; then echo "rootfs=writable"; else echo "rootfs=read-only"; fi',
  'ifaces=$(ls /sys/class/net 2>/dev/null | tr "\\n" " ")',
  'echo "interfaces=${ifaces}"',
  'if (wget -q -T 3 -O /dev/null http://1.1.1.1/ || nc -w 3 1.1.1.1 80 </dev/null) >/dev/null 2>&1; then echo "network=reachable"; else echo "network=isolated"; fi',
  'echo "alpha-sandbox-selftest-ok"',
].join('\n');

export interface SelfTestResult {
  ok: boolean;
  check: RuntimeCheck;
  profile_id: string | null;
  exit_code: number | null;
  duration_ms: number;
  output: string;
  checks: { non_root: boolean; read_only_root: boolean; network_isolated: boolean; completed: boolean } | null;
  error: string | null;
}

/** `docker info` plus a tiny probe script run under a profile's image with the exact production flags. */
export async function selfTest(profileId?: string): Promise<SelfTestResult> {
  const config = sandboxConfig();
  const check = await runtimeStatus(true);
  const base = { check, profile_id: null, exit_code: null, duration_ms: 0, output: '', checks: null };
  if (!check.ok) return { ...base, ok: false, error: check.error ?? 'Moteur indisponible.' };
  const profile = config.profiles.find((item) => item.id === profileId) ?? config.profiles.find((item) => item.enabled) ?? config.profiles[0];
  if (!profile) return { ...base, ok: false, error: 'Aucun profil configuré.' };
  if (!imageAllowed(profile.image, effectiveAllowlist(config))) return { ...base, profile_id: profile.id, ok: false, error: 'Image du profil non autorisée.' };
  const containerName = `alpha-sbx-selftest-${randomUUID().slice(0, 12)}`;
  const collector = new LogCollector(16 * 1024, 0, [dockerSettings().workDir]);
  const controller = new AbortController();
  const timeout = Math.min(30, profile.timeout_s);
  const timer = setTimeout(() => controller.abort('timeout'), timeout * 1000);
  const started = Date.now();
  selfTests.add(containerName);
  let outcome: SandboxOutcome;
  try {
    outcome = await runner.execute({
      runId: containerName.slice('alpha-sbx-'.length), containerName, image: profile.image, command: ['/bin/sh', resolveCommand(['{input}'], 'alpha-selftest.sh')[0]],
      input: { name: 'alpha-selftest.sh', data: Buffer.from(`${selfTestScript}\n`) }, extract: false, entryCandidates: [],
      limits: { timeout_s: timeout, memory_mb: profile.memory_mb, cpus: profile.cpus, pids: profile.pids, tmpfs_mb: profile.tmpfs_mb },
      ociRuntime: config.oci_runtime, inputMode: config.input_mode,
    }, { onOutput: (chunk) => collector.push(chunk), signal: controller.signal });
  } catch (error) {
    log.error('sandbox.selftest_failed', { error });
    outcome = { exitCode: null, error: 'Erreur interne pendant l’auto-test.' };
  } finally {
    clearTimeout(timer);
    selfTests.delete(containerName);
  }
  const output = collector.text();
  const checks = {
    non_root: /^uid=65534 /m.test(output),
    read_only_root: /^rootfs=read-only$/m.test(output),
    network_isolated: /^network=isolated$/m.test(output) && /^interfaces=(lo )?$/m.test(output),
    completed: output.includes('alpha-sandbox-selftest-ok'),
  };
  const ok = outcome.exitCode === 0 && Object.values(checks).every(Boolean);
  const error = controller.signal.aborted ? 'Délai dépassé (image absente ? utilisez « Télécharger l’image »).'
    : outcome.error ?? (ok ? null : 'Une vérification d’isolation a échoué : voir la sortie.');
  return { ok, check, profile_id: profile.id, exit_code: outcome.exitCode, duration_ms: Date.now() - started, output, checks, error };
}

export async function pullProfileImage(profileId: string) {
  const config = sandboxConfig();
  const profile = config.profiles.find((item) => item.id === profileId);
  if (!profile) throw new HttpError(404, 'Profil introuvable.');
  if (!imageAllowed(profile.image, effectiveAllowlist(config))) throw new HttpError(409, 'Image non autorisée.');
  if (!runner.pull) throw new HttpError(409, 'Ce moteur ne sait pas télécharger d’image.');
  return { image: profile.image, ...(await runner.pull(profile.image)) };
}

// ---------------------------------------------------------------------------------------------------------------
// Jobs and personal data
// ---------------------------------------------------------------------------------------------------------------

let recovered = false;

registerJob({
  name: 'sandbox.dispatch',
  intervalMs: 3000,
  description: 'Bac à sable : récupère les exécutions interrompues (au démarrage) puis lance les exécutions en attente.',
  async run() {
    if (!recovered) {
      recovered = true;
      await recoverSandbox();
    }
    dispatchQueued();
  },
});

registerJob({
  name: 'sandbox.cleanup',
  intervalMs: 30 * 60000,
  description: 'Bac à sable : rétention des journaux et exécutions, expiration de la file, conteneurs et dossiers orphelins.',
  async run() { await cleanupSandbox(); },
});

registerPersonalData('sandbox', {
  description: 'Exécutions demandées dans le bac à sable (métadonnées, statut, durée) et consommation quotidienne.',
  export(userId) {
    return {
      runs: all(`SELECT id,campaign_id,mission_id,file_name,profile_id,profile_label,image,status,exit_code,queued_at,started_at,finished_at,
        duration_ms,error,logs_truncated FROM sandbox_runs WHERE requester_id=? ORDER BY queued_at`, userId),
      daily_usage: all('SELECT day,runs,duration_ms FROM sandbox_daily_usage WHERE user_id=? ORDER BY day', userId),
    };
  },
  erase(userId) {
    const running = all<{ id: string }>("SELECT id FROM sandbox_runs WHERE requester_id=? AND status='running'", userId).map((row) => row.id);
    if (running.length) afterCommit(() => { for (const runId of running) active.get(runId)?.controller.abort('cancel'); });
    retireArtifacts('requester_id=?', userId);
    run('DELETE FROM sandbox_runs WHERE requester_id=?', userId);
    run('UPDATE sandbox_runs SET cancelled_by=NULL WHERE cancelled_by=?', userId);
    run('DELETE FROM sandbox_daily_usage WHERE user_id=?', userId);
  },
});
