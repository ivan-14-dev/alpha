import { Readable } from 'node:stream';
import { all, one, run, transaction } from '../db.js';
import { HttpError, id, now } from '../core.js';
import { assertCanUploadTo, canReadFileImpl, isAdmin } from './authz.js';
import { allPurposes, detectKind, extensionOf, HARD_MAX_BYTES, internalPurposes, sanitizeFilename } from './policy.js';
import { initialScanStatus, requireScan, scanInBackground } from './scan.js';
import { commitTemp, newStorageKey, openDecrypted, readDecrypted, removeObject, removeQuietly, writeEncryptedTemp } from './storage.js';
import { sha256Hex } from '../platform/secrets.js';

/**
 * File storage contract. OWNER: files module (encrypted storage, antivirus, upload routes, authorization).
 * Other modules (compliance KYC, sandbox, privacy export, testing, marketplace) only use these functions.
 */
export type FilePurpose = 'kyc_document' | 'mission_attachment' | 'campaign_build' | 'listing_delivery' | 'message_attachment' | 'privacy_export' | 'sandbox_artifact';

export interface StoredFile {
  id: string;
  owner_id: string | null;
  purpose: FilePurpose;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  scan_status: 'pending' | 'clean' | 'infected' | 'error' | 'skipped';
  resource_type: string | null;
  resource_id: string | null;
  created_at: string;
}

/** Full row, including lifecycle columns that are never sent to non-admin clients. */
export interface FileRow extends StoredFile {
  storage_key: string;
  encrypted: number;
  scan_detail: string;
  scanned_at: string | null;
  detected_kind: string;
  key_fingerprint: string | null;
  scan_attempts: number;
  next_scan_at: string | null;
  quarantined_at: string | null;
  purged_at: string | null;
  attached_at: string | null;
  retain_until: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
}

const columns = 'id,owner_id,purpose,original_name,mime_type,size_bytes,sha256,scan_status,resource_type,resource_id,created_at';

/** No authorization check. Returns null for deleted files. */
export function getFile(fileId: string): StoredFile | null {
  return one<StoredFile>(`SELECT ${columns} FROM files WHERE id=? AND deleted_at IS NULL`, fileId) ?? null;
}

export function filesFor(resourceType: string, resourceId: string): StoredFile[] {
  return all<StoredFile>(`SELECT ${columns} FROM files WHERE resource_type=? AND resource_id=? AND deleted_at IS NULL ORDER BY created_at`, resourceType, resourceId);
}

/** Includes soft-deleted rows. No authorization check. */
export function fileRow(fileId: string): FileRow | null {
  return one<FileRow>('SELECT * FROM files WHERE id=?', fileId) ?? null;
}

/** Purpose-specific read authorization (owner, resource participants, admins). */
export function canReadFile(userId: string, file: StoredFile): boolean {
  return canReadFileImpl(userId, file);
}

export type Availability = { ok: true } | { ok: false; status: number; message: string };

/** Whether the decrypted content may be served (antivirus gate, quarantine, purge). */
export function contentAvailability(file: FileRow): Availability {
  if (file.deleted_at) return { ok: false, status: 404, message: 'Fichier introuvable.' };
  if (file.quarantined_at || file.scan_status === 'infected') return { ok: false, status: 410, message: 'Fichier infecté — mis en quarantaine. Son contenu a été supprimé.' };
  if (file.purged_at) return { ok: false, status: 410, message: 'Le contenu de ce fichier a été supprimé.' };
  if (internalPurposes.has(file.purpose)) return { ok: true };
  if (file.scan_status === 'clean') return { ok: true };
  if (file.scan_status === 'skipped' && !requireScan()) return { ok: true };
  if (file.scan_status === 'error') return { ok: false, status: 409, message: 'L’analyse antivirus de ce fichier a échoué : il ne peut pas être téléchargé. Un administrateur peut relancer l’analyse.' };
  if (file.scan_status === 'skipped') return { ok: false, status: 409, message: 'Ce fichier n’a pas encore été analysé par l’antivirus. Réessayez plus tard.' };
  return { ok: false, status: 409, message: 'Analyse antivirus en cours. Réessayez dans quelques instants.' };
}

export type AccessAction = 'metadata' | 'download' | 'read' | 'list';

/** Records an administrator access to a KYC document (no-op for owners and other purposes). */
export function logKycAccess(actorId: string | null, file: Pick<StoredFile, 'id' | 'purpose' | 'owner_id'>, action: AccessAction, reason: string) {
  if (file.purpose !== 'kyc_document' || !actorId || actorId === file.owner_id) return;
  run('INSERT INTO file_access_log(id,file_id,actor_id,action,reason,at) VALUES (?,?,?,?,?,?)',
    id(), file.id, actorId, action, reason.trim().slice(0, 500) || 'Consultation administrative', now());
}

/** Decrypted plaintext stream (authorization must be checked by the caller; the antivirus gate is enforced here). */
export function openFileStream(fileId: string): Readable {
  const file = fileRow(fileId);
  if (!file) throw new HttpError(404, 'Fichier introuvable.');
  const availability = contentAvailability(file);
  if (!availability.ok) throw new HttpError(availability.status, availability.message);
  return openDecrypted(file.storage_key, file.id);
}

const MAX_BUFFER_BYTES = 512 * 1024 * 1024;

/**
 * Decrypted content. Refuses files whose scan is not clean (unless the purpose is internal).
 * Pass `access` when reading on behalf of an administrator so KYC consultations are logged.
 */
export async function readFileBuffer(fileId: string, access?: { actorId: string; reason: string }): Promise<Buffer> {
  const file = fileRow(fileId);
  if (!file) throw new HttpError(404, 'Fichier introuvable.');
  const availability = contentAvailability(file);
  if (!availability.ok) throw new HttpError(availability.status, availability.message);
  if (access) logKycAccess(access.actorId, file, 'read', access.reason);
  const data = await readDecrypted(file.storage_key, file.id, MAX_BUFFER_BYTES);
  if (sha256Hex(data) !== file.sha256) throw new HttpError(500, 'Intégrité du fichier compromise.');
  return data;
}

const safeMime = /^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,127}$/;

/** Stores server-generated content (exports, sandbox logs/artifacts). Async: call OUTSIDE transactions. */
export async function storeBuffer(input: {
  ownerId: string | null; purpose: FilePurpose; name: string; mimeType: string; data: Buffer;
  resourceType?: string; resourceId?: string; skipScan?: boolean;
}): Promise<StoredFile> {
  if (!allPurposes.includes(input.purpose)) throw new Error(`Usage de fichier inconnu : ${input.purpose}`);
  if (input.data.length > HARD_MAX_BYTES) throw new HttpError(413, 'Fichier trop volumineux.');
  if (!input.resourceType !== !input.resourceId) throw new Error('resourceType et resourceId vont ensemble.');
  const fileId = id();
  const storageKey = newStorageKey();
  const name = sanitizeFilename(input.name);
  const mime = safeMime.test(input.mimeType.toLowerCase()) ? input.mimeType.toLowerCase() : 'application/octet-stream';
  const written = await writeEncryptedTemp(Readable.from([input.data]), fileId, HARD_MAX_BYTES, () => new HttpError(413, 'Fichier trop volumineux.'));
  try { commitTemp(written.temp, storageKey); } catch (error) { removeQuietly(written.temp); throw error; }
  const status = initialScanStatus(input.skipScan);
  try {
    transaction(() => {
      run(`INSERT INTO files(id,owner_id,purpose,original_name,mime_type,size_bytes,sha256,storage_key,encrypted,scan_status,scan_detail,
        resource_type,resource_id,attached_at,detected_kind,key_fingerprint,created_at) VALUES (?,?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,?)`,
      fileId, input.ownerId, input.purpose, name, mime, written.size, written.sha256, storageKey, status,
      status === 'skipped' ? (input.skipScan ? 'Contenu interne non analysé' : 'Aucun antivirus configuré') : '',
      input.resourceType || null, input.resourceId || null, input.resourceType ? now() : null,
      detectKind(written.head, written.tail, written.size, extensionOf(name)), written.fingerprint, now());
    });
  } catch (error) {
    removeObject(storageKey);
    throw error;
  }
  if (status === 'pending') scanInBackground(fileId);
  return getFile(fileId)!;
}

/** Links an uploaded file (owned by `ownerId`) to a resource. Synchronous, call inside the caller's transaction. */
export function attachFile(fileId: string, ownerId: string, resourceType: string, resourceId: string): StoredFile {
  return transaction(() => {
    const file = fileRow(fileId);
    if (!file || file.deleted_at) throw new HttpError(404, 'Fichier introuvable.');
    if (file.owner_id !== ownerId) throw new HttpError(403, 'Vous ne pouvez rattacher que vos propres fichiers.');
    if (file.quarantined_at || file.scan_status === 'infected') throw new HttpError(409, 'Ce fichier est en quarantaine et ne peut pas être rattaché.');
    if (file.resource_type) {
      if (file.resource_type === resourceType && file.resource_id === resourceId) return getFile(fileId)!;
      throw new HttpError(409, 'Ce fichier est déjà rattaché à une autre ressource.');
    }
    assertCanUploadTo(ownerId, file.purpose, resourceType, resourceId);
    const changed = Number(run('UPDATE files SET resource_type=?,resource_id=?,attached_at=? WHERE id=? AND resource_type IS NULL AND deleted_at IS NULL',
      resourceType, resourceId, now(), fileId).changes);
    if (!changed) throw new HttpError(409, 'Ce fichier est déjà rattaché à une autre ressource.');
    return getFile(fileId)!;
  });
}

/** Soft delete (content is purged by the `files.cleanup` job). Authorization is the caller's job. */
export function softDeleteFile(fileId: string, actorId: string | null): boolean {
  return Number(run('UPDATE files SET deleted_at=?,deleted_by=? WHERE id=? AND deleted_at IS NULL', now(), actorId, fileId).changes) > 0;
}

/** Bytes counted against a member's storage quota (server-generated content is excluded). */
export function usedQuotaBytes(userId: string): number {
  return one<{ used: number }>(`SELECT COALESCE(SUM(size_bytes),0) AS used FROM files WHERE owner_id=? AND deleted_at IS NULL
    AND purged_at IS NULL AND purpose NOT IN ('privacy_export','sandbox_artifact')`, userId)!.used;
}

export { isAdmin };
