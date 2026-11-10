import { all, one, run, transaction } from '../db.js';
import { now } from '../core.js';
import { registerJob } from '../platform/jobs.js';
import { log } from '../platform/log.js';
import { queueEmail, renderEmail } from '../platform/mailer.js';
import { SELF_EMAILED_KINDS, categoryDefinition, categoryDefinitions, categoryForKind, safeInternalLink, type NotificationCategory } from './categories.js';
import { emailNotificationsEnabled } from './channels.js';
import { emailFrequency, hasVerifiedColumn, preferencesFor, verifiedEmail } from './preferences.js';

/** Upper bound of immediate notification emails per user and rolling hour (anti-flood). */
export const EMAIL_HOURLY_LIMIT = 20;
const DIGEST_INTERVAL_MS = 24 * 3600000;
/** Jobs run hourly, so a digest is due slightly before the exact 24 h mark. */
const DIGEST_TOLERANCE_MS = 30 * 60000;
const DIGEST_MAX_ITEMS = 25;
const FOOTER = 'Vous recevez cet e-mail selon vos préférences de notification. Modifiez-les dans Alpha > Paramètres > Notifications.';

/**
 * Queues an immediate notification email inside the notification transaction when allowed:
 * global switch on, category email preference on, verified address, frequency `immediate`
 * (account/security notices are always immediate), no identical queued email, under the hourly cap.
 */
export function queueNotificationEmail(event: { id: string; user_id: string; kind: string; title: string; body: string; link: string }, category: NotificationCategory): boolean {
  if (!emailNotificationsEnabled()) return false;
  if (SELF_EMAILED_KINDS.has(event.kind.trim().toLowerCase())) return false;
  if (!preferencesFor(event.user_id)[category].email) return false;
  const to = verifiedEmail(event.user_id);
  if (!to) return false;
  if (category !== 'account' && emailFrequency(event.user_id) === 'daily') return false;
  const link = safeInternalLink(event.link);
  const emailCategory = `notification.${category}`;
  if (one('SELECT 1 FROM email_outbox WHERE user_id=? AND category=? AND status=\'queued\' AND subject=?', event.user_id, emailCategory, event.title.slice(0, 160))) return false;
  const recent = one<{ count: number }>(`SELECT COUNT(*) AS count FROM email_outbox WHERE user_id=? AND category LIKE 'notification.%' AND created_at>?`,
    event.user_id, new Date(Date.now() - 3600000).toISOString())!.count;
  if (recent >= EMAIL_HOURLY_LIMIT) {
    log.info('realtime.email_throttled', { user_id: event.user_id, category });
    return false;
  }
  const definition = categoryDefinition(category);
  const paragraphs = definition.privateBody || !event.body.trim()
    ? [category === 'messages' ? 'Vous avez reçu un nouveau message privé sur Alpha.' : 'Une nouvelle notification vous attend sur Alpha.']
    : [event.body.slice(0, 1200)];
  const rendered = renderEmail({ title: event.title.slice(0, 160), paragraphs, action: { label: 'Ouvrir dans Alpha', url: link }, footer: FOOTER });
  queueEmail({ to, userId: event.user_id, category: emailCategory, subject: event.title.slice(0, 160), text: rendered.text, html: rendered.html,
    sensitive: definition.privateBody });
  return true;
}

interface DigestCandidate { user_id: string; last_digest_at: string | null }

/** Sends one digest per due user (frequency `daily`) with unread notifications of email-enabled categories. */
export function runDigest(reference = Date.now()) {
  const result = { users: 0, emails: 0 };
  if (!emailNotificationsEnabled() || !hasVerifiedColumn()) return result;
  const threshold = new Date(reference - DIGEST_INTERVAL_MS + DIGEST_TOLERANCE_MS).toISOString();
  const due = all<DigestCandidate>(`SELECT user_id,last_digest_at FROM notification_settings
    WHERE email_frequency='daily' AND (last_digest_at IS NULL OR last_digest_at<=?) ORDER BY last_digest_at LIMIT 200`, threshold);
  for (const candidate of due) {
    result.users += 1;
    transaction(() => {
      const timestamp = now();
      const since = candidate.last_digest_at ?? new Date(reference - DIGEST_INTERVAL_MS).toISOString();
      run('UPDATE notification_settings SET last_digest_at=? WHERE user_id=?', timestamp, candidate.user_id);
      const to = verifiedEmail(candidate.user_id);
      if (!to) return;
      const preferences = preferencesFor(candidate.user_id);
      const notifications = all<{ kind: string; title: string; link: string }>(
        'SELECT kind,title,link FROM notifications WHERE user_id=? AND read_at IS NULL AND created_at>=? ORDER BY created_at DESC LIMIT 200',
        candidate.user_id, since)
        .filter((item) => {
          const category = categoryForKind(item.kind);
          return category !== 'account' && preferences[category].email;
        })
        .slice(0, DIGEST_MAX_ITEMS);
      if (!notifications.length) return;
      const counts = new Map<NotificationCategory, number>();
      for (const item of notifications) counts.set(categoryForKind(item.kind), (counts.get(categoryForKind(item.kind)) ?? 0) + 1);
      const summary = categoryDefinitions.filter((definition) => counts.has(definition.id))
        .map((definition) => `${definition.label} : ${counts.get(definition.id)}`).join(' · ');
      const rendered = renderEmail({
        title: `Votre résumé Alpha : ${notifications.length} notification${notifications.length > 1 ? 's' : ''} non lue${notifications.length > 1 ? 's' : ''}`,
        paragraphs: [summary, ...notifications.slice(0, 10).map((item) => `• ${item.title.slice(0, 160)}`)],
        action: { label: 'Voir mes notifications', url: '/notifications' },
        footer: FOOTER,
      });
      queueEmail({ to, userId: candidate.user_id, category: 'notification.digest', subject: 'Votre résumé quotidien Alpha',
        text: rendered.text, html: rendered.html, sensitive: false });
      result.emails += 1;
    });
  }
  return result;
}

registerJob({
  name: 'realtime.digest',
  description: 'Envoie le résumé quotidien des notifications non lues aux membres qui l’ont choisi.',
  intervalMs: 3600000,
  enabled: () => emailNotificationsEnabled(),
  run: () => {
    const result = runDigest();
    if (result.emails) log.info('realtime.digest_sent', result);
  },
});
