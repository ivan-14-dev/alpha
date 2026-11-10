import { z } from 'zod';
import { getSetting } from '../platform/settings.js';
import type { FilePurpose } from './service.js';

/**
 * File type registry and per-purpose upload policies.
 * A file is accepted only when its extension AND its magic bytes match the same kind, and the kind is
 * allowed for the declared purpose. The MIME type stored and served is always derived server-side.
 */
export interface FileKind {
  id: string;
  label: string;
  extensions: string[];
  mime: string;
  /** Safe to render inline (`?inline=1`) as an image. */
  inlineImage?: boolean;
  /** Plain text: validated as UTF-8 without markup that a browser could execute. */
  text?: boolean;
  sniff: (head: Buffer, tail: Buffer, size: number) => boolean;
}

const bytes = (head: Buffer, offset: number, signature: number[] | string) => {
  const expected = typeof signature === 'string' ? Buffer.from(signature, 'latin1') : Buffer.from(signature);
  return head.length >= offset + expected.length && head.subarray(offset, offset + expected.length).equals(expected);
};
const isZip = (head: Buffer) => bytes(head, 0, [0x50, 0x4b, 0x03, 0x04]) || bytes(head, 0, [0x50, 0x4b, 0x05, 0x06]);
const isText = (head: Buffer) => !head.includes(0) && validUtf8Prefix(head);

/** Accepts a UTF-8 prefix whose last multi-byte sequence may be cut by the sniffing window. */
function validUtf8Prefix(buffer: Buffer): boolean {
  let index = 0;
  while (index < buffer.length) {
    const byte = buffer[index];
    const length = byte < 0x80 ? 1 : (byte & 0xe0) === 0xc0 ? 2 : (byte & 0xf0) === 0xe0 ? 3 : (byte & 0xf8) === 0xf0 ? 4 : 0;
    if (!length || (length === 2 && byte < 0xc2) || (length === 4 && byte > 0xf4)) return false;
    for (let offset = 1; offset < length; offset += 1) {
      if (index + offset >= buffer.length) return true;
      if ((buffer[index + offset] & 0xc0) !== 0x80) return false;
    }
    index += length;
  }
  return true;
}

export const fileKinds: FileKind[] = [
  { id: 'png', label: 'PNG', extensions: ['.png'], mime: 'image/png', inlineImage: true, sniff: (h) => bytes(h, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { id: 'jpeg', label: 'JPEG', extensions: ['.jpg', '.jpeg'], mime: 'image/jpeg', inlineImage: true, sniff: (h) => bytes(h, 0, [0xff, 0xd8, 0xff]) },
  { id: 'webp', label: 'WebP', extensions: ['.webp'], mime: 'image/webp', inlineImage: true, sniff: (h) => bytes(h, 0, 'RIFF') && bytes(h, 8, 'WEBP') },
  { id: 'gif', label: 'GIF', extensions: ['.gif'], mime: 'image/gif', inlineImage: true, sniff: (h) => bytes(h, 0, 'GIF87a') || bytes(h, 0, 'GIF89a') },
  { id: 'pdf', label: 'PDF', extensions: ['.pdf'], mime: 'application/pdf', sniff: (h) => bytes(h, 0, '%PDF-') },
  { id: 'mp4', label: 'MP4', extensions: ['.mp4', '.m4v'], mime: 'video/mp4', sniff: (h) => bytes(h, 4, 'ftyp') },
  { id: 'webm', label: 'WebM', extensions: ['.webm'], mime: 'video/webm', sniff: (h) => bytes(h, 0, [0x1a, 0x45, 0xdf, 0xa3]) },
  { id: 'txt', label: 'Texte / journal', extensions: ['.txt', '.log'], mime: 'text/plain', text: true, sniff: isText },
  { id: 'md', label: 'Markdown', extensions: ['.md'], mime: 'text/markdown', text: true, sniff: isText },
  { id: 'json', label: 'JSON', extensions: ['.json'], mime: 'application/json', text: true,
    sniff: (h) => isText(h) && /^(\uFEFF)?\s*[[{]/.test(h.subarray(0, 64).toString('utf8')) },
  { id: 'zip', label: 'ZIP', extensions: ['.zip'], mime: 'application/zip', sniff: isZip },
  { id: 'targz', label: 'tar.gz', extensions: ['.tar.gz', '.tgz'], mime: 'application/gzip', sniff: (h) => bytes(h, 0, [0x1f, 0x8b, 0x08]) },
  { id: 'apk', label: 'APK Android', extensions: ['.apk'], mime: 'application/vnd.android.package-archive', sniff: isZip },
  { id: 'aab', label: 'Android App Bundle', extensions: ['.aab'], mime: 'application/octet-stream', sniff: isZip },
  { id: 'ipa', label: 'IPA iOS', extensions: ['.ipa'], mime: 'application/octet-stream', sniff: isZip },
  { id: 'jar', label: 'JAR Java', extensions: ['.jar'], mime: 'application/java-archive', sniff: isZip },
  { id: 'exe', label: 'Exécutable Windows', extensions: ['.exe'], mime: 'application/vnd.microsoft.portable-executable', sniff: (h) => bytes(h, 0, 'MZ') },
  { id: 'msi', label: 'Installeur MSI', extensions: ['.msi'], mime: 'application/x-msi', sniff: (h) => bytes(h, 0, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) },
  // Apple disk images carry a 512-byte "koly" trailer at the very end of the file.
  { id: 'dmg', label: 'Image disque macOS', extensions: ['.dmg'], mime: 'application/x-apple-diskimage', sniff: (_h, t, size) => size >= 512 && t.length >= 512 && bytes(t.subarray(t.length - 512), 0, 'koly') },
  { id: 'appimage', label: 'AppImage', extensions: ['.appimage'], mime: 'application/octet-stream', sniff: (h) => bytes(h, 0, [0x7f, 0x45, 0x4c, 0x46]) },
  { id: 'deb', label: 'Paquet Debian', extensions: ['.deb'], mime: 'application/vnd.debian.binary-package', sniff: (h) => bytes(h, 0, '!<arch>\n') },
  { id: 'rpm', label: 'Paquet RPM', extensions: ['.rpm'], mime: 'application/x-rpm', sniff: (h) => bytes(h, 0, [0xed, 0xab, 0xee, 0xdb]) },
];
const kindById = new Map(fileKinds.map((kind) => [kind.id, kind]));
export const kindIds = fileKinds.map((kind) => kind.id) as [string, ...string[]];
export function fileKind(id: string): FileKind | undefined { return kindById.get(id); }

export const allPurposes = ['kyc_document', 'mission_attachment', 'campaign_build', 'listing_delivery', 'message_attachment', 'privacy_export', 'sandbox_artifact'] as const satisfies readonly FilePurpose[];
/** Purposes only the server may create (storeBuffer); never accepted from the upload endpoint. */
export const internalPurposes: ReadonlySet<FilePurpose> = new Set<FilePurpose>(['privacy_export', 'sandbox_artifact']);
export const uploadPurposes = allPurposes.filter((purpose) => !internalPurposes.has(purpose)) as Exclude<FilePurpose, 'privacy_export' | 'sandbox_artifact'>[];
/** Purposes whose downloads are only served once the antivirus reported them clean (or scanning is disabled). */
export const scanGatedPurposes: ReadonlySet<FilePurpose> = new Set<FilePurpose>(['campaign_build', 'listing_delivery', 'message_attachment', 'mission_attachment', 'kyc_document']);

/** Resource type each purpose may be attached to. */
export const purposeResource: Record<FilePurpose, string> = {
  kyc_document: 'kyc',
  mission_attachment: 'mission',
  campaign_build: 'campaign',
  listing_delivery: 'order',
  message_attachment: 'conversation',
  privacy_export: 'privacy_request',
  sandbox_artifact: 'sandbox_run',
};

export const purposeLabels: Record<FilePurpose, string> = {
  kyc_document: 'Pièce KYC',
  mission_attachment: 'Pièce jointe de mission',
  campaign_build: 'Build de campagne',
  listing_delivery: 'Livraison marketplace',
  message_attachment: 'Pièce jointe de message',
  privacy_export: 'Export RGPD',
  sandbox_artifact: 'Artefact du bac à sable',
};

const MB = 1024 * 1024;
const images = ['png', 'jpeg', 'webp', 'gif'];
export const HARD_MAX_BYTES = 2048 * MB;

export interface PurposePolicy { max_bytes: number; kinds: string[] }

export const defaultPolicies: Record<FilePurpose, PurposePolicy> = {
  kyc_document: { max_bytes: 10 * MB, kinds: ['pdf', 'png', 'jpeg', 'webp'] },
  mission_attachment: { max_bytes: 50 * MB, kinds: [...images, 'mp4', 'webm', 'pdf', 'txt', 'json', 'zip'] },
  campaign_build: { max_bytes: 200 * MB, kinds: ['zip', 'targz', 'apk', 'aab', 'ipa', 'exe', 'msi', 'dmg', 'appimage', 'jar', 'deb', 'rpm'] },
  listing_delivery: { max_bytes: 100 * MB, kinds: ['zip', 'pdf', ...images, 'txt', 'md'] },
  message_attachment: { max_bytes: 15 * MB, kinds: [...images, 'pdf', 'txt', 'zip'] },
  privacy_export: { max_bytes: 512 * MB, kinds: ['zip', 'json', 'targz'] },
  sandbox_artifact: { max_bytes: 512 * MB, kinds: ['txt', 'json', 'zip', 'targz', 'png', 'jpeg', 'webp', 'mp4', 'webm'] },
};

export const policyOverrideSchema = z.record(
  z.enum(allPurposes),
  z.object({
    max_bytes: z.number().int().min(1024).max(HARD_MAX_BYTES).optional(),
    kinds: z.array(z.enum(kindIds)).min(1).max(kindIds.length).optional(),
  }).strict(),
);
export type PolicyOverrides = z.infer<typeof policyOverrideSchema>;

export function policyOverrides(): PolicyOverrides {
  return getSetting('files.policies', policyOverrideSchema, {});
}

export function policyFor(purpose: FilePurpose): PurposePolicy {
  const base = defaultPolicies[purpose];
  const override = policyOverrides()[purpose] ?? {};
  return { max_bytes: override.max_bytes ?? base.max_bytes, kinds: [...new Set(override.kinds ?? base.kinds)] };
}

/** Public description used by the upload component (size and type hints). */
export function describePolicy(purpose: FilePurpose) {
  const policy = policyFor(purpose);
  const kinds = policy.kinds.map((id) => kindById.get(id)!).filter(Boolean);
  const extensions = kinds.flatMap((kind) => kind.extensions);
  return {
    purpose,
    label: purposeLabels[purpose],
    resource_type: purposeResource[purpose],
    max_bytes: policy.max_bytes,
    kinds: kinds.map((kind) => ({ id: kind.id, label: kind.label })),
    extensions,
    accept: extensions.join(','),
  };
}

const quotaSchema = z.object({ bytes_per_user: z.number().int().min(0).max(1024 * 1024 * MB) }).strict();
export const DEFAULT_QUOTA_BYTES = 2048 * MB;
export function userQuotaBytes(): number {
  return getSetting('files.quota', quotaSchema, { bytes_per_user: DEFAULT_QUOTA_BYTES }).bytes_per_user;
}
export { quotaSchema };

export const DEFAULT_KYC_RETENTION_DAYS = 5 * 365;
export function kycRetentionDays(): number {
  return getSetting('files.kyc_retention_days', z.number().int().min(30).max(36500), DEFAULT_KYC_RETENTION_DAYS);
}

/** Lower-cased extension, including compound archives such as `.tar.gz`. */
export function extensionOf(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.tar.gz')) return '.tar.gz';
  const dot = lower.lastIndexOf('.');
  return dot > 0 ? lower.slice(dot) : '';
}

export function kindForExtension(extension: string, allowed: string[]): FileKind | undefined {
  return allowed.map((id) => kindById.get(id)).find((kind) => kind?.extensions.includes(extension));
}

const reservedWindowsNames = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
// C0/C1 controls, bidi overrides/isolates (right-to-left override filename spoofing) and zero-width characters.
const unsafeCharacters = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/** Display-only name: strips directories, control/bidi characters and reserved characters; max 180 characters. */
export function sanitizeFilename(raw: string, max = 180): string {
  const base = (raw ?? '').normalize('NFC').split(/[\\/]/).pop() ?? '';
  let name = base.replace(unsafeCharacters, '').replace(/[<>:"|?*]/g, '_').replace(/\s+/g, ' ').trim().replace(/^[.\s]+|[.\s]+$/g, '');
  if (!name) name = 'fichier';
  if (reservedWindowsNames.test(name)) name = `_${name}`;
  if ([...name].length > max) {
    const extension = extensionOf(name);
    const keep = extension && extension.length < 20 ? extension : '';
    name = [...name.slice(0, name.length - keep.length)].slice(0, max - keep.length).join('').trim() + keep;
  }
  return name;
}

// Text that a browser would treat as a document if it were ever rendered (HTML, SVG, XML, script).
const markupDocument = /^(\uFEFF)?\s*<\s*(!doctype|html|svg|\?xml|script|iframe|head|body)\b/i;
// Polyglot images (GIFAR, JPEG+HTML): markup or script anywhere in the sniffed head.
const embeddedMarkup = /<\s*(script|html|svg|iframe|!doctype)\b|javascript\s*:/i;

export interface SniffResult { ok: boolean; reason?: string }

/** Checks the magic bytes of an uploaded file against the kind implied by its extension. */
export function verifyContent(kind: FileKind, head: Buffer, tail: Buffer, size: number): SniffResult {
  if (!kind.sniff(head, tail, size)) {
    return { ok: false, reason: `Le contenu du fichier ne correspond pas au format ${kind.label} annoncé par son extension.` };
  }
  if (kind.text && (markupDocument.test(head.toString('utf8')) || /<\s*script\b/i.test(head.toString('utf8')))) {
    return { ok: false, reason: 'Les fichiers texte contenant du HTML, du SVG ou du JavaScript sont refusés.' };
  }
  if (kind.inlineImage && embeddedMarkup.test(head.toString('latin1'))) {
    return { ok: false, reason: 'Cette image contient du code HTML ou JavaScript et a été refusée.' };
  }
  return { ok: true };
}

/** Best-effort kind detection for server-generated content (storeBuffer). */
export function detectKind(head: Buffer, tail: Buffer, size: number, preferredExtension = ''): string {
  const byExtension = fileKinds.find((kind) => kind.extensions.includes(preferredExtension));
  if (byExtension?.sniff(head, tail, size)) return byExtension.id;
  return fileKinds.find((kind) => !kind.text && kind.sniff(head, tail, size))?.id ?? (isText(head) ? 'txt' : '');
}
