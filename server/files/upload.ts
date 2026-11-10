import busboy from 'busboy';
import type { Request } from 'express';
import { HttpError, id, now, type User } from '../core.js';
import { run, transaction } from '../db.js';
import { assertCanUploadTo } from './authz.js';
import { extensionOf, HARD_MAX_BYTES, kindForExtension, fileKind, policyFor, purposeResource, sanitizeFilename, uploadPurposes, userQuotaBytes, verifyContent } from './policy.js';
import { initialScanStatus } from './scan.js';
import { getFile, usedQuotaBytes, type FilePurpose, type StoredFile } from './service.js';
import { commitTemp, newStorageKey, removeObject, removeQuietly, writeEncryptedTemp, type WrittenObject } from './storage.js';

/**
 * Streaming multipart upload: fields (`purpose`, optional `resource_type` + `resource_id`) MUST precede the
 * single `file` part so purpose, authorization, quota and size limits are checked before any byte is stored.
 * Plaintext is never written to disk: it is hashed, sniffed and encrypted on the fly into a 0600 temp file.
 */
const MULTIPART_OVERHEAD = 64 * 1024;
const allowedFields = new Set(['purpose', 'resource_type', 'resource_id']);
const idPattern = /^[A-Za-z0-9_-]{1,64}$/;

interface Prepared {
  fileId: string;
  purpose: FilePurpose;
  resourceType: string | null;
  resourceId: string | null;
  name: string;
  extension: string;
  kindId: string;
  limit: number;
  quotaRemaining: number;
  policyMax: number;
}

function prepare(user: User, fields: Record<string, string>, filename: string): Prepared {
  const purpose = fields.purpose as FilePurpose | undefined;
  if (!purpose) throw new HttpError(400, 'Le champ « purpose » doit être envoyé avant le fichier.');
  if (!(uploadPurposes as string[]).includes(purpose)) throw new HttpError(400, 'Usage de fichier inconnu ou réservé à la plateforme.');
  const resourceType = fields.resource_type?.trim() || null;
  const resourceId = fields.resource_id?.trim() || null;
  if (!resourceType !== !resourceId) throw new HttpError(400, 'Indiquez à la fois resource_type et resource_id, ou aucun des deux.');
  if (resourceType && resourceType !== purposeResource[purpose]) throw new HttpError(400, 'Ce type de ressource ne correspond pas à l’usage du fichier.');
  if (resourceId && !idPattern.test(resourceId)) throw new HttpError(400, 'Identifiant de ressource invalide.');
  if (resourceType && resourceId) assertCanUploadTo(user.id, purpose, resourceType, resourceId);

  const name = sanitizeFilename(filename || '');
  const extension = extensionOf(name);
  const policy = policyFor(purpose);
  const kind = kindForExtension(extension, policy.kinds);
  if (!kind) {
    const accepted = policy.kinds.flatMap((kindId) => fileKind(kindId)?.extensions ?? []).join(', ');
    throw new HttpError(415, `Format non accepté pour cet usage. Formats autorisés : ${accepted}.`);
  }
  const quotaRemaining = Math.max(0, userQuotaBytes() - usedQuotaBytes(user.id));
  if (quotaRemaining <= 0) throw new HttpError(413, 'Votre quota de stockage est atteint. Supprimez des fichiers avant d’en ajouter.');
  return {
    fileId: id(), purpose, resourceType, resourceId, name, extension, kindId: kind.id,
    limit: Math.min(policy.max_bytes, quotaRemaining), quotaRemaining, policyMax: policy.max_bytes,
  };
}

function limitError(prepared: Prepared) {
  if (prepared.quotaRemaining < prepared.policyMax) return new HttpError(413, 'Ce fichier dépasse votre quota de stockage restant.');
  const megabytes = Math.round(prepared.policyMax / 1024 / 1024 * 10) / 10;
  return new HttpError(413, `Fichier trop volumineux : ${megabytes} Mo maximum pour cet usage.`);
}

/** Parses the multipart body and returns the encrypted temp object (not yet committed). */
function receive(req: Request, user: User): Promise<{ prepared: Prepared; written: WrittenObject }> {
  return new Promise((resolve, reject) => {
    const fields: Record<string, string> = {};
    let fileSeen = false;
    let settled = false;
    let writing: Promise<{ prepared: Prepared; written: WrittenObject }> | null = null;
    let parser: busboy.Busboy;
    try {
      parser = busboy({
        headers: req.headers,
        defParamCharset: 'utf8',
        limits: { fields: 8, fieldSize: 256, fieldNameSize: 32, files: 2, parts: 10, fileSize: HARD_MAX_BYTES, headerPairs: 20 },
      });
    } catch {
      reject(new HttpError(400, 'Formulaire multipart invalide.'));
      return;
    }
    let activeStream: NodeJS.ReadableStream & { destroy(error?: Error): void } | null = null;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      req.unpipe(parser);
      // Drain the rest of the body so the client receives the error response instead of a reset.
      req.resume();
      const failure = error instanceof HttpError ? error : new HttpError(400, 'Envoi du fichier interrompu ou invalide.');
      if (!writing) { reject(failure); return; }
      // Abort the encryption pipeline and only answer once its temp file is gone. Destroying with an error matters:
      // on Node 22/24 a source destroyed without one after push(null) leaves stream.pipeline waiting for 'end' forever.
      activeStream?.destroy(failure);
      writing.then(({ written }) => removeQuietly(written.temp), () => undefined).finally(() => reject(failure));
    };
    parser.on('field', (name, value, info) => {
      if (!allowedFields.has(name)) return fail(new HttpError(400, `Champ inconnu : ${name.slice(0, 32)}.`));
      if (info.nameTruncated || info.valueTruncated) return fail(new HttpError(400, 'Champ de formulaire trop long.'));
      if (fileSeen) return fail(new HttpError(400, 'Les champs doivent être envoyés avant le fichier.'));
      if (name in fields) return fail(new HttpError(400, `Champ en double : ${name}.`));
      fields[name] = value;
    });
    parser.on('file', (name, stream, info) => {
      if (settled) { stream.resume(); return; }
      if (name !== 'file' || fileSeen) { stream.resume(); fail(new HttpError(400, 'Envoyez exactement un fichier dans le champ « file ».')); return; }
      fileSeen = true;
      let prepared: Prepared;
      try { prepared = prepare(user, fields, info.filename ?? ''); } catch (error) { stream.resume(); fail(error); return; }
      stream.on('limit', () => stream.destroy(limitError(prepared)));
      activeStream = stream;
      writing = writeEncryptedTemp(stream, prepared.fileId, prepared.limit, () => limitError(prepared)).then((written) => ({ prepared, written }));
      writing.catch(fail);
    });
    parser.on('filesLimit', () => fail(new HttpError(400, 'Un seul fichier par envoi.')));
    parser.on('fieldsLimit', () => fail(new HttpError(400, 'Trop de champs dans le formulaire.')));
    parser.on('partsLimit', () => fail(new HttpError(400, 'Trop de parties dans le formulaire.')));
    parser.on('error', () => fail(new HttpError(400, 'Formulaire multipart invalide.')));
    parser.on('close', () => {
      if (settled) return;
      if (!fileSeen || !writing) { fail(new HttpError(400, 'Aucun fichier reçu (champ « file »).')); return; }
      writing.then((result) => {
        if (settled) { removeQuietly(result.written.temp); return; }
        settled = true;
        resolve(result);
      }, fail);
    });
    req.once('close', () => { if (!req.complete) fail(new HttpError(400, 'Envoi interrompu.')); });
    req.pipe(parser);
  });
}

/** Full upload: receive, verify content, enforce quota atomically, commit, insert, schedule the scan. */
export async function handleUpload(req: Request, user: User): Promise<StoredFile> {
  if (!/^multipart\/form-data/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'Envoyez le fichier en multipart/form-data.');
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > HARD_MAX_BYTES + MULTIPART_OVERHEAD) throw new HttpError(413, 'Fichier trop volumineux.');
  const { prepared, written } = await receive(req, user);
  const storageKey = newStorageKey();
  try {
    const kind = fileKind(prepared.kindId)!;
    const verdict = verifyContent(kind, written.head, written.tail, written.size);
    if (!verdict.ok) throw new HttpError(415, verdict.reason!);
    if (written.size === 0) throw new HttpError(400, 'Le fichier est vide.');
    commitTemp(written.temp, storageKey);
  } catch (error) {
    removeQuietly(written.temp);
    throw error;
  }
  const status = initialScanStatus();
  try {
    transaction(() => {
      // Authorization and quota are re-checked under the write lock (concurrent uploads, state changes).
      if (prepared.resourceType && prepared.resourceId) assertCanUploadTo(user.id, prepared.purpose, prepared.resourceType, prepared.resourceId);
      if (usedQuotaBytes(user.id) + written.size > userQuotaBytes()) throw new HttpError(413, 'Ce fichier dépasse votre quota de stockage restant.');
      const at = now();
      run(`INSERT INTO files(id,owner_id,purpose,original_name,mime_type,size_bytes,sha256,storage_key,encrypted,scan_status,scan_detail,
        resource_type,resource_id,attached_at,detected_kind,key_fingerprint,created_at) VALUES (?,?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,?)`,
      prepared.fileId, user.id, prepared.purpose, prepared.name, fileKind(prepared.kindId)!.mime, written.size, written.sha256, storageKey,
      status, status === 'skipped' ? 'Aucun antivirus configuré' : '', prepared.resourceType, prepared.resourceId,
      prepared.resourceType ? at : null, prepared.kindId, written.fingerprint, at);
    });
  } catch (error) {
    removeObject(storageKey);
    throw error;
  }
  return getFile(prepared.fileId)!;
}
