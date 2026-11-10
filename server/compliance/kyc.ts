import { z } from 'zod';
import { all, one, run, transaction } from '../db.js';
import { audit, HttpError, notify, now } from '../core.js';
import { attachFile, getFile, type StoredFile } from '../files/service.js';
import { log } from '../platform/log.js';
import { seal, unseal } from '../platform/secrets.js';
import { ageInYears, isoCountry, isRealDate } from './util.js';

export type KycStatus = 'draft' | 'submitted' | 'approved' | 'rejected';
export type KycLevel = 'none' | 'basic' | 'enhanced';
export const KYC_RESOURCE = 'kyc';
export const KYC_PURPOSE = 'kyc_document';
const MAX_DOCUMENTS = 5;

interface KycRow {
  user_id: string;
  status: KycStatus;
  level: KycLevel;
  legal_name: string;
  country: string | null;
  date_of_birth: string | null;
  address_sealed: string | null;
  document_file_ids: string;
  submitted_at: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  rejection_reason: string;
  created_at: string;
  updated_at: string;
}

export const addressSchema = z.object({
  line1: z.string().trim().min(2).max(200),
  line2: z.string().trim().max(200).default(''),
  postal_code: z.string().trim().max(20).regex(/^[A-Za-z0-9 -]*$/, 'Code postal invalide.').default(''),
  city: z.string().trim().min(1).max(100),
  region: z.string().trim().max(100).default(''),
}).strict();
export type KycAddress = z.infer<typeof addressSchema>;

const fileId = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/);
export const kycDraftSchema = z.object({
  legal_name: z.string().trim().max(160).optional(),
  country: z.string().trim().toUpperCase().regex(isoCountry, 'Code pays ISO à deux lettres attendu.').nullable().optional(),
  date_of_birth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isRealDate, 'Date invalide.').nullable().optional(),
  address: addressSchema.nullable().optional(),
  document_file_ids: z.array(fileId).max(MAX_DOCUMENTS).optional(),
}).strict();
export type KycDraftInput = z.infer<typeof kycDraftSchema>;

const sealContext = (userId: string) => `kyc:${userId}`;

function row(userId: string): KycRow | undefined {
  return one<KycRow>('SELECT * FROM kyc_profiles WHERE user_id=?', userId);
}

function documentIds(profile: KycRow | undefined): string[] {
  if (!profile) return [];
  try {
    const parsed = JSON.parse(profile.document_file_ids) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch { return []; }
}

function readAddress(profile: KycRow | undefined): KycAddress | null {
  if (!profile?.address_sealed) return null;
  try { return JSON.parse(unseal(profile.address_sealed, sealContext(profile.user_id))) as KycAddress; } catch (error) {
    log.error('compliance.kyc_address_unreadable', { user_id: profile.user_id, error });
    return null;
  }
}

function documentView(file: StoredFile) {
  return { id: file.id, original_name: file.original_name, mime_type: file.mime_type, size_bytes: file.size_bytes, scan_status: file.scan_status, created_at: file.created_at };
}

function documents(profile: KycRow | undefined) {
  return documentIds(profile).map((value) => getFile(value)).filter((file): file is StoredFile => !!file).map(documentView);
}

export function kycStatus(userId: string): { status: KycStatus | 'none'; level: KycLevel } {
  const profile = one<{ status: KycStatus; level: KycLevel }>('SELECT status,level FROM kyc_profiles WHERE user_id=?', userId);
  return profile ?? { status: 'none', level: 'none' };
}

export const kycApproved = (userId: string) => kycStatus(userId).status === 'approved';

/** Owner view (the user's own data, address decrypted). */
export function kycView(userId: string) {
  const profile = row(userId);
  return {
    status: (profile?.status ?? 'none') as KycStatus | 'none',
    level: profile?.level ?? 'none',
    legal_name: profile?.legal_name ?? '',
    country: profile?.country ?? null,
    date_of_birth: profile?.date_of_birth ?? null,
    address: readAddress(profile),
    documents: documents(profile),
    submitted_at: profile?.submitted_at ?? null,
    reviewed_at: profile?.reviewed_at ?? null,
    rejection_reason: profile?.rejection_reason ?? '',
    editable: !profile || profile.status === 'draft' || profile.status === 'rejected',
  };
}

/** A KYC document must belong to the user, carry the kyc_document purpose and not be linked to another resource. */
function assertOwnDocument(userId: string, value: string): StoredFile {
  const file = getFile(value);
  if (!file || file.owner_id !== userId || file.purpose !== KYC_PURPOSE) throw new HttpError(400, 'Document introuvable ou non autorisé pour la vérification d’identité.');
  if (file.resource_type !== null && (file.resource_type !== KYC_RESOURCE || file.resource_id !== userId)) {
    throw new HttpError(400, 'Ce document est déjà rattaché à une autre ressource.');
  }
  return file;
}

export function saveKycDraft(userId: string, input: KycDraftInput) {
  return transaction(() => {
    const profile = row(userId);
    if (profile?.status === 'submitted') throw new HttpError(409, 'Votre dossier est en cours de vérification : il ne peut plus être modifié.');
    if (profile?.status === 'approved') throw new HttpError(409, 'Votre identité est déjà vérifiée. Contactez le support pour la modifier.');
    if (input.document_file_ids) {
      if (new Set(input.document_file_ids).size !== input.document_file_ids.length) throw new HttpError(400, 'Un document est présent deux fois.');
      for (const value of input.document_file_ids) assertOwnDocument(userId, value);
    }
    const timestamp = now();
    if (!profile) run('INSERT INTO kyc_profiles(user_id,created_at,updated_at) VALUES (?,?,?)', userId, timestamp, timestamp);
    const updates: string[] = ["status='draft'", 'updated_at=?'];
    const values: (string | null)[] = [timestamp];
    if (input.legal_name !== undefined) { updates.push('legal_name=?'); values.push(input.legal_name); }
    if (input.country !== undefined) { updates.push('country=?'); values.push(input.country); }
    if (input.date_of_birth !== undefined) { updates.push('date_of_birth=?'); values.push(input.date_of_birth); }
    if (input.address !== undefined) { updates.push('address_sealed=?'); values.push(input.address ? seal(JSON.stringify(input.address), sealContext(userId)) : null); }
    if (input.document_file_ids !== undefined) { updates.push('document_file_ids=?'); values.push(JSON.stringify(input.document_file_ids)); }
    run(`UPDATE kyc_profiles SET ${updates.join(',')} WHERE user_id=?`, ...values, userId);
    return kycView(userId);
  });
}

/** Links an uploaded document to kyc/<userId> through the files module (savepoint: a failure leaves no partial write). */
function linkDocument(userId: string, file: StoredFile) {
  if (file.resource_type === KYC_RESOURCE && file.resource_id === userId) return;
  try {
    transaction(() => attachFile(file.id, userId, KYC_RESOURCE, userId));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    log.warn('compliance.kyc_attach_failed', { file_id: file.id, error });
  }
}

export function submitKyc(userId: string) {
  return transaction(() => {
    const profile = row(userId);
    if (!profile) throw new HttpError(400, 'Complétez votre dossier avant de l’envoyer.');
    if (profile.status === 'submitted') throw new HttpError(409, 'Votre dossier est déjà en cours de vérification.');
    if (profile.status === 'approved') throw new HttpError(409, 'Votre identité est déjà vérifiée.');
    const problems: string[] = [];
    if (profile.legal_name.trim().length < 2) problems.push('nom légal');
    if (!profile.country) problems.push('pays de résidence');
    if (!profile.date_of_birth) problems.push('date de naissance');
    if (!readAddress(profile)) problems.push('adresse');
    if (problems.length) throw new HttpError(400, `Champs manquants : ${problems.join(', ')}.`);
    const age = ageInYears(profile.date_of_birth!);
    if (age < 18) throw new HttpError(400, 'Les retraits sont réservés aux personnes majeures.');
    if (age > 120) throw new HttpError(400, 'Date de naissance invalide.');
    const ids = documentIds(profile);
    if (!ids.length) throw new HttpError(400, 'Ajoutez au moins une pièce d’identité.');
    const files = ids.map((value) => assertOwnDocument(userId, value));
    if (files.some((file) => file.scan_status === 'pending')) throw new HttpError(409, 'Vos documents sont en cours d’analyse antivirus. Réessayez dans quelques instants.');
    if (files.some((file) => file.scan_status !== 'clean' && file.scan_status !== 'skipped')) {
      throw new HttpError(400, 'Un document a été refusé par l’analyse antivirus. Retirez-le et téléversez un autre fichier.');
    }
    for (const file of files) linkDocument(userId, file);
    const timestamp = now();
    run("UPDATE kyc_profiles SET status='submitted',submitted_at=?,reviewed_by=NULL,reviewed_at=NULL,updated_at=? WHERE user_id=?", timestamp, timestamp, userId);
    notify(userId, 'compliance.kyc_submitted', 'Dossier d’identité envoyé', 'Notre équipe vérifie vos documents. Vous serez notifié de la décision.', '/wallet');
    return kycView(userId);
  });
}

export function reviewKyc(adminId: string, userId: string, decision: { approve: true; level: Exclude<KycLevel, 'none'>; note: string } | { approve: false; reason: string }) {
  if (adminId === userId) throw new HttpError(403, 'Vous ne pouvez pas examiner votre propre dossier.');
  return transaction(() => {
    const profile = row(userId);
    if (!profile) throw new HttpError(404, 'Dossier introuvable.');
    if (profile.status !== 'submitted') throw new HttpError(409, 'Ce dossier n’est pas en attente de vérification.');
    const timestamp = now();
    if (decision.approve) {
      run("UPDATE kyc_profiles SET status='approved',level=?,reviewed_by=?,reviewed_at=?,rejection_reason='',updated_at=? WHERE user_id=?",
        decision.level, adminId, timestamp, timestamp, userId);
      audit(adminId, 'compliance.kyc_approved', 'user', userId, JSON.stringify({ level: decision.level, note: decision.note }));
      notify(userId, 'compliance.kyc_approved', 'Identité vérifiée', 'Votre identité a été vérifiée : vous pouvez demander des retraits dans la limite de vos plafonds.', '/wallet');
    } else {
      run("UPDATE kyc_profiles SET status='rejected',level='none',reviewed_by=?,reviewed_at=?,rejection_reason=?,updated_at=? WHERE user_id=?",
        adminId, timestamp, decision.reason, timestamp, userId);
      audit(adminId, 'compliance.kyc_rejected', 'user', userId, decision.reason);
      notify(userId, 'compliance.kyc_rejected', 'Vérification d’identité refusée', `Motif : ${decision.reason} Vous pouvez corriger votre dossier et le renvoyer.`, '/wallet');
    }
    return adminKycDetail(userId);
  });
}

interface QueueRow { user_id: string; status: KycStatus; level: KycLevel; legal_name: string; country: string | null; submitted_at: string | null; reviewed_at: string | null; document_file_ids: string; user_name: string; user_email: string }

export function adminKycQueue(status: KycStatus, limit: number, offset: number) {
  const rows = all<QueueRow>(`SELECT k.user_id,k.status,k.level,k.legal_name,k.country,k.submitted_at,k.reviewed_at,k.document_file_ids,u.name AS user_name,u.email AS user_email
    FROM kyc_profiles k JOIN users u ON u.id=k.user_id WHERE k.status=? ORDER BY COALESCE(k.submitted_at,k.updated_at) ASC LIMIT ? OFFSET ?`, status, limit, offset);
  const total = one<{ count: number }>('SELECT COUNT(*) AS count FROM kyc_profiles WHERE status=?', status)!.count;
  return {
    total,
    profiles: rows.map(({ document_file_ids, ...item }) => ({ ...item, document_count: (JSON.parse(document_file_ids) as unknown[]).length })),
  };
}

/** Full dossier for reviewers, with links served (and authorised) by the files module. */
export function adminKycDetail(userId: string) {
  const profile = row(userId);
  if (!profile) throw new HttpError(404, 'Dossier introuvable.');
  const user = one<{ name: string; email: string; created_at: string }>('SELECT name,email,created_at FROM users WHERE id=?', userId)!;
  return {
    user_id: userId,
    user_name: user.name,
    user_email: user.email,
    user_created_at: user.created_at,
    status: profile.status,
    level: profile.level,
    legal_name: profile.legal_name,
    country: profile.country,
    date_of_birth: profile.date_of_birth,
    address: readAddress(profile),
    documents: documents(profile).map((file) => ({ ...file, download_url: `/api/files/${encodeURIComponent(file.id)}/download` })),
    submitted_at: profile.submitted_at,
    reviewed_by: profile.reviewed_by,
    reviewed_at: profile.reviewed_at,
    rejection_reason: profile.rejection_reason,
  };
}

/** Identity snapshot printed on invoices (only verified data). */
export function kycIdentity(userId: string): { legal_name: string; country: string | null; address: KycAddress | null } | null {
  const profile = row(userId);
  if (!profile || profile.status !== 'approved') return null;
  return { legal_name: profile.legal_name, country: profile.country, address: readAddress(profile) };
}

export function kycCountry(userId: string): string | null {
  return one<{ country: string | null }>('SELECT country FROM kyc_profiles WHERE user_id=?', userId)?.country ?? null;
}

export function exportKyc(userId: string) {
  const profile = row(userId);
  if (!profile) return null;
  const view = kycView(userId);
  return { ...view, documents: view.documents.map(({ id, original_name, mime_type, size_bytes, created_at }) => ({ id, original_name, mime_type, size_bytes, created_at })) };
}

/** Scrubs identity data (documents themselves are erased by the files/privacy modules). Status is kept as a compliance trace. */
export function eraseKyc(userId: string) {
  run(`UPDATE kyc_profiles SET legal_name='',country=NULL,date_of_birth=NULL,address_sealed=NULL,document_file_ids='[]',
    rejection_reason='',updated_at=? WHERE user_id=?`, now(), userId);
}
