import { z } from 'zod';
import { all, one, run, transaction } from '../db.js';
import { notify, now } from '../core.js';
import { log } from '../platform/log.js';
import { getSetting, settingUpdatedAt } from '../platform/settings.js';
import { publishToUser } from '../platform/events.js';
import { clamdScan, ScannerUnavailableError, type ClamdConfig, type ClamdVerdict } from './clamav.js';
import { resourceLink } from './authz.js';
import { openDecrypted, removeObject } from './storage.js';

/** Antivirus orchestration: configuration, scanning, retries and quarantine. Never runs inside a transaction. */
export const clamavSettingSchema = z.object({
  enabled: z.boolean(),
  host: z.string().trim().min(1).max(253).regex(/^[A-Za-z0-9.\-:[\]]+$/, 'Nom d’hôte invalide'),
  port: z.number().int().min(1).max(65535),
  timeout_ms: z.number().int().min(500).max(600000),
}).strict();
export type ClamavSetting = z.infer<typeof clamavSettingSchema>;

export interface ScannerConfig extends ClamdConfig { source: 'settings' | 'env' }

const DEFAULT_TIMEOUT_MS = 60000;

/** Admin settings win over environment variables once they have been saved. */
export function clamavSetting(): ClamavSetting | null {
  return settingUpdatedAt('files.clamav') ? getSetting('files.clamav', clamavSettingSchema.nullable(), null) : null;
}

export function scannerConfig(): ScannerConfig | null {
  const saved = clamavSetting();
  if (saved) return saved.enabled ? { host: saved.host, port: saved.port, timeoutMs: saved.timeout_ms, source: 'settings' } : null;
  const host = process.env.CLAMAV_HOST?.trim();
  if (!host) return null;
  const port = Number(process.env.CLAMAV_PORT ?? 3310);
  const timeout = Number(process.env.CLAMAV_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  return {
    host,
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 3310,
    timeoutMs: Number.isFinite(timeout) && timeout >= 500 ? timeout : DEFAULT_TIMEOUT_MS,
    source: 'env',
  };
}

export function requireScan(): boolean {
  return getSetting('files.require_scan', z.boolean(), process.env.NODE_ENV === 'production');
}

/** Status given to a freshly stored file before (or instead of) scanning. */
export function initialScanStatus(skipScan = false): 'pending' | 'skipped' {
  if (skipScan) return 'skipped';
  return scannerConfig() || requireScan() ? 'pending' : 'skipped';
}

interface ScanRow {
  id: string; owner_id: string | null; purpose: string; original_name: string; storage_key: string; scan_status: string;
  scan_attempts: number; resource_type: string | null; resource_id: string | null; deleted_at: string | null; purged_at: string | null;
  quarantined_at: string | null;
}

const inflight = new Map<string, Promise<string>>();
const scheduled = new Set<Promise<void>>();

/** Test/ops helper: waits for background scans started by uploads. */
export async function settleScans() {
  while (inflight.size || scheduled.size) await Promise.allSettled([...inflight.values(), ...scheduled]);
}

function backoffMs(attempts: number) { return Math.min(3600000, 30000 * 2 ** Math.min(attempts, 7)); }

function adminIds(): string[] {
  return all<{ id: string }>("SELECT id FROM users WHERE role='admin' ORDER BY created_at LIMIT 50").map((row) => row.id);
}

/**
 * Quarantines a file: metadata is kept, the encrypted content is deleted, owner and admins are notified.
 * Used for antivirus detections and manual admin quarantine.
 */
export function quarantineFile(fileId: string, detail: string, options: { notifyAdmins?: boolean } = {}) {
  const row = transaction(() => {
    const file = one<ScanRow>('SELECT * FROM files WHERE id=?', fileId);
    if (!file || file.quarantined_at) return null;
    const at = now();
    run(`UPDATE files SET scan_status='infected',scan_detail=?,scanned_at=COALESCE(scanned_at,?),quarantined_at=?,next_scan_at=NULL WHERE id=?`,
      detail.slice(0, 300), at, at, fileId);
    const link = resourceLink(file.resource_type, file.resource_id);
    if (file.owner_id) {
      notify(file.owner_id, 'files.quarantined', 'Fichier mis en quarantaine',
        `« ${file.original_name} » a été bloqué par l’antivirus (${detail.slice(0, 120)}). Son contenu a été supprimé.`, link);
      publishToUser(file.owner_id, { type: 'files.scan', data: { id: fileId, scan_status: 'infected' } });
    }
    if (options.notifyAdmins !== false) {
      for (const adminId of adminIds()) {
        if (adminId === file.owner_id) continue;
        notify(adminId, 'files.quarantined_admin', 'Menace détectée dans un fichier',
          `« ${file.original_name} » (${file.purpose}) : ${detail.slice(0, 160)}. Le fichier est en quarantaine.`, '/admin/files');
      }
    }
    return file;
  });
  if (!row) return;
  try {
    removeObject(row.storage_key);
    run('UPDATE files SET purged_at=? WHERE id=?', now(), fileId);
  } catch (error) {
    // The cleanup job retries physical deletion of quarantined content.
    log.error('files.quarantine_purge_failed', { file_id: fileId, error });
  }
}

/** Scans one file and records the verdict. Returns the resulting scan status. Safe to call concurrently. */
export function scanFile(fileId: string, options: { force?: boolean } = {}): Promise<string> {
  const existing = inflight.get(fileId);
  if (existing) return existing;
  const work = runScan(fileId, options.force ?? false).finally(() => inflight.delete(fileId));
  inflight.set(fileId, work);
  return work;
}

async function runScan(fileId: string, force: boolean): Promise<string> {
  const file = one<ScanRow>('SELECT * FROM files WHERE id=?', fileId);
  if (!file || file.deleted_at || file.purged_at || file.quarantined_at) return file?.scan_status ?? 'missing';
  if (!force && !['pending', 'skipped'].includes(file.scan_status)) return file.scan_status;
  const config = scannerConfig();
  if (!config) {
    if (file.scan_status === 'pending' && !requireScan()) {
      run("UPDATE files SET scan_status='skipped',scan_detail='Aucun antivirus configuré',next_scan_at=NULL WHERE id=? AND scan_status='pending'", fileId);
      return 'skipped';
    }
    if (file.scan_status === 'pending') {
      run('UPDATE files SET next_scan_at=? WHERE id=?', new Date(Date.now() + backoffMs(file.scan_attempts)).toISOString(), fileId);
    }
    return file.scan_status;
  }

  const previous = file.scan_status;
  let verdict: ClamdVerdict;
  try {
    verdict = await clamdScan(config, openDecrypted(file.storage_key, file.id));
  } catch (error) {
    if (error instanceof ScannerUnavailableError) {
      const attempts = file.scan_attempts + 1;
      // Skipped files keep their status: they were already downloadable and will be retried by the job.
      run(`UPDATE files SET scan_status=CASE WHEN scan_status='skipped' AND ?=0 THEN 'skipped' ELSE 'pending' END,
        scan_attempts=?,next_scan_at=?,scan_detail=? WHERE id=? AND quarantined_at IS NULL`,
      force ? 1 : 0, attempts, new Date(Date.now() + backoffMs(attempts)).toISOString(), `Antivirus indisponible : ${error.message}`.slice(0, 300), fileId);
      log.warn('files.scanner_unavailable', { file_id: fileId, attempts, error: error.message });
      return one<{ scan_status: string }>('SELECT scan_status FROM files WHERE id=?', fileId)!.scan_status;
    }
    verdict = { status: 'error', detail: error instanceof Error ? error.message : 'Erreur inconnue', raw: '' };
  }

  if (verdict.status === 'infected') {
    log.warn('files.infected', { file_id: fileId, signature: verdict.signature, purpose: file.purpose });
    run('UPDATE files SET scan_attempts=scan_attempts+1 WHERE id=?', fileId);
    quarantineFile(fileId, verdict.signature);
    return 'infected';
  }
  const status = verdict.status === 'clean' ? 'clean' : 'error';
  const detail = verdict.status === 'error' ? verdict.detail.slice(0, 300) : '';
  transaction(() => {
    run(`UPDATE files SET scan_status=?,scan_detail=?,scanned_at=?,scan_attempts=scan_attempts+1,next_scan_at=NULL
      WHERE id=? AND quarantined_at IS NULL AND deleted_at IS NULL`, status, detail, now(), fileId);
    if (file.owner_id && previous !== status) publishToUser(file.owner_id, { type: 'files.scan', data: { id: fileId, scan_status: status } });
  });
  if (status === 'error') log.warn('files.scan_error', { file_id: fileId, detail });
  return status;
}

/** Background scan right after an upload (outside the request transaction). */
export function scanInBackground(fileId: string) {
  const task = new Promise<void>((resolve) => {
    setImmediate(() => {
      scanFile(fileId).catch((error) => log.error('files.scan_failed', { file_id: fileId, error })).finally(resolve);
    });
  });
  scheduled.add(task);
  void task.finally(() => scheduled.delete(task));
}

/** Job body: retries pending scans whose backoff elapsed, then scans files stored while no scanner was configured. */
export async function scanPendingFiles(limit = 25): Promise<{ scanned: number; statuses: Record<string, number> }> {
  const config = scannerConfig();
  const at = now();
  if (!config && !requireScan()) {
    // Scanning is neither configured nor required any more: queued files become downloadable.
    run(`UPDATE files SET scan_status='skipped',scan_detail='Aucun antivirus configuré',next_scan_at=NULL
      WHERE scan_status='pending' AND deleted_at IS NULL AND quarantined_at IS NULL`);
  }
  const pending = all<{ id: string }>(`SELECT id FROM files WHERE scan_status='pending' AND deleted_at IS NULL AND quarantined_at IS NULL
    AND (next_scan_at IS NULL OR next_scan_at<=?) ORDER BY created_at LIMIT ?`, at, limit);
  const skipped = config ? all<{ id: string }>(`SELECT id FROM files WHERE scan_status='skipped' AND deleted_at IS NULL AND purged_at IS NULL
    AND purpose NOT IN ('privacy_export') AND (next_scan_at IS NULL OR next_scan_at<=?) ORDER BY created_at LIMIT ?`, at, Math.max(0, limit - pending.length)) : [];
  const statuses: Record<string, number> = {};
  for (const { id } of [...pending, ...skipped]) {
    const status = await scanFile(id);
    statuses[status] = (statuses[status] ?? 0) + 1;
  }
  return { scanned: pending.length + skipped.length, statuses };
}
