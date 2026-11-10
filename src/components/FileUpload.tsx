/**
 * V4 placeholder — OWNER: files module.
 * Contract: uploads one file with `POST /api/files` (multipart fields `file`, `purpose`, optional `resource_type`, `resource_id`)
 * and calls `onUploaded` with the stored file metadata (see server/files/service.ts StoredFile).
 */
export interface UploadedFile {
  id: string; original_name: string; mime_type: string; size_bytes: number;
  scan_status: 'pending' | 'clean' | 'infected' | 'error' | 'skipped'; purpose: string; created_at: string;
}
export interface FileUploadProps {
  purpose: string;
  resourceType?: string;
  resourceId?: string;
  label?: string;
  accept?: string;
  disabled?: boolean;
  onUploaded: (file: UploadedFile) => void;
}
export default function FileUpload(_props: FileUploadProps) {
  return null;
}
