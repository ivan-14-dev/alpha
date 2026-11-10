import { one, transaction } from '../db.js';
import { onNotification, publishToUser } from '../platform/events.js';
import { log } from '../platform/log.js';
import { categoryForKind, safeInternalLink } from './categories.js';
import { pushEnabled } from './channels.js';
import { queueNotificationEmail } from './email.js';
import { preferencesFor } from './preferences.js';
import { enqueuePush } from './push.js';

export function unreadCount(userId: string): number {
  return one<{ count: number }>('SELECT COUNT(*) AS count FROM notifications WHERE user_id=? AND read_at IS NULL', userId)!.count;
}

/** Publishes the current unread counter (after commit) to every open tab of the user. */
export function publishUnread(userId: string) {
  publishToUser(userId, { type: 'notification.read', data: { unread: unreadCount(userId) } });
}

/**
 * Notification channels. Runs synchronously inside the transaction of `core.notify()`:
 * - realtime: `notification.created` (published after COMMIT by publishToUser);
 * - email/push: outbox rows written in a SAVEPOINT. A channel failure is logged and never rolls back
 *   the business action that created the notification.
 */
onNotification('realtime', (event) => {
  const category = categoryForKind(event.kind);
  publishToUser(event.user_id, {
    type: 'notification.created',
    data: {
      id: event.id,
      kind: event.kind,
      category,
      title: event.title,
      body: event.body,
      link: safeInternalLink(event.link),
      unread: unreadCount(event.user_id),
      created_at: new Date().toISOString(),
    },
  });
  try {
    transaction(() => {
      queueNotificationEmail(event, category);
      if (pushEnabled() && preferencesFor(event.user_id)[category].push) {
        enqueuePush(event.user_id, event.id, category, event.title, event.body, event.link);
      }
    });
  } catch (error) {
    log.error('realtime.channels_failed', { user_id: event.user_id, kind: event.kind, error });
  }
});
