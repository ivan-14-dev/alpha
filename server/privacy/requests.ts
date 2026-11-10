import { all, one, run, transaction } from '../db.js';
import { audit, HttpError, id, notify, now } from '../core.js';
import { log } from '../platform/log.js';
import { queueEmail, renderEmail } from '../platform/mailer.js';
import { erasureBlockers, queueErasureEmail } from './erasure.js';
import { daysAhead, ERASURE_GRACE_DAYS, EXPORT_RATE_WINDOW_MS, EXPORT_VALIDITY_DAYS, RESPONSE_DEADLINE_DAYS } from './settings.js';

export type RequestKind = 'export' | 'erasure';
export type RequestStatus = 'pending' | 'processing' | 'ready' | 'scheduled' | 'completed' | 'cancelled' | 'rejected';

export interface PrivacyRequestRow {
  id: string;
  user_id: string;
  kind: RequestKind;
  status: RequestStatus;
  reason: string;
  requested_at: string;
  scheduled_for: string | null;
  processed_at: string | null;
  expires_at: string | null;
  downloaded_at: string | null;
  download_count: number;
  rejection_reason: string;
  handled_by: string | null;
  attempts: number;
  last_error: string;
  updated_at: string;
}

const columns = 'id,user_id,kind,status,reason,requested_at,scheduled_for,processed_at,expires_at,downloaded_at,download_count,rejection_reason,handled_by,attempts,last_error,updated_at';

export function getRequest(requestId: string): PrivacyRequestRow | undefined {
  return one<PrivacyRequestRow>(`SELECT ${columns} FROM privacy_requests WHERE id=?`, requestId);
}

export function isDownloadable(request: Pick<PrivacyRequestRow, 'kind' | 'status' | 'expires_at'>, at = now()) {
  return request.kind === 'export' && request.status === 'ready' && !!request.expires_at && request.expires_at > at;
}

const deadline = (requestedAt: string) => new Date(Date.parse(requestedAt) + RESPONSE_DEADLINE_DAYS * 86400000).toISOString();

/** Member-facing view: no admin identity, no technical error. */
export function memberView(request: PrivacyRequestRow) {
  return {
    id: request.id, kind: request.kind, status: request.status, reason: request.reason,
    requested_at: request.requested_at, scheduled_for: request.scheduled_for, processed_at: request.processed_at,
    expires_at: request.expires_at, downloaded_at: request.downloaded_at, download_count: request.download_count,
    rejection_reason: request.rejection_reason,
    download_url: isDownloadable(request) ? `/api/privacy/exports/${request.id}/download` : null,
  };
}

export function adminView(request: PrivacyRequestRow & { user_name?: string; user_email?: string; handled_by_name?: string | null }) {
  const at = now();
  return {
    ...memberView(request),
    user_id: request.user_id, user_name: request.user_name ?? null, user_email: request.user_email ?? null,
    handled_by: request.handled_by, handled_by_name: request.handled_by_name ?? null,
    attempts: request.attempts, last_error: request.last_error, updated_at: request.updated_at,
    response_deadline: deadline(request.requested_at),
    overdue: ['pending', 'processing'].includes(request.status) && deadline(request.requested_at) < at,
    due: request.kind === 'erasure' && request.status === 'scheduled' && !!request.scheduled_for && request.scheduled_for <= at,
  };
}

export function requestsFor(userId: string) {
  return all<PrivacyRequestRow>(`SELECT ${columns} FROM privacy_requests WHERE user_id=? ORDER BY requested_at DESC,id DESC LIMIT 50`, userId);
}

/** Art. 15/20 request. Limited to one per 24 h (rejected/cancelled requests do not count). */
export function createExportRequest(userId: string, reason = ''): PrivacyRequestRow {
  return transaction(() => {
    const since = new Date(Date.now() - EXPORT_RATE_WINDOW_MS).toISOString();
    const recent = one<{ requested_at: string }>(`SELECT requested_at FROM privacy_requests WHERE user_id=? AND kind='export'
      AND requested_at>? AND status NOT IN ('rejected','cancelled') ORDER BY requested_at DESC LIMIT 1`, userId, since);
    if (recent) {
      const retry = new Date(Date.parse(recent.requested_at) + EXPORT_RATE_WINDOW_MS);
      const error = new HttpError(429, `Vous avez déjà demandé un export dans les dernières 24 heures. Nouvel essai possible le ${new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Paris' }).format(retry)}.`);
      Object.assign(error, { retryAfter: Math.max(1, Math.ceil((retry.getTime() - Date.now()) / 1000)) });
      throw error;
    }
    const requestId = id();
    run("INSERT INTO privacy_requests(id,user_id,kind,status,reason,requested_at,updated_at) VALUES (?,?,'export','pending',?,?,?)",
      requestId, userId, reason, now(), now());
    audit(userId, 'privacy.export.requested', 'privacy_request', requestId);
    return getRequest(requestId)!;
  });
}

/**
 * Makes a pending export downloadable for 7 days. The archive itself is built on demand at download time,
 * so no copy of the personal data is stored at rest.
 */
export function processExport(requestId: string, actorId: string | null = null): PrivacyRequestRow {
  return transaction(() => {
    const request = getRequest(requestId);
    if (!request || request.kind !== 'export') throw new HttpError(404, 'Demande introuvable.');
    if (request.status === 'ready') return request;
    if (!['pending', 'processing'].includes(request.status)) throw new HttpError(409, 'Cette demande d’export est déjà clôturée.');
    const expiresAt = daysAhead(EXPORT_VALIDITY_DAYS);
    run("UPDATE privacy_requests SET status='ready',processed_at=?,expires_at=?,handled_by=?,attempts=attempts+1,last_error='',updated_at=? WHERE id=?",
      now(), expiresAt, actorId, now(), requestId);
    notify(request.user_id, 'privacy', 'Votre export de données est prêt',
      `Téléchargeable depuis vos paramètres pendant ${EXPORT_VALIDITY_DAYS} jours.`, '/settings#privacy');
    const user = one<{ email: string; name: string }>('SELECT email,name FROM users WHERE id=?', request.user_id);
    if (user) {
      const { text, html } = renderEmail({
        title: 'Votre export de données est prêt',
        paragraphs: [`Bonjour ${user.name},`,
          `L’export de vos données personnelles est disponible dans vos paramètres pendant ${EXPORT_VALIDITY_DAYS} jours. Le téléchargement nécessite d’être connecté à votre compte.`,
          'Si vous n’êtes pas à l’origine de cette demande, changez votre mot de passe et déconnectez vos autres sessions.'],
        action: { label: 'Télécharger mes données', url: '/settings#privacy' },
      });
      queueEmail({ to: user.email, userId: request.user_id, category: 'privacy.export_ready', subject: 'Votre export de données Alpha est prêt', text, html });
    }
    if (actorId) audit(actorId, 'privacy.admin.export_processed', 'privacy_request', requestId);
    return getRequest(requestId)!;
  });
}

/** Job body: retries exports left pending (e.g. after a crash) and closes expired download links. */
export function processPendingExports(limit = 50) {
  const pending = all<{ id: string }>("SELECT id FROM privacy_requests WHERE kind='export' AND status IN ('pending','processing') AND attempts<5 ORDER BY requested_at LIMIT ?", limit);
  let failed = 0;
  for (const request of pending) {
    try { processExport(request.id); } catch (error) {
      failed += 1;
      log.error('privacy.export_failed', { request_id: request.id, error });
      run('UPDATE privacy_requests SET attempts=attempts+1,last_error=?,updated_at=? WHERE id=?', error instanceof Error ? error.message.slice(0, 500) : 'Erreur inconnue', now(), request.id);
    }
  }
  const expired = Number(run("UPDATE privacy_requests SET status='completed',updated_at=? WHERE kind='export' AND status='ready' AND expires_at<=?", now(), now()).changes);
  return { processed: pending.length - failed, failed, expired };
}

export function recordDownload(request: PrivacyRequestRow) {
  transaction(() => {
    run('UPDATE privacy_requests SET downloaded_at=?,download_count=download_count+1,updated_at=? WHERE id=?', now(), now(), request.id);
    audit(request.user_id, 'privacy.export.downloaded', 'privacy_request', request.id);
  });
}

export function activeErasure(userId: string): PrivacyRequestRow | undefined {
  return one<PrivacyRequestRow>(`SELECT ${columns} FROM privacy_requests WHERE user_id=? AND kind='erasure' AND status IN ('pending','processing','scheduled')`, userId);
}

/** Art. 17 request: scheduled after a 30-day grace period during which it can be cancelled. Caller verified the identity. */
export function scheduleErasure(userId: string, reason: string): PrivacyRequestRow {
  return transaction(() => {
    if (activeErasure(userId)) throw new HttpError(409, 'Une suppression de compte est déjà programmée.');
    const blockers = erasureBlockers(userId);
    if (blockers.length) {
      throw Object.assign(new HttpError(409, `Votre compte ne peut pas encore être supprimé. ${blockers.map((blocker) => blocker.message).join(' ')}`), { blockers });
    }
    const requestId = id();
    const scheduledFor = daysAhead(ERASURE_GRACE_DAYS);
    run("INSERT INTO privacy_requests(id,user_id,kind,status,reason,requested_at,scheduled_for,updated_at) VALUES (?,?,'erasure','scheduled',?,?,?,?)",
      requestId, userId, reason, now(), scheduledFor, now());
    queueErasureEmail(userId, 'scheduled', { date: scheduledFor });
    notify(userId, 'privacy', 'Suppression de compte programmée',
      `Votre compte sera supprimé dans ${ERASURE_GRACE_DAYS} jours. Vous pouvez annuler d’ici là.`, '/settings#privacy');
    audit(userId, 'privacy.erasure.requested', 'privacy_request', requestId, JSON.stringify({ scheduled_for: scheduledFor }));
    return getRequest(requestId)!;
  });
}

export function cancelErasure(userId: string): PrivacyRequestRow {
  return transaction(() => {
    const request = activeErasure(userId);
    if (!request) throw new HttpError(404, 'Aucune suppression de compte n’est programmée.');
    run("UPDATE privacy_requests SET status='cancelled',processed_at=?,updated_at=? WHERE id=?", now(), now(), request.id);
    queueErasureEmail(userId, 'cancelled', {});
    notify(userId, 'privacy', 'Suppression de compte annulée', 'Votre compte reste actif.', '/settings#privacy');
    audit(userId, 'privacy.erasure.cancelled', 'privacy_request', request.id);
    return getRequest(request.id)!;
  });
}

/** Admin refusal with a legal reason (Art. 12.4: the user is told why and how to complain to the CNIL). */
export function rejectRequest(requestId: string, adminId: string, reason: string): PrivacyRequestRow {
  return transaction(() => {
    const request = getRequest(requestId);
    if (!request) throw new HttpError(404, 'Demande introuvable.');
    const open = request.kind === 'erasure' ? ['pending', 'processing', 'scheduled'] : ['pending', 'processing'];
    if (!open.includes(request.status)) throw new HttpError(409, 'Seule une demande en cours peut être refusée.');
    run("UPDATE privacy_requests SET status='rejected',rejection_reason=?,handled_by=?,processed_at=?,updated_at=? WHERE id=?",
      reason, adminId, now(), now(), requestId);
    queueErasureEmail(request.user_id, 'rejected', { reason });
    notify(request.user_id, 'privacy', request.kind === 'erasure' ? 'Demande de suppression refusée' : 'Demande d’export refusée',
      `Motif : ${reason}`, '/settings#privacy');
    audit(adminId, 'privacy.admin.request_rejected', 'privacy_request', requestId, JSON.stringify({ kind: request.kind }));
    return getRequest(requestId)!;
  });
}
