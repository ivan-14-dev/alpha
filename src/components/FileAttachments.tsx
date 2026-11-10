/**
 * V4 placeholder — OWNER: files module.
 * Contract: lists files attached to a resource (`GET /api/files?resource_type=&resource_id=`) with scan status and
 * download links, and lets authorised users upload new ones when `canUpload` is true.
 */
export interface FileAttachmentsProps {
  resourceType: string;
  resourceId: string;
  purpose: string;
  canUpload?: boolean;
  title?: string;
}
export default function FileAttachments(_props: FileAttachmentsProps) {
  return null;
}
