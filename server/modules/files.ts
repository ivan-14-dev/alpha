import { Router, type Request, type Response } from 'express';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { all, one, run } from '../db.js';
import { audit, HttpError, now, param, requireAdmin, requireUser, type User } from '../core.js';
import { log } from '../platform/log.js';
import { rateLimit } from '../platform/rateLimit.js';
import { getSetting, setSetting } from '../platform/settings.js';
import { ownerDeletionBlocker, resourceLink } from '../files/authz.js';
import { clamdPing, clamdScan, clamdVersion, eicarTestString, ScannerUnavailableError } from '../files/clamav.js';
import { currentKeyFingerprint } from '../files/crypto.js';
import { cleanupFiles, rekeyFiles } from '../files/lifecycle.js';
import {
  allPurposes, defaultPolicies, describePolicy, fileKind, fileKinds, HARD_MAX_BYTES, kycRetentionDays, policyFor, policyOverrides,
  policyOverrideSchema, purposeLabels, purposeResource, uploadPurposes, userQuotaBytes, extensionOf,
} from '../files/policy.js';
import { clamavSetting, clamavSettingSchema, quarantineFile, requireScan, scanFile, scanInBackground, scannerConfig, scanPendingFiles } from '../files/scan.js';
import {
  canReadFile, contentAvailability, fileRow, logKycAccess, openFileStream, softDeleteFile, usedQuotaBytes, attachFile,
  type FileRow, type StoredFile,
} from '../files/service.js';
import { handleUpload } from '../files/upload.js';
import { removeObject } from '../files/storage.js';
import '../files/lifecycle.js';

/** V4 files module: encrypted uploads, antivirus-gated downloads, attachments and administration. */
const router = Router();

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const resourceIdPattern = /^[A-Za-z0-9_-]{1,64}$/;
const resourceTypes = [...new Set(Object.values(purposeResource))];
const DEFAULT_ADMIN_REASON = 'Consultation administrative';

function fileId(req: Request): string {
  const value = param(req);
  if (!uuid.test(value)) throw new HttpError(404, 'Fichier introuvable.');
  return value;
}

function adminReason(req: Request): string {
  const raw = typeof req.query.reason === 'string' ? req.query.reason : '';
  return raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200) || DEFAULT_ADMIN_REASON;
}

/** Readable, non-deleted row or 404 (existence of other users' files is never revealed). */
function readableRow(user: User, id: string): FileRow {
  const row = fileRow(id);
  if (!row || row.deleted_at || !canReadFile(user.id, row)) throw new HttpError(404, 'Fichier introuvable.');
  return row;
}

function canDelete(user: User, row: FileRow): boolean {
  if (row.deleted_at) return false;
  if (user.role === 'admin') return true;
  return row.owner_id === user.id && !ownerDeletionBlocker(row);
}

type RowWithOwner = FileRow & { owner_name?: string | null };

function publicFile(user: User, row: RowWithOwner) {
  const availability = contentAvailability(row);
  const inline = !!fileKind(row.detected_kind)?.inlineImage;
  const base = {
    id: row.id,
    owner_id: row.owner_id,
    owner_name: row.owner_name ?? null,
    purpose: row.purpose,
    purpose_label: purposeLabels[row.purpose] ?? row.purpose,
    original_name: row.original_name,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes,
    sha256: row.sha256,
    scan_status: row.scan_status,
    resource_type: row.resource_type,
    resource_id: row.resource_id,
    created_at: row.created_at,
    quarantined: !!row.quarantined_at,
    available: availability.ok,
    unavailable_reason: availability.ok ? null : availability.message,
    download_url: `/api/files/${row.id}/download`,
    preview_url: availability.ok && inline ? `/api/files/${row.id}/download?inline=1` : null,
    can_delete: canDelete(user, row),
    is_owner: row.owner_id === user.id,
  };
  if (user.role !== 'admin') return base;
  return {
    ...base,
    scan_detail: row.scan_detail,
    scanned_at: row.scanned_at,
    scan_attempts: row.scan_attempts,
    next_scan_at: row.next_scan_at,
    quarantined_at: row.quarantined_at,
    purged_at: row.purged_at,
    detected_kind: row.detected_kind,
    retain_until: row.retain_until,
    deleted_at: row.deleted_at,
    link: resourceLink(row.resource_type, row.resource_id),
  };
}

function withOwner(id: string): RowWithOwner | undefined {
  return one<RowWithOwner>('SELECT f.*,u.name AS owner_name FROM files f LEFT JOIN users u ON u.id=f.owner_id WHERE f.id=?', id);
}

/** Physical deletion right after a soft delete; the cleanup job retries on failure. */
function purgeNow(row: FileRow) {
  try {
    removeObject(row.storage_key);
    run('UPDATE files SET purged_at=? WHERE id=? AND purged_at IS NULL', now(), row.id);
  } catch (error) {
    log.error('files.purge_failed', { file_id: row.id, error });
  }
}

const signedIn = (req: Request, _res: Response, next: () => void) => { requireUser(req); next(); };
const userKey = (req: Request) => req.user?.id ?? 'anonymous';
const uploadLimit = rateLimit({ name: 'files.upload', limit: 60, windowMs: 3600000, key: userKey, message: 'Trop d’envois de fichiers. Réessayez dans une heure.' });
const downloadLimit = rateLimit({ name: 'files.download', limit: 600, windowMs: 600000, key: userKey, message: 'Trop de téléchargements. Réessayez dans quelques minutes.' });
const attachLimit = rateLimit({ name: 'files.attach', limit: 120, windowMs: 600000, key: userKey });

// ---------------------------------------------------------------------------------------------------------------
// Member endpoints
// ---------------------------------------------------------------------------------------------------------------

router.get('/policies', (req, res) => {
  const user = requireUser(req);
  const quota = userQuotaBytes();
  res.json({
    policies: uploadPurposes.map((purpose) => describePolicy(purpose)),
    quota: { limit_bytes: quota, used_bytes: usedQuotaBytes(user.id) },
    require_scan: requireScan(),
    scanner: !!scannerConfig(),
  });
});

router.post('/', signedIn, uploadLimit, async (req, res) => {
  const user = requireUser(req);
  const stored = await handleUpload(req, user);
  const row = withOwner(stored.id)!;
  res.status(201).json(publicFile(user, row));
  if (row.scan_status === 'pending') scanInBackground(row.id);
});

router.get('/', (req, res) => {
  const user = requireUser(req);
  const resourceType = typeof req.query.resource_type === 'string' ? req.query.resource_type : '';
  const resourceId = typeof req.query.resource_id === 'string' ? req.query.resource_id : '';
  if (!resourceType && !resourceId) {
    const rows = all<RowWithOwner>(`SELECT f.*,u.name AS owner_name FROM files f LEFT JOIN users u ON u.id=f.owner_id
      WHERE f.owner_id=? AND f.deleted_at IS NULL ORDER BY f.created_at DESC LIMIT 200`, user.id);
    res.json(rows.map((row) => publicFile(user, row)));
    return;
  }
  if (!resourceTypes.includes(resourceType) || !resourceIdPattern.test(resourceId)) throw new HttpError(400, 'Ressource invalide.');
  const rows = all<RowWithOwner>(`SELECT f.*,u.name AS owner_name FROM files f LEFT JOIN users u ON u.id=f.owner_id
    WHERE f.resource_type=? AND f.resource_id=? AND f.deleted_at IS NULL ORDER BY f.created_at`, resourceType, resourceId)
    .filter((row) => canReadFile(user.id, row));
  for (const row of rows) logKycAccess(user.id, row, 'list', adminReason(req));
  res.json(rows.map((row) => publicFile(user, row)));
});

// ---------------------------------------------------------------------------------------------------------------
// Administration (declared before /:id)
// ---------------------------------------------------------------------------------------------------------------

const admin = Router();

admin.get('/overview', (req, res) => {
  requireAdmin(req);
  const stats = all<{ purpose: string; scan_status: string; count: number; bytes: number }>(`SELECT purpose,scan_status,COUNT(*) AS count,
    COALESCE(SUM(size_bytes),0) AS bytes FROM files WHERE deleted_at IS NULL GROUP BY purpose,scan_status ORDER BY purpose,scan_status`);
  const totals = one<Record<string, number>>(`SELECT
    COUNT(*) FILTER (WHERE deleted_at IS NULL) AS active,
    COALESCE(SUM(size_bytes) FILTER (WHERE deleted_at IS NULL AND purged_at IS NULL),0) AS bytes,
    COUNT(*) FILTER (WHERE scan_status='pending' AND deleted_at IS NULL) AS pending,
    COUNT(*) FILTER (WHERE quarantined_at IS NOT NULL) AS quarantined,
    COUNT(*) FILTER (WHERE scan_status='error' AND deleted_at IS NULL) AS errors,
    COUNT(*) FILTER (WHERE deleted_at IS NOT NULL AND purged_at IS NULL) AS awaiting_purge,
    COUNT(*) FILTER (WHERE resource_type IS NULL AND deleted_at IS NULL) AS unattached
    FROM files`)!;
  const fingerprint = currentKeyFingerprint();
  const oldKeys = one<{ count: number }>(`SELECT COUNT(*) AS count FROM files WHERE purged_at IS NULL AND deleted_at IS NULL AND quarantined_at IS NULL
    AND (key_fingerprint IS NULL OR key_fingerprint<>?)`, fingerprint)!.count;
  const scanner = scannerConfig();
  const saved = clamavSetting();
  const overrides = policyOverrides();
  res.json({
    stats: stats.map((row) => ({ ...row, label: purposeLabels[row.purpose as keyof typeof purposeLabels] ?? row.purpose })),
    totals,
    scanner: scanner ? { configured: true, source: scanner.source, host: scanner.host, port: scanner.port, timeout_ms: scanner.timeoutMs } : { configured: false },
    clamav_setting: saved,
    clamav_env: process.env.CLAMAV_HOST ? { host: process.env.CLAMAV_HOST, port: Number(process.env.CLAMAV_PORT ?? 3310) } : null,
    require_scan: requireScan(),
    quota_bytes: userQuotaBytes(),
    hard_max_bytes: HARD_MAX_BYTES,
    kyc_retention_days: kycRetentionDays(),
    encryption: { algorithm: 'AES-256-GCM (segments de 64 Kio)', key_fingerprint: fingerprint, files_with_previous_key: oldKeys },
    policies: allPurposes.map((purpose) => ({
      ...describePolicy(purpose),
      default_max_bytes: defaultPolicies[purpose].max_bytes,
      default_kinds: defaultPolicies[purpose].kinds,
      kind_ids: policyFor(purpose).kinds,
      overridden: !!overrides[purpose],
      internal: !uploadPurposes.includes(purpose as (typeof uploadPurposes)[number]),
    })),
    kinds: fileKinds.map((kind) => ({ id: kind.id, label: kind.label, extensions: kind.extensions })),
  });
});

const adminListQuery = z.object({
  scan_status: z.enum(['pending', 'clean', 'infected', 'error', 'skipped']).optional(),
  purpose: z.enum(allPurposes).optional(),
  state: z.enum(['active', 'deleted', 'quarantined', 'unattached', 'all']).default('active'),
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
});

/** KYC names are personal data: masked in listings, the full metadata is only shown (and logged) on demand. */
function maskedName(admin: User, row: FileRow): string {
  if (row.purpose !== 'kyc_document' || row.owner_id === admin.id) return row.original_name;
  return `Pièce d’identité${extensionOf(row.original_name)}`;
}

admin.get('/files', (req, res) => {
  const user = requireAdmin(req);
  const query = adminListQuery.parse(req.query);
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (query.scan_status) { where.push('f.scan_status=?'); params.push(query.scan_status); }
  if (query.purpose) { where.push('f.purpose=?'); params.push(query.purpose); }
  if (query.state === 'active') where.push('f.deleted_at IS NULL');
  if (query.state === 'deleted') where.push('f.deleted_at IS NOT NULL');
  if (query.state === 'quarantined') where.push('f.quarantined_at IS NOT NULL');
  if (query.state === 'unattached') where.push('f.deleted_at IS NULL AND f.resource_type IS NULL');
  if (query.q) {
    where.push(`(f.id=? OR f.sha256=? OR lower(u.email)=lower(?) OR (f.purpose<>'kyc_document' AND f.original_name LIKE ? ESCAPE '\\'))`);
    params.push(query.q, query.q.toLowerCase(), query.q, `%${query.q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = one<{ count: number }>(`SELECT COUNT(*) AS count FROM files f LEFT JOIN users u ON u.id=f.owner_id ${clause}`, ...params)!.count;
  const rows = all<RowWithOwner & { owner_email: string | null }>(`SELECT f.*,u.name AS owner_name,u.email AS owner_email FROM files f
    LEFT JOIN users u ON u.id=f.owner_id ${clause} ORDER BY f.created_at DESC LIMIT ? OFFSET ?`, ...params, query.limit, query.offset);
  res.json({
    total,
    files: rows.map((row) => ({ ...publicFile(user, row), original_name: maskedName(user, row), owner_email: row.owner_email, deleted_at: row.deleted_at })),
  });
});

function adminRow(req: Request): FileRow {
  const row = fileRow(fileId(req));
  if (!row) throw new HttpError(404, 'Fichier introuvable.');
  return row;
}

admin.post('/files/:id/rescan', async (req, res) => {
  const user = requireAdmin(req);
  const row = adminRow(req);
  if (row.deleted_at || row.purged_at || row.quarantined_at) throw new HttpError(409, 'Ce fichier n’a plus de contenu à analyser.');
  if (!scannerConfig()) throw new HttpError(409, 'Aucun antivirus n’est configuré.');
  audit(user.id, 'files.rescan', 'file', row.id, row.scan_status);
  const status = await scanFile(row.id, { force: true });
  res.json(publicFile(user, withOwner(row.id)!));
  log.info('files.rescan', { file_id: row.id, status });
});

const quarantineBody = z.object({ reason: z.string().trim().min(3).max(300) }).strict();

admin.post('/files/:id/quarantine', (req, res) => {
  const user = requireAdmin(req);
  const row = adminRow(req);
  const { reason } = quarantineBody.parse(req.body);
  if (row.quarantined_at) throw new HttpError(409, 'Ce fichier est déjà en quarantaine.');
  if (row.deleted_at) throw new HttpError(409, 'Ce fichier est supprimé.');
  quarantineFile(row.id, `Quarantaine manuelle : ${reason}`, { notifyAdmins: false });
  audit(user.id, 'files.quarantine', 'file', row.id, reason);
  res.json(publicFile(user, withOwner(row.id)!));
});

const adminDeleteBody = z.object({ reason: z.string().trim().max(300).optional() }).strict();

admin.delete('/files/:id', (req, res) => {
  const user = requireAdmin(req);
  const row = adminRow(req);
  const { reason } = adminDeleteBody.parse(req.body ?? {});
  if (row.deleted_at) throw new HttpError(409, 'Ce fichier est déjà supprimé.');
  softDeleteFile(row.id, user.id);
  audit(user.id, 'files.delete', 'file', row.id, `${row.purpose}${reason ? ` : ${reason}` : ''}`);
  purgeNow(row);
  res.status(204).end();
});

const settingsBody = z.object({
  clamav: clamavSettingSchema.nullable().optional(),
  require_scan: z.boolean().optional(),
  quota_bytes: z.number().int().min(1024 * 1024).max(1024 * 1024 * 1024 * 1024).optional(),
  policies: policyOverrideSchema.optional(),
  kyc_retention_days: z.number().int().min(30).max(36500).optional(),
}).strict();

admin.put('/settings', (req, res) => {
  const user = requireAdmin(req);
  const body = settingsBody.parse(req.body);
  const changed: string[] = [];
  if (body.clamav !== undefined) { setSetting('files.clamav', body.clamav, user.id); changed.push(`clamav=${body.clamav ? `${body.clamav.enabled ? 'on' : 'off'}@${body.clamav.host}:${body.clamav.port}` : 'env'}`); }
  if (body.require_scan !== undefined) { setSetting('files.require_scan', body.require_scan, user.id); changed.push(`require_scan=${body.require_scan}`); }
  if (body.quota_bytes !== undefined) { setSetting('files.quota', { bytes_per_user: body.quota_bytes }, user.id); changed.push(`quota=${body.quota_bytes}`); }
  if (body.policies !== undefined) { setSetting('files.policies', body.policies, user.id); changed.push(`policies=${Object.keys(body.policies).join('|') || 'defaut'}`); }
  if (body.kyc_retention_days !== undefined) { setSetting('files.kyc_retention_days', body.kyc_retention_days, user.id); changed.push(`kyc_retention_days=${body.kyc_retention_days}`); }
  if (!changed.length) throw new HttpError(400, 'Aucun réglage à modifier.');
  audit(user.id, 'files.settings', 'setting', 'files', changed.join(', ').slice(0, 500));
  res.json({ ok: true, changed });
});

const testBody = z.object({ host: z.string().trim().min(1).max(253).regex(/^[A-Za-z0-9.\-:[\]]+$/), port: z.number().int().min(1).max(65535), timeout_ms: z.number().int().min(500).max(60000).optional() }).strict();

admin.post('/clamav/test', async (req, res) => {
  const user = requireAdmin(req);
  const override = req.body && Object.keys(req.body).length ? testBody.parse(req.body) : null;
  const configured = scannerConfig();
  const config = override ? { host: override.host, port: override.port, timeoutMs: override.timeout_ms ?? 15000 } : configured;
  if (!config) throw new HttpError(409, 'Aucun antivirus n’est configuré : renseignez l’hôte et le port de clamd.');
  audit(user.id, 'files.clamav_test', 'setting', 'files.clamav', `${config.host}:${config.port}`);
  const started = Date.now();
  try {
    const ping = await clamdPing(config);
    const version = await clamdVersion(config).catch(() => '');
    const verdict = await clamdScan(config, Buffer.from(eicarTestString(), 'latin1'));
    const ok = verdict.status === 'infected';
    res.json({
      ok, ping, version, verdict, latency_ms: Date.now() - started, target: `${config.host}:${config.port}`,
      message: ok ? `Antivirus opérationnel : EICAR détecté (${verdict.status === 'infected' ? verdict.signature : ''}).`
        : verdict.status === 'clean' ? 'Le fichier de test EICAR n’a PAS été détecté : vérifiez les signatures (freshclam).'
          : `Réponse inattendue de clamd : ${verdict.detail}`,
    });
  } catch (error) {
    const message = error instanceof ScannerUnavailableError ? error.message : 'Erreur inattendue pendant le test.';
    res.status(502).json({ ok: false, error: `Antivirus injoignable (${config.host}:${config.port}) : ${message}`, latency_ms: Date.now() - started });
  }
});

const accessLogQuery = z.object({
  file_id: z.string().regex(uuid).optional(),
  actor_id: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

admin.get('/access-log', (req, res) => {
  requireAdmin(req);
  const query = accessLogQuery.parse(req.query);
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (query.file_id) { where.push('l.file_id=?'); params.push(query.file_id); }
  if (query.actor_id) { where.push('l.actor_id=?'); params.push(query.actor_id); }
  res.json(all(`SELECT l.id,l.file_id,l.actor_id,a.name AS actor_name,a.email AS actor_email,l.action,l.reason,l.at,
    f.owner_id,o.name AS owner_name,f.purpose FROM file_access_log l
    LEFT JOIN users a ON a.id=l.actor_id LEFT JOIN files f ON f.id=l.file_id LEFT JOIN users o ON o.id=f.owner_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY l.at DESC LIMIT ?`, ...params, query.limit));
});

admin.post('/scan-pending', async (req, res) => {
  const user = requireAdmin(req);
  audit(user.id, 'files.scan_pending', 'job', 'files.scan');
  res.json(await scanPendingFiles(100));
});

admin.post('/cleanup', async (req, res) => {
  const user = requireAdmin(req);
  audit(user.id, 'files.cleanup', 'job', 'files.cleanup');
  res.json(await cleanupFiles());
});

admin.post('/rekey', async (req, res) => {
  const user = requireAdmin(req);
  audit(user.id, 'files.rekey', 'job', 'files.rekey');
  res.json(await rekeyFiles(100));
});

router.use('/admin', admin);

// ---------------------------------------------------------------------------------------------------------------
// Single file
// ---------------------------------------------------------------------------------------------------------------

router.get('/:id', (req, res) => {
  const user = requireUser(req);
  const row = readableRow(user, fileId(req));
  logKycAccess(user.id, row, 'metadata', adminReason(req));
  res.json(publicFile(user, withOwner(row.id)!));
});

/** RFC 6266 / RFC 5987 header with an ASCII fallback. */
function contentDisposition(type: 'attachment' | 'inline', name: string): string {
  const fallback = name.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/["\\%;]/g, '_').trim() || 'fichier';
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

router.get('/:id/download', signedIn, downloadLimit, async (req, res) => {
  const user = requireUser(req);
  const row = readableRow(user, fileId(req));
  const availability = contentAvailability(row);
  if (!availability.ok) throw new HttpError(availability.status, availability.message);
  const kind = fileKind(row.detected_kind);
  const inline = req.query.inline === '1' && !!kind?.inlineImage;
  const stream = openFileStream(row.id);
  logKycAccess(user.id, row, 'download', adminReason(req));
  res.status(200);
  res.setHeader('Content-Type', inline ? kind!.mime : 'application/octet-stream');
  res.setHeader('Content-Disposition', contentDisposition(inline ? 'inline' : 'attachment', row.original_name));
  res.setHeader('Content-Length', String(row.size_bytes));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Download-Options', 'noopen');
  res.setHeader('X-File-Sha256', row.sha256);
  try {
    await pipeline(stream, res);
  } catch (error) {
    if (!res.writableEnded && (error as NodeJS.ErrnoException)?.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
      log.error('files.download_failed', { file_id: row.id, error });
    }
    res.destroy();
  }
});

const attachBody = z.object({ resource_type: z.enum(resourceTypes as [string, ...string[]]), resource_id: z.string().regex(resourceIdPattern) }).strict();

router.post('/:id/attach', signedIn, attachLimit, (req, res) => {
  const user = requireUser(req);
  const id = fileId(req);
  const body = attachBody.parse(req.body);
  readableRow(user, id);
  const attached: StoredFile = attachFile(id, user.id, body.resource_type, body.resource_id);
  res.json(publicFile(user, withOwner(attached.id)!));
});

router.delete('/:id', (req, res) => {
  const user = requireUser(req);
  const row = readableRow(user, fileId(req));
  const isAdminUser = user.role === 'admin';
  if (row.owner_id !== user.id && !isAdminUser) throw new HttpError(403, 'Seul le propriétaire du fichier peut le supprimer.');
  if (row.owner_id === user.id && !isAdminUser) {
    const blocker = ownerDeletionBlocker(row);
    if (blocker) throw new HttpError(409, blocker);
  }
  softDeleteFile(row.id, user.id);
  if (row.owner_id !== user.id) audit(user.id, 'files.delete', 'file', row.id, row.purpose);
  purgeNow(row);
  res.status(204).end();
});

export default router;
