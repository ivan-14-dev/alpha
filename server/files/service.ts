import { all, one } from '../db.js';

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

const columns = 'id,owner_id,purpose,original_name,mime_type,size_bytes,sha256,scan_status,resource_type,resource_id,created_at';

/** No authorization check. Returns null for deleted files. */
export function getFile(fileId: string): StoredFile | null {
  return one<StoredFile>(`SELECT ${columns} FROM files WHERE id=? AND deleted_at IS NULL`, fileId) ?? null;
}

export function filesFor(resourceType: string, resourceId: string): StoredFile[] {
  return all<StoredFile>(`SELECT ${columns} FROM files WHERE resource_type=? AND resource_id=? AND deleted_at IS NULL ORDER BY created_at`, resourceType, resourceId);
}

/** Purpose-specific read authorization (owner, resource participants, admins). */
export function canReadFile(_userId: string, _file: StoredFile): boolean {
  throw new Error('files module: canReadFile not implemented');
}

/** Decrypted content. Refuses files whose scan is not clean (unless the purpose is internal). */
export async function readFileBuffer(_fileId: string): Promise<Buffer> {
  throw new Error('files module: readFileBuffer not implemented');
}

/** Stores server-generated content (exports, sandbox logs/artifacts). Async: call OUTSIDE transactions. */
export async function storeBuffer(_input: {
  ownerId: string | null; purpose: FilePurpose; name: string; mimeType: string; data: Buffer;
  resourceType?: string; resourceId?: string; skipScan?: boolean;
}): Promise<StoredFile> {
  throw new Error('files module: storeBuffer not implemented');
}

/** Links an uploaded file (owned by `ownerId`) to a resource. Synchronous, call inside the caller's transaction. */
export function attachFile(_fileId: string, _ownerId: string, _resourceType: string, _resourceId: string): StoredFile {
  throw new Error('files module: attachFile not implemented');
}
