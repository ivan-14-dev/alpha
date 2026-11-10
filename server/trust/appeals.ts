import { all, one, run, transaction } from '../db.js';
import { HttpError, id, notify, now, type User } from '../core.js';
import { auditAs, kindLabels, revokeSanction, type SanctionRow } from './sanctions.js';
import { appealSettings, DAY_MS, MAX_APPEALS_PER_SANCTION } from './settings.js';

export interface AppealRow {
  id: string; sanction_id: string; user_id: string; statement: string; status: 'pending' | 'accepted' | 'rejected';
  reviewer_id: string | null; decision_note: string; created_at: string; decided_at: string | null;
}

const addDays = (iso: string, days: number) => new Date(Date.parse(iso) + days * DAY_MS).toISOString();

export function appealDeadline(sanction: Pick<SanctionRow, 'created_at'>) {
  return addDays(sanction.created_at, appealSettings().window_days);
}

/** Why a member can (not) appeal a sanction right now; `null` reason = allowed. */
export function appealBlocker(sanction: SanctionRow, appeals: Pick<AppealRow, 'status'>[], at = now()): string | null {
  if (sanction.appealable !== 1) return 'Cette décision n’est pas contestable en interne.';
  if (sanction.revoked_at) return 'Cette sanction est déjà levée.';
  if (appeals.some((appeal) => appeal.status === 'pending')) return 'Un appel est déjà en cours d’examen pour cette sanction.';
  if (appeals.length >= MAX_APPEALS_PER_SANCTION) return `Nombre maximal d’appels atteint pour cette sanction (${MAX_APPEALS_PER_SANCTION}).`;
  if (at > appealDeadline(sanction)) return 'Le délai de contestation de cette décision est dépassé.';
  return null;
}

export function memberAppeal(appeal: AppealRow) {
  return {
    id: appeal.id, sanction_id: appeal.sanction_id, statement: appeal.statement, status: appeal.status,
    decision_note: appeal.decision_note, created_at: appeal.created_at, decided_at: appeal.decided_at,
    sla_due_at: addDays(appeal.created_at, appealSettings().sla_days),
  };
}

export function myAppeals(userId: string) {
  return all<AppealRow & { sanction_kind: SanctionRow['kind']; public_reason: string }>(`SELECT a.*,s.kind AS sanction_kind,s.public_reason
    FROM appeals a JOIN sanctions s ON s.id=a.sanction_id WHERE a.user_id=? ORDER BY a.created_at DESC LIMIT 100`, userId)
    .map((row) => ({ ...memberAppeal(row), sanction_kind: row.sanction_kind, sanction_label: kindLabels[row.sanction_kind], public_reason: row.public_reason }));
}

export function createAppeal(user: User, sanctionId: string, statement: string) {
  return transaction(() => {
    const sanction = one<SanctionRow>('SELECT * FROM sanctions WHERE id=? AND user_id=?', sanctionId, user.id);
    if (!sanction) throw new HttpError(404, 'Sanction introuvable.');
    const blocker = appealBlocker(sanction, all<AppealRow>('SELECT status FROM appeals WHERE sanction_id=?', sanctionId));
    if (blocker) throw new HttpError(409, blocker);
    const appealId = id();
    try {
      run('INSERT INTO appeals(id,sanction_id,user_id,statement,created_at) VALUES (?,?,?,?,?)', appealId, sanctionId, user.id, statement, now());
    } catch {
      throw new HttpError(409, 'Un appel est déjà en cours ou le nombre maximal d’appels est atteint pour cette sanction.');
    }
    const { sla_days: sla } = appealSettings();
    notify(user.id, 'trust.appeal', 'Appel enregistré', `Votre contestation sera examinée par une personne de l’équipe de modération sous ${sla} jours.`, '/trust#restrictions');
    for (const admin of all<{ id: string }>("SELECT id FROM users WHERE role='admin' AND id!=? ORDER BY id LIMIT 100", user.id)) {
      notify(admin.id, 'trust.appeal', 'Nouvel appel à examiner', `Contestation d’une sanction (${kindLabels[sanction.kind].toLowerCase()}).`, '/admin/appeals');
    }
    auditAs(user.id, 'trust.appeal.created', 'sanction', sanctionId, { appeal_id: appealId, sanction_kind: sanction.kind });
    return memberAppeal(one<AppealRow>('SELECT * FROM appeals WHERE id=?', appealId)!);
  });
}

/** Human review of an appeal (DSA art. 20). Accepting lifts the sanction in the same transaction. */
export function decideAppeal(admin: User, appealId: string, decision: 'accepted' | 'rejected', note: string) {
  return transaction(() => {
    const appeal = one<AppealRow>('SELECT * FROM appeals WHERE id=?', appealId);
    if (!appeal) throw new HttpError(404, 'Appel introuvable.');
    if (appeal.status !== 'pending') throw new HttpError(409, 'Cet appel a déjà été traité.');
    const sanction = one<SanctionRow>('SELECT * FROM sanctions WHERE id=?', appeal.sanction_id)!;
    const text = note.trim();
    if (decision === 'rejected' && text.length < 10) throw new HttpError(400, 'Motivez le rejet en au moins 10 caractères : la réponse est communiquée au membre.');
    const finalNote = text || 'Appel accepté après réexamen : la sanction est levée.';
    if (decision === 'accepted' && !sanction.revoked_at) {
      revokeSanction(sanction.id, admin.id, `Appel accepté. ${finalNote}`.slice(0, 2000), { appealId, notifyUser: false });
    }
    run('UPDATE appeals SET status=?,reviewer_id=?,decision_note=?,decided_at=? WHERE id=? AND status=?',
      decision, admin.id, finalNote.slice(0, 4000), now(), appealId, 'pending');
    notify(appeal.user_id, 'trust.appeal', decision === 'accepted' ? 'Appel accepté : sanction levée' : 'Appel rejeté',
      decision === 'accepted' ? `${kindLabels[sanction.kind]} levée. ${finalNote}` : `La décision est maintenue. ${finalNote} Vous pouvez saisir un organisme de règlement extrajudiciaire certifié ou la justice.`,
      '/trust#restrictions');
    auditAs(admin.id, `trust.appeal.${decision}`, 'appeal', appealId, { sanction_id: sanction.id, user_id: appeal.user_id, note: finalNote });
    return one<AppealRow>('SELECT * FROM appeals WHERE id=?', appealId)!;
  });
}
