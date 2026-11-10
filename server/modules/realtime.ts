import { Router } from 'express';
import { z } from 'zod';
import { all, one, run, transaction } from '../db.js';
import { audit, HttpError, param, requireUser } from '../core.js';
import { publishToUser } from '../platform/events.js';
import { requireCapability } from '../platform/guards.js';
import { registerPersonalData } from '../platform/privacy.js';
import { rateLimit } from '../platform/rateLimit.js';
import admin from '../realtime/admin.js';
import { categoryDefinitions } from '../realtime/categories.js';
import { channelsStatus } from '../realtime/channels.js';
import '../realtime/email.js';
import { unreadCount } from '../realtime/hooks.js';
import { emailFrequency, hasVerifiedColumn, preferencesFor, preferencesInput, updatePreferences, verifiedEmail } from '../realtime/preferences.js';
import { listSubscriptions, saveSubscription, subscriptionHash, subscriptionInput, vapidKeys } from '../realtime/push.js';
import { openStream } from '../realtime/sse.js';

/**
 * Realtime & notifications API: SSE stream, unread counter, typing indicator, notification
 * preferences (email/push per category) and Web Push subscriptions. Admin routes live in ../realtime/admin.ts.
 */
const router = Router();
const userKey = (req: { user?: { id: string } }) => req.user?.id ?? 'anonymous';

router.get('/stream', (req, _res, next) => { requireUser(req); next(); }, rateLimit({
  name: 'realtime.stream', limit: 30, windowMs: 60000, key: userKey,
  message: 'Trop de reconnexions au flux temps réel. Patientez une minute.',
}), (req, res) => {
  const user = requireUser(req);
  openStream(req, res, user, () => ({ unread: unreadCount(user.id), heartbeat_ms: 25000 }));
});

router.get('/unread', (req, res) => {
  const user = requireUser(req);
  res.json({ unread: unreadCount(user.id) });
});

function preferencesPayload(userId: string) {
  const preferences = preferencesFor(userId);
  return {
    categories: categoryDefinitions.map((definition) => ({
      id: definition.id,
      label: definition.label,
      description: definition.description,
      in_app: true,
      email: preferences[definition.id].email,
      push: preferences[definition.id].push,
      defaults: definition.defaults,
    })),
    email_frequency: emailFrequency(userId),
    email_verified: !!verifiedEmail(userId),
    email_verification_available: hasVerifiedColumn(),
    channels: channelsStatus(),
    push_subscriptions: listSubscriptions(userId),
  };
}

router.get('/preferences', (req, res) => {
  const user = requireUser(req);
  res.json(preferencesPayload(user.id));
});

router.put('/preferences', (req, _res, next) => { requireUser(req); next(); },
  rateLimit({ name: 'realtime.preferences', limit: 60, windowMs: 60000, key: userKey }), (req, res) => {
    const user = requireUser(req);
    const input = preferencesInput.parse(req.body);
    transaction(() => updatePreferences(user.id, input));
    res.json(preferencesPayload(user.id));
  });

const lastTyping = new Map<string, number>();
const TYPING_THROTTLE_MS = 2500;

router.post('/typing', (req, _res, next) => { requireCapability(req, 'message'); next(); }, rateLimit({
  name: 'realtime.typing', limit: 40, windowMs: 60000, key: userKey,
  message: 'Trop d’indicateurs de saisie envoyés.',
}), (req, res) => {
  const user = requireCapability(req, 'message');
  const { conversation_id: conversationId } = z.object({
    conversation_id: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/),
  }).strict().parse(req.body);
  const members = all<{ user_id: string }>('SELECT user_id FROM conversation_members WHERE conversation_id=?', conversationId);
  // Same answer for unknown conversations and conversations of others (no existence oracle).
  if (!members.some((member) => member.user_id === user.id)) throw new HttpError(404, 'Conversation introuvable.');
  const key = `${user.id}:${conversationId}`;
  const current = Date.now();
  if ((lastTyping.get(key) ?? 0) + TYPING_THROTTLE_MS <= current) {
    lastTyping.set(key, current);
    if (lastTyping.size > 10000) for (const [entry, at] of lastTyping) if (at + 60000 < current) lastTyping.delete(entry);
    for (const member of members) {
      if (member.user_id === user.id) continue;
      publishToUser(member.user_id, { type: 'typing', data: { conversation_id: conversationId, user_id: user.id, name: user.name } });
    }
  }
  res.status(202).json({ ok: true });
});

router.get('/push/public-key', (req, res) => {
  requireUser(req);
  if (!channelsStatus().push) {
    res.json({ enabled: false, public_key: null });
    return;
  }
  res.json({ enabled: true, public_key: vapidKeys(true)!.publicKey });
});

router.get('/push/subscriptions', (req, res) => {
  const user = requireUser(req);
  res.json({ subscriptions: listSubscriptions(user.id) });
});

router.post('/push/subscriptions', (req, _res, next) => { requireUser(req); next(); }, rateLimit({
  name: 'realtime.push-subscribe', limit: 20, windowMs: 3600000, key: userKey,
  message: 'Trop d’abonnements push enregistrés. Réessayez plus tard.',
}), (req, res) => {
  const user = requireUser(req);
  if (!channelsStatus().push) throw new HttpError(409, 'Les notifications push sont désactivées sur la plateforme.');
  const input = subscriptionInput.parse(req.body);
  const saved = transaction(() => {
    const result = saveSubscription(user.id, input, String(req.headers['user-agent'] ?? ''));
    if (result.created) audit(user.id, 'realtime.push_subscribed', 'push_subscription', result.id, new URL(input.endpoint).hostname);
    return result;
  });
  res.status(saved.created ? 201 : 200).json({ subscription: listSubscriptions(user.id).find((item) => item.id === saved.id) });
});

function deleteSubscription(userId: string, where: { id?: string; endpoint?: string }) {
  return transaction(() => {
    const row = where.id
      ? one<{ id: string }>('SELECT id FROM push_subscriptions WHERE id=? AND user_id=?', where.id, userId)
      : one<{ id: string }>('SELECT id FROM push_subscriptions WHERE endpoint_hash=? AND user_id=?', subscriptionHash(where.endpoint!), userId);
    if (!row) throw new HttpError(404, 'Abonnement introuvable.');
    run('DELETE FROM push_subscriptions WHERE id=?', row.id);
    audit(userId, 'realtime.push_unsubscribed', 'push_subscription', row.id, '');
    return row.id;
  });
}

router.delete('/push/subscriptions', (req, res) => {
  const user = requireUser(req);
  const { endpoint } = z.object({ endpoint: z.string().min(12).max(2048) }).strict().parse(req.body);
  res.json({ deleted: deleteSubscription(user.id, { endpoint }) });
});

router.delete('/push/subscriptions/:id', (req, res) => {
  const user = requireUser(req);
  const subscriptionId = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/).parse(param(req));
  res.json({ deleted: deleteSubscription(user.id, { id: subscriptionId }) });
});

router.use('/admin', admin);

registerPersonalData('realtime', {
  description: 'Préférences de notification, appareils abonnés aux notifications push et accusés de lecture des conversations.',
  export(userId) {
    return {
      preferences: preferencesFor(userId),
      email_frequency: emailFrequency(userId),
      push_subscriptions: listSubscriptions(userId),
      conversation_reads: all('SELECT conversation_id,last_read_at FROM conversation_reads WHERE user_id=? ORDER BY last_read_at DESC', userId),
    };
  },
  erase(userId) {
    run('DELETE FROM push_outbox WHERE user_id=?', userId);
    run('DELETE FROM push_subscriptions WHERE user_id=?', userId);
    run('DELETE FROM notification_preferences WHERE user_id=?', userId);
    run('DELETE FROM notification_settings WHERE user_id=?', userId);
    run('DELETE FROM conversation_reads WHERE user_id=?', userId);
  },
});

export default router;
