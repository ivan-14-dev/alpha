import { all, one, run, transaction } from '../db.js';
import { now } from '../core.js';
import { log } from '../platform/log.js';
import { registerJob } from '../platform/jobs.js';
import { registerPersonalData } from '../platform/privacy.js';
import { currentKeyFingerprint } from './crypto.js';
import { extensionOf, HARD_MAX_BYTES, kycRetentionDays } from './policy.js';
import { scanPendingFiles } from './scan.js';
import { commitTemp, listObjectKeys, newStorageKey, objectExists, openDecrypted, purgeTempFiles, removeObject, removeQuietly, writeEncryptedTemp } from './storage.js';

const HOUR = 3600000;
const DAY = 24 * HOUR;

export const retention = {
  unattachedUploadMs: DAY,
  unattachedKycMs: 30 * DAY,
  privacyExportMs: 7 * DAY,
  tempFileMs: HOUR,
  orphanObjectMs: 6 * HOUR,
};

export interface CleanupReport {
  unattached: number;
  unattached_kyc: number;
  privacy_exports: number;
  kyc_expired: number;
  purged: number;
  temp_files: number;
  orphans: number;
}

/**
 * Retention and physical deletion. Soft deletes are transactional; physical deletion happens afterwards
 * and is idempotent (`purged_at` is only set once the encrypted object is gone).
 */
export async function cleanupFiles(reference = Date.now()): Promise<CleanupReport> {
  const at = new Date(reference).toISOString();
  const before = (ms: number) => new Date(reference - ms).toISOString();
  const report = transaction(() => ({
    unattached: Number(run(`UPDATE files SET deleted_at=?,deleted_by=NULL WHERE deleted_at IS NULL AND resource_type IS NULL
      AND purpose IN ('mission_attachment','campaign_build','listing_delivery','message_attachment') AND created_at<?`,
    at, before(retention.unattachedUploadMs)).changes),
    unattached_kyc: Number(run(`UPDATE files SET deleted_at=?,deleted_by=NULL WHERE deleted_at IS NULL AND resource_type IS NULL
      AND purpose='kyc_document' AND created_at<?`, at, before(retention.unattachedKycMs)).changes),
    privacy_exports: Number(run(`UPDATE files SET deleted_at=?,deleted_by=NULL WHERE deleted_at IS NULL AND purpose='privacy_export' AND created_at<?`,
      at, before(retention.privacyExportMs)).changes),
    kyc_expired: Number(run(`UPDATE files SET deleted_at=?,deleted_by=NULL WHERE deleted_at IS NULL AND purpose='kyc_document'
      AND retain_until IS NOT NULL AND retain_until<?`, at, at).changes),
  }));

  let purged = 0;
  const toPurge = all<{ id: string; storage_key: string }>(`SELECT id,storage_key FROM files WHERE purged_at IS NULL
    AND (deleted_at IS NOT NULL OR quarantined_at IS NOT NULL) ORDER BY COALESCE(deleted_at,quarantined_at) LIMIT 500`);
  for (const file of toPurge) {
    try {
      removeObject(file.storage_key);
      run('UPDATE files SET purged_at=? WHERE id=? AND purged_at IS NULL', now(), file.id);
      purged += 1;
    } catch (error) {
      log.error('files.purge_failed', { file_id: file.id, error });
    }
  }

  const tempFiles = purgeTempFiles(retention.tempFileMs);
  // Objects without a row (crash between commit and insert, rekey leftovers) are removed after a grace period.
  let orphans = 0;
  for (const key of listObjectKeys(retention.orphanObjectMs)) {
    if (one('SELECT 1 FROM files WHERE storage_key=?', key)) continue;
    removeObject(key);
    orphans += 1;
  }
  const result = { ...report, purged, temp_files: tempFiles, orphans };
  if (Object.values(result).some(Boolean)) log.info('files.cleanup', { ...result });
  return result;
}

/**
 * Re-encrypts files written with a previous master key (after rotating ALPHA_SECRETS_KEY and moving the old key
 * to ALPHA_SECRETS_KEY_PREVIOUS). Writes a new object, swaps the storage key atomically, then deletes the old object.
 */
export async function rekeyFiles(limit = 20): Promise<{ rekeyed: number; failed: number; remaining: number }> {
  const fingerprint = currentKeyFingerprint();
  const rows = all<{ id: string; storage_key: string; sha256: string }>(`SELECT id,storage_key,sha256 FROM files WHERE purged_at IS NULL
    AND deleted_at IS NULL AND quarantined_at IS NULL AND (key_fingerprint IS NULL OR key_fingerprint<>?) ORDER BY created_at LIMIT ?`, fingerprint, limit);
  let rekeyed = 0;
  let failed = 0;
  for (const row of rows) {
    if (!objectExists(row.storage_key)) continue;
    const storageKey = newStorageKey();
    let temp: string | null = null;
    try {
      const written = await writeEncryptedTemp(openDecrypted(row.storage_key, row.id), row.id, HARD_MAX_BYTES, () => new Error('Fichier trop volumineux.'));
      temp = written.temp;
      if (written.sha256 !== row.sha256) throw new Error('Empreinte SHA-256 différente après déchiffrement.');
      commitTemp(written.temp, storageKey);
      temp = null;
      const changed = Number(run('UPDATE files SET storage_key=?,key_fingerprint=? WHERE id=? AND storage_key=? AND purged_at IS NULL',
        storageKey, written.fingerprint, row.id, row.storage_key).changes);
      if (changed) { removeObject(row.storage_key); rekeyed += 1; } else removeObject(storageKey);
    } catch (error) {
      removeQuietly(temp);
      failed += 1;
      log.error('files.rekey_failed', { file_id: row.id, error });
    }
  }
  const remaining = one<{ count: number }>(`SELECT COUNT(*) AS count FROM files WHERE purged_at IS NULL AND deleted_at IS NULL
    AND quarantined_at IS NULL AND (key_fingerprint IS NULL OR key_fingerprint<>?)`, fingerprint)!.count;
  return { rekeyed, failed, remaining };
}

registerJob({
  name: 'files.scan',
  description: 'Relance les analyses antivirus en attente (antivirus indisponible, fichiers non analysés).',
  intervalMs: 60000,
  run: async () => { await scanPendingFiles(50); },
});

registerJob({
  name: 'files.cleanup',
  description: 'Supprime les fichiers non rattachés (24 h, KYC brouillon 30 j), les exports RGPD (7 j), les KYC expirés, le contenu des fichiers supprimés et les fichiers temporaires.',
  intervalMs: HOUR,
  run: async () => { await cleanupFiles(); },
});

registerJob({
  name: 'files.rekey',
  description: 'Rechiffre les fichiers protégés par une ancienne clé maîtresse (rotation de ALPHA_SECRETS_KEY).',
  intervalMs: 6 * HOUR,
  enabled: () => !!(process.env.ALPHA_SECRETS_KEY_PREVIOUS ?? '').trim(),
  run: async () => { await rekeyFiles(50); },
});

interface PersonalFileRow {
  id: string; purpose: string; original_name: string; mime_type: string; size_bytes: number; sha256: string; scan_status: string;
  resource_type: string | null; resource_id: string | null; created_at: string; deleted_at: string | null; retain_until: string | null;
}

registerPersonalData('files', {
  description: 'Fichiers envoyés (métadonnées), consultations administratives de vos pièces d’identité.',
  export(userId) {
    const files = all<PersonalFileRow>(`SELECT id,purpose,original_name,mime_type,size_bytes,sha256,scan_status,resource_type,resource_id,
      created_at,deleted_at,retain_until FROM files WHERE owner_id=? ORDER BY created_at`, userId);
    const kycAccess = all<{ file_id: string; action: string; reason: string; at: string }>(`SELECT l.file_id,l.action,l.reason,l.at
      FROM file_access_log l JOIN files f ON f.id=l.file_id WHERE f.owner_id=? ORDER BY l.at`, userId);
    return { files, kyc_admin_access: kycAccess };
  },
  erase(userId) {
    const at = now();
    const retainUntil = new Date(Date.now() + kycRetentionDays() * DAY).toISOString();
    // Identity documents are a legal obligation (AML/KYC): kept until the retention period ends, then purged by files.cleanup.
    run(`UPDATE files SET retain_until=COALESCE(retain_until,?) WHERE owner_id=? AND purpose='kyc_document' AND deleted_at IS NULL`, retainUntil, userId);
    // Deliveries already handed to buyers stay available to them but are no longer linked to the erased seller.
    run(`UPDATE files SET owner_id=NULL WHERE owner_id=? AND purpose='listing_delivery' AND deleted_at IS NULL AND resource_type='order'
      AND resource_id IN (SELECT id FROM orders WHERE status IN ('delivered','completed','disputed'))`, userId);
    const others = all<{ id: string; original_name: string }>(`SELECT id,original_name FROM files WHERE owner_id=? AND purpose<>'kyc_document'`, userId);
    for (const file of others) {
      run(`UPDATE files SET original_name=?,deleted_at=COALESCE(deleted_at,?),deleted_by=COALESCE(deleted_by,?) WHERE id=?`,
        `fichier-supprime${extensionOf(file.original_name)}`.slice(0, 180), at, userId, file.id);
    }
  },
});
