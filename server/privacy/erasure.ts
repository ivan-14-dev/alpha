import { all, one, run, transaction } from '../db.js';
import { audit, notify, now } from '../core.js';
import { log } from '../platform/log.js';
import { queueEmail, renderEmail } from '../platform/mailer.js';
import { personalDataHandlers } from '../platform/privacy.js';
import { exponent } from '../payments/mode.js';
import { foreignKeyViolations, hasColumns, tableExists } from './schema.js';

export interface Blocker { code: string; message: string }

export const ERASED_NAME = 'Compte supprimé';
export const ERASED_PASSWORD_HASH = '!erased:00';
export const erasedEmail = (userId: string) => `deleted-${userId}@alpha.invalid`;
export const SCRUBBED = { message: '[message supprimé]', post: '[publication supprimée]', comment: '[commentaire supprimé]', review: '[avis supprimé]' };

const activeMissionStatuses = ['assigned', 'in_progress', 'submitted', 'changes_requested', 'accepted', 'disputed'];
const terminalStatuses = ['paid', 'failed', 'cancelled', 'canceled', 'rejected', 'completed', 'refunded', 'reversed', 'expired', 'resolved', 'closed', 'dismissed', 'succeeded'];
const placeholders = (values: unknown[]) => values.map(() => '?').join(',');
const modeLabel = (mode: string) => mode === 'live' ? 'argent réel' : 'sandbox';

function formatMinor(amount: number, currency: string) {
  let digits = 2;
  try { digits = exponent(currency); } catch { /* unknown currency: assume 2 decimals */ }
  try {
    return new Intl.NumberFormat('fr-FR', { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(amount / 10 ** digits);
  } catch {
    return `${(amount / 10 ** digits).toFixed(digits)} ${currency}`;
  }
}

/** Optional tables owned by other modules (compliance withdrawals, payments disputes/intents) are detected, never required. */
function pendingRowsIn(table: string, userColumns: string[], userId: string, pendingStatuses?: string[]): number {
  if (!tableExists(table) || !hasColumns(table, 'status')) return 0;
  const columns = userColumns.filter((column) => hasColumns(table, column));
  if (!columns.length) return 0;
  const statusFilter = pendingStatuses
    ? `status IN (${placeholders(pendingStatuses)})`
    : `status NOT IN (${placeholders(terminalStatuses)})`;
  return one<{ total: number }>(`SELECT COUNT(*) AS total FROM ${table} WHERE (${columns.map((column) => `${column}=?`).join(' OR ')}) AND ${statusFilter}`,
    ...columns.map(() => userId), ...(pendingStatuses ?? terminalStatuses))!.total;
}

/** Reasons preventing an erasure, explained in French. Re-checked when the scheduled erasure runs. */
export function erasureBlockers(userId: string): Blocker[] {
  const blockers: Blocker[] = [];
  const available = `user:${userId}:available`;
  const pending = `user:${userId}:pending`;
  for (const row of all<{ account: string; mode: string; currency: string; total: number }>(`SELECT account,mode,currency,SUM(amount_minor) AS total
    FROM ledger_entries WHERE account IN (?,?) GROUP BY account,mode,currency HAVING SUM(amount_minor) > 0`, available, pending)) {
    blockers.push(row.account === available
      ? { code: 'balance', message: `Votre portefeuille contient encore ${formatMinor(row.total, row.currency)} (${modeLabel(row.mode)}). Retirez ces fonds avant de supprimer votre compte.` }
      : { code: 'pending_balance', message: `Des gains de ${formatMinor(row.total, row.currency)} (${modeLabel(row.mode)}) sont encore en attente de libération. Attendez leur disponibilité puis retirez-les.` });
  }
  const inFlight = one<{ total: number }>(`SELECT COUNT(DISTINCT j.ref_id) AS total FROM ledger_journals j JOIN ledger_entries e ON e.journal_id=j.id
    WHERE j.kind='withdrawal.requested' AND e.account=? AND NOT EXISTS (SELECT 1 FROM ledger_journals done
      WHERE done.ref_type=j.ref_type AND done.ref_id=j.ref_id AND done.kind IN ('withdrawal.paid','withdrawal.failed','withdrawal.cancelled','withdrawal.rejected'))`, available)!.total;
  const withdrawals = Math.max(inFlight, pendingRowsIn('withdrawals', ['user_id'], userId));
  if (withdrawals) blockers.push({ code: 'withdrawal', message: `${withdrawals} retrait(s) sont en cours de traitement. Attendez leur versement ou leur annulation.` });
  const testerMissions = one<{ total: number }>(`SELECT COUNT(*) AS total FROM missions WHERE tester_id=? AND status IN (${placeholders(activeMissionStatuses)})`,
    userId, ...activeMissionStatuses)!.total;
  if (testerMissions) blockers.push({ code: 'tester_missions', message: `Vous avez ${testerMissions} mission(s) de test en cours ou en attente de paiement. Terminez-les ou annulez-les d’abord.` });
  const ownerMissions = one<{ total: number }>(`SELECT COUNT(*) AS total FROM missions m JOIN campaigns c ON c.id=m.campaign_id
    WHERE c.owner_id=? AND m.status IN (${placeholders(activeMissionStatuses)})`, userId, ...activeMissionStatuses)!.total;
  if (ownerMissions) blockers.push({ code: 'campaign_missions', message: `${ownerMissions} mission(s) sont en cours sur vos campagnes. Validez, payez ou annulez-les pour honorer vos engagements envers les testeurs.` });
  for (const row of all<{ title: string; mode: string; currency: string; total: number }>(`SELECT c.title,e.mode,e.currency,SUM(e.amount_minor) AS total
    FROM campaigns c JOIN ledger_entries e ON e.account='escrow:campaign:' || c.id WHERE c.owner_id=? GROUP BY c.id,e.mode,e.currency HAVING SUM(e.amount_minor) > 0`, userId)) {
    blockers.push({ code: 'campaign_escrow', message: `${formatMinor(row.total, row.currency)} (${modeLabel(row.mode)}) sont encore en séquestre pour la campagne « ${row.title} ». Clôturez-la pour être remboursé.` });
  }
  const orders = one<{ total: number }>("SELECT COUNT(*) AS total FROM orders WHERE (buyer_id=? OR seller_id=?) AND status IN ('paid','delivered','disputed')", userId, userId)!.total;
  if (orders) blockers.push({ code: 'orders', message: `${orders} commande(s) de la marketplace sont en cours (livraison, validation ou litige). Finalisez-les d’abord.` });
  const intents = pendingRowsIn('payment_intents', ['user_id'], userId, ['created', 'pending']);
  if (intents) blockers.push({ code: 'payments', message: `${intents} paiement(s) sont en cours de confirmation par le prestataire. Réessayez lorsqu’ils sont finalisés.` });
  const disputes = pendingRowsIn('disputes', ['user_id', 'opened_by', 'buyer_id', 'seller_id', 'claimant_id', 'respondent_id'], userId);
  if (disputes) blockers.push({ code: 'disputes', message: `${disputes} litige(s) de paiement sont ouverts. Ils doivent être résolus avant la suppression.` });
  for (const organization of all<{ name: string; members: number }>(`SELECT o.name,COUNT(om.user_id) AS members FROM organizations o
    JOIN organization_members om ON om.organization_id=o.id AND om.user_id<>o.owner_id WHERE o.owner_id=? GROUP BY o.id`, userId)) {
    blockers.push({ code: 'organization_owner', message: `Vous êtes l’unique propriétaire de l’organisation « ${organization.name} », qui compte ${organization.members} autre(s) membre(s). Retirez-les ou contactez le support pour transférer la propriété.` });
  }
  const user = one<{ role: string }>('SELECT role FROM users WHERE id=?', userId);
  if (user?.role === 'admin' && !one("SELECT 1 FROM users WHERE role='admin' AND id<>?", userId)) {
    blockers.push({ code: 'last_admin', message: 'Vous êtes le dernier administrateur de la plateforme. Désignez un autre administrateur avant de supprimer votre compte.' });
  }
  return blockers;
}

/** Runs `work` in a savepoint; returns false (rolled back) when a foreign key forbids it, so a softer fallback can apply. */
function attempt(work: () => void): boolean {
  try {
    transaction(work);
    return true;
  } catch (error) {
    if (error instanceof Error && /FOREIGN KEY constraint failed/i.test(error.message)) return false;
    throw error;
  }
}

export type ErasureReport = Record<string, number>;

/**
 * Irreversible anonymization (Art. 17). Idempotent: running it again on an anonymized account changes nothing
 * meaningful. Module handlers run FIRST (their rows usually reference core rows: children before parents),
 * then core personal data is deleted or scrubbed. Financial, ledger, legal-acceptance and audit rows are kept
 * (legal obligations, Art. 17.3.b/e) and keep pointing to the anonymized user id.
 */
export function anonymizeUser(userId: string): ErasureReport {
  return transaction(() => {
    const report: ErasureReport = {};
    const count = (key: string, result: { changes: number | bigint }) => { report[key] = (report[key] ?? 0) + Number(result.changes); };
    const account = one<{ email: string }>('SELECT email FROM users WHERE id=?', userId);
    if (!account) throw new Error('Compte introuvable.');
    for (const [name, handler] of personalDataHandlers()) {
      handler.erase(userId);
      report[`module:${name}`] = 1;
    }

    count('sessions', run('DELETE FROM sessions WHERE user_id=?', userId));
    count('follows', run('DELETE FROM user_follows WHERE follower_id=? OR following_id=?', userId, userId));
    count('project_follows', run('DELETE FROM project_follows WHERE user_id=?', userId));
    count('bookmarks', run('DELETE FROM bookmarks WHERE user_id=?', userId));
    count('notifications', run('DELETE FROM notifications WHERE user_id=?', userId));
    count('emails', run('DELETE FROM email_outbox WHERE user_id=? OR lower(to_address)=lower(?)', userId, account.email));
    count('post_likes', run('DELETE FROM post_likes WHERE user_id=?', userId));
    count('group_memberships', run('DELETE FROM group_members WHERE user_id=?', userId));
    // A module handler may already have replaced the body with its own marker ('[message supprimé…]'): keep it.
    count('messages', run("UPDATE messages SET body=? WHERE sender_id=? AND body NOT LIKE '[message supprimé%'", SCRUBBED.message, userId));
    count('posts', run('UPDATE posts SET body=? WHERE author_id=? AND body<>?', SCRUBBED.post, userId, SCRUBBED.post));
    count('comments', run('UPDATE comments SET body=? WHERE author_id=? AND body<>?', SCRUBBED.comment, userId, SCRUBBED.comment));
    count('reviews', run('UPDATE reviews SET body=? WHERE author_id=? AND body<>?', SCRUBBED.review, userId, SCRUBBED.review));
    count('task_assignments', run('UPDATE project_tasks SET assignee_id=NULL WHERE assignee_id=?', userId));
    count('invitations', run('DELETE FROM organization_invitations WHERE invitee_id=?', userId));
    count('invitations', run("UPDATE organization_invitations SET status='revoked',responded_at=? WHERE inviter_id=? AND status='pending'", now(), userId));

    for (const application of all<{ id: string }>(`SELECT id FROM applications a WHERE tester_id=? AND status='pending'
      AND NOT EXISTS (SELECT 1 FROM missions m WHERE m.application_id=a.id)`, userId)) {
      if (attempt(() => { run('DELETE FROM applications WHERE id=?', application.id); })) count('applications', { changes: 1 });
    }
    count('applications', run("UPDATE applications SET motivation='' WHERE tester_id=? AND motivation<>''", userId));

    for (const campaign of all<{ id: string; title: string }>("SELECT id,title FROM campaigns WHERE owner_id=? AND status='open'", userId)) {
      run("UPDATE campaigns SET status='closed' WHERE id=?", campaign.id);
      for (const applicant of all<{ id: string; tester_id: string }>("SELECT id,tester_id FROM applications WHERE campaign_id=? AND status='pending'", campaign.id)) {
        run("UPDATE applications SET status='rejected' WHERE id=?", applicant.id);
        notify(applicant.tester_id, 'mission', 'Campagne clôturée', `La campagne « ${campaign.title} » a été clôturée : son organisateur a supprimé son compte.`, '/missions');
      }
      count('campaigns_closed', { changes: 1 });
    }
    count('listings_archived', run("UPDATE listings SET status='archived' WHERE seller_id=? AND status<>'archived'", userId));

    for (const project of all<{ id: string; organization_id: string | null }>('SELECT id,organization_id FROM projects WHERE owner_id=?', userId)) {
      const shared = project.organization_id && one('SELECT 1 FROM organization_members WHERE organization_id=? AND user_id<>?', project.organization_id, userId);
      if (shared) { count('projects_kept', { changes: 1 }); continue; }
      const deleted = attempt(() => {
        run('DELETE FROM posts WHERE project_id=?', project.id);
        run('DELETE FROM integrations WHERE project_id=?', project.id);
        run("DELETE FROM bookmarks WHERE target_type='project' AND target_id=?", project.id);
        run('DELETE FROM projects WHERE id=?', project.id);
      });
      if (deleted) { count('projects_deleted', { changes: 1 }); continue; }
      // Referenced by campaigns, listings or other modules' records: keep a private shell for counterparties.
      count('projects_archived', run(`UPDATE projects SET visibility='private',description='',repo_url='',demo_url='',tags='[]',updated_at=?
        WHERE id=? AND (visibility<>'private' OR description<>'' OR repo_url<>'' OR demo_url<>'' OR tags<>'[]')`, now(), project.id));
    }

    for (const organization of all<{ id: string }>('SELECT id FROM organizations WHERE owner_id=?', userId)) {
      const deleted = attempt(() => { run('DELETE FROM organizations WHERE id=?', organization.id); });
      if (deleted) count('organizations_deleted', { changes: 1 });
      else count('organizations_kept', run("UPDATE organizations SET description='' WHERE id=? AND description<>''", organization.id));
    }
    count('organization_memberships', run(`DELETE FROM organization_members WHERE user_id=?
      AND organization_id NOT IN (SELECT id FROM organizations WHERE owner_id=?)`, userId, userId));

    count('profile', run(`UPDATE users SET name=?,email=?,password_hash=?,title='',bio='',skills='[]',avatar_color='#a59bb0',role='member'
      WHERE id=? AND (name<>? OR email<>? OR password_hash<>? OR title<>'' OR bio<>'' OR skills<>'[]' OR role<>'member')`,
    ERASED_NAME, erasedEmail(userId), ERASED_PASSWORD_HASH, userId, ERASED_NAME, erasedEmail(userId), ERASED_PASSWORD_HASH));
    return report;
  });
}

export type ErasureOutcome =
  | { status: 'completed'; report: ErasureReport }
  | { status: 'blocked'; blockers: Blocker[] }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; error: string };

/** Executes one scheduled erasure in a single transaction (all or nothing). */
export function executeErasure(requestId: string, options: { actorId?: string | null; allowEarly?: boolean } = {}): ErasureOutcome {
  try {
    return transaction((): ErasureOutcome => {
      const request = one<{ id: string; user_id: string; status: string; scheduled_for: string; last_error: string }>(
        "SELECT id,user_id,status,scheduled_for,last_error FROM privacy_requests WHERE id=? AND kind='erasure'", requestId);
      if (!request || request.status !== 'scheduled') return { status: 'skipped', reason: 'La demande n’est pas programmée.' };
      if (!options.allowEarly && request.scheduled_for > now()) return { status: 'skipped', reason: 'Le délai de rétractation n’est pas écoulé.' };
      const blockers = erasureBlockers(request.user_id);
      if (blockers.length) {
        const message = blockers.map((blocker) => blocker.message).join(' ');
        if (message !== request.last_error) {
          notify(request.user_id, 'privacy', 'Suppression de compte en attente',
            `Votre compte ne peut pas encore être supprimé : ${message}`, '/settings#privacy');
        }
        run('UPDATE privacy_requests SET last_error=?,attempts=attempts+1,updated_at=? WHERE id=?', message, now(), request.id);
        return { status: 'blocked', blockers };
      }
      const before = foreignKeyViolations();
      const report = anonymizeUser(request.user_id);
      if (foreignKeyViolations() > before) throw new Error('L’anonymisation laisserait des références orphelines : opération annulée.');
      run("UPDATE privacy_requests SET status='completed',processed_at=?,handled_by=?,last_error='',attempts=attempts+1,updated_at=? WHERE id=?",
        now(), options.actorId ?? null, now(), request.id);
      audit(options.actorId ?? request.user_id, 'privacy.erasure.completed', 'user', request.user_id,
        JSON.stringify({ request_id: request.id, early: !!options.allowEarly, modules: personalDataHandlers().map(([name]) => name) }));
      return { status: 'completed', report };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : 'Erreur inconnue';
    log.error('privacy.erasure_failed', { request_id: requestId, error });
    run('UPDATE privacy_requests SET last_error=?,attempts=attempts+1,updated_at=? WHERE id=?', `Échec technique : ${message}`, now(), requestId);
    return { status: 'failed', error: message };
  }
}

/** Job body: executes every due erasure; throws at the end if one failed so the job run is flagged. */
export function processDueErasures(limit = 50) {
  const due = all<{ id: string }>("SELECT id FROM privacy_requests WHERE kind='erasure' AND status='scheduled' AND scheduled_for<=? ORDER BY scheduled_for LIMIT ?", now(), limit);
  const summary = { completed: 0, blocked: 0, failed: 0, skipped: 0 };
  for (const request of due) summary[executeErasure(request.id).status] += 1;
  if (summary.failed) throw new Error(`${summary.failed} suppression(s) de compte ont échoué. Consultez la console RGPD.`);
  return summary;
}

/** E-mail sent when an erasure is scheduled/cancelled or any request is rejected (queued inside the caller's transaction). */
export function queueErasureEmail(userId: string, kind: 'scheduled' | 'cancelled' | 'rejected', details: { date?: string; reason?: string }) {
  const user = one<{ email: string; name: string }>('SELECT email,name FROM users WHERE id=?', userId);
  if (!user) return;
  const date = details.date ? new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeZone: 'Europe/Paris' }).format(new Date(details.date)) : '';
  const content = kind === 'scheduled'
    ? {
      subject: 'Suppression de votre compte Alpha programmée',
      title: 'La suppression de votre compte est programmée',
      paragraphs: [`Bonjour ${user.name},`, `Vous avez demandé la suppression de votre compte Alpha. Elle sera effectuée le ${date}.`,
        'Jusqu’à cette date, vous pouvez annuler la demande depuis vos paramètres. Ensuite, vos données personnelles seront supprimées ou anonymisées ; seules les pièces comptables et les journaux exigés par la loi seront conservés, sans lien avec votre identité.',
        'Si vous n’êtes pas à l’origine de cette demande, annulez-la immédiatement et changez votre mot de passe.'],
      action: { label: 'Gérer ma demande', url: '/settings#privacy' },
    }
    : kind === 'cancelled'
      ? {
        subject: 'Suppression de votre compte Alpha annulée',
        title: 'La suppression de votre compte est annulée',
        paragraphs: [`Bonjour ${user.name},`, 'Votre demande de suppression de compte a été annulée. Votre compte reste actif.',
          'Si vous n’êtes pas à l’origine de cette annulation, contactez-nous et changez votre mot de passe.'],
        action: { label: 'Ouvrir mes paramètres', url: '/settings#privacy' },
      }
      : {
        subject: 'Votre demande relative à vos données personnelles',
        title: 'Votre demande n’a pas pu être satisfaite',
        paragraphs: [`Bonjour ${user.name},`, `Votre demande n’a pas pu être exécutée pour le motif suivant : ${details.reason ?? ''}`,
          'Vous pouvez contacter notre délégué à la protection des données ou introduire une réclamation auprès de la CNIL (www.cnil.fr).'],
        action: { label: 'Ouvrir mes paramètres', url: '/settings#privacy' },
      };
  const { text, html } = renderEmail({ title: content.title, paragraphs: content.paragraphs, action: content.action });
  queueEmail({ to: user.email, userId, category: kind === 'rejected' ? 'privacy.request_rejected' : `privacy.erasure_${kind}`, subject: content.subject, text, html });
}
