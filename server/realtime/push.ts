import { generateVAPIDKeys, sendNotification, type RequestOptions } from 'web-push';
import { z } from 'zod';
import { all, one, run, transaction } from '../db.js';
import { id, now } from '../core.js';
import { registerJob } from '../platform/jobs.js';
import { log } from '../platform/log.js';
import { seal, sha256Hex, unseal } from '../platform/secrets.js';
import { appOrigin, getSecretSetting, getSetting, setSecretSetting, setSetting } from '../platform/settings.js';
import { categoryDefinition, safeInternalLink, type NotificationCategory } from './categories.js';
import { PUSH_VAPID_SETTING, pushConfig, pushEnabled } from './channels.js';

/**
 * Web Push (RFC 8030 + VAPID RFC 8292). Payloads are encrypted end-to-end by web-push (aes128gcm) and only
 * contain a title, a short non-sensitive body and a same-origin link. Delivery is asynchronous through the
 * `push_outbox` table and the `push.deliver` job so a slow push service never blocks a business action.
 */
export const MAX_SUBSCRIPTIONS_PER_USER = 10;
const MAX_ATTEMPTS = 5;
const MAX_SUBSCRIPTION_FAILURES = 5;
const SUBSCRIPTION_CONTEXT = 'push_subscription';

/** Browser push services only: the server must never be tricked into POSTing to arbitrary hosts (SSRF). */
const exactHosts = new Set(['fcm.googleapis.com', 'web.push.apple.com']);
const suffixHosts = ['.push.services.mozilla.com', '.notify.windows.com', '.push.apple.com'];
export function allowedPushHost(host: string): boolean {
  const normalized = host.toLowerCase();
  if (exactHosts.has(normalized)) return true;
  return suffixHosts.some((suffix) => normalized.endsWith(suffix) && normalized.length > suffix.length
    && /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(normalized.slice(0, -suffix.length)));
}

function decodedLength(value: string): number {
  return Buffer.from(value, 'base64url').length;
}

const base64url = z.string().regex(/^[A-Za-z0-9_-]+={0,2}$/, 'Clé encodée invalide.');
export const subscriptionInput = z.object({
  endpoint: z.string().min(12).max(2048).superRefine((value, context) => {
    if (!URL.canParse(value)) { context.addIssue({ code: 'custom', message: 'Adresse de notification invalide.' }); return; }
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) {
      context.addIssue({ code: 'custom', message: 'Le service de notification doit utiliser HTTPS sans port ni identifiants.' });
    } else if (!allowedPushHost(url.hostname)) {
      context.addIssue({ code: 'custom', message: 'Service de notification push non pris en charge.' });
    }
  }),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    p256dh: base64url.max(200).refine((value) => {
      const bytes = Buffer.from(value, 'base64url');
      return bytes.length === 65 && bytes[0] === 0x04;
    }, 'Clé publique P-256 invalide.'),
    auth: base64url.max(64).refine((value) => decodedLength(value) === 16, 'Secret d’authentification invalide.'),
  }).strict(),
}).strict();
export type SubscriptionInput = z.infer<typeof subscriptionInput>;

interface SealedSubscription { endpoint: string; keys: { p256dh: string; auth: string } }
export interface PushPayload { title: string; body: string; link: string; tag: string }
export type PushSender = (subscription: SealedSubscription, payload: string, options: RequestOptions) => Promise<{ statusCode: number }>;

const defaultSender: PushSender = (subscription, payload, options) => sendNotification(subscription, payload, options);
let sender: PushSender = defaultSender;
/** Tests inject a fake push service. `null` restores the real web-push sender. */
export function setPushSenderForTests(fake: PushSender | null) { sender = fake ?? defaultSender; }

const vapidValue = z.object({ public_key: z.string().min(20).max(200), created_at: z.string() }).strict();

/** VAPID keys are generated on first use; the private key is sealed in `platform_settings`. */
export function vapidKeys(create = true): { publicKey: string; privateKey: string; createdAt: string } | null {
  const stored = getSetting<z.infer<typeof vapidValue> | null>(PUSH_VAPID_SETTING, vapidValue.nullable(), null);
  const privateKey = stored ? getSecretSetting(PUSH_VAPID_SETTING) : null;
  if (stored && privateKey) return { publicKey: stored.public_key, privateKey, createdAt: stored.created_at };
  if (!create) return null;
  return transaction(() => {
    const again = getSetting<z.infer<typeof vapidValue> | null>(PUSH_VAPID_SETTING, vapidValue.nullable(), null);
    const againPrivate = again ? getSecretSetting(PUSH_VAPID_SETTING) : null;
    if (again && againPrivate) return { publicKey: again.public_key, privateKey: againPrivate, createdAt: again.created_at };
    const keys = generateVAPIDKeys();
    const createdAt = now();
    setSetting(PUSH_VAPID_SETTING, { public_key: keys.publicKey, created_at: createdAt }, null);
    setSecretSetting(PUSH_VAPID_SETTING, keys.privateKey, null);
    log.info('push.vapid_generated', {});
    return { publicKey: keys.publicKey, privateKey: keys.privateKey, createdAt };
  });
}

/** Rotating keys invalidates every browser subscription (they are bound to the old public key). Must run in a transaction. */
export function resetVapidKeys(actorId: string) {
  const removed = Number(run('DELETE FROM push_subscriptions').changes);
  const keys = generateVAPIDKeys();
  setSetting(PUSH_VAPID_SETTING, { public_key: keys.publicKey, created_at: now() }, actorId);
  setSecretSetting(PUSH_VAPID_SETTING, keys.privateKey, actorId);
  return { removed, public_key: keys.publicKey };
}

export function vapidSubject(): string {
  const configured = pushConfig().subject;
  if (configured) return configured;
  const origin = appOrigin();
  return origin.startsWith('https://') ? origin : 'mailto:notifications@alpha.local';
}

export function subscriptionHash(endpoint: string) { return sha256Hex(endpoint); }

/** Upserts the browser subscription for the user (a device switching account is re-assigned). Must run in a transaction. */
export function saveSubscription(userId: string, input: SubscriptionInput, userAgent: string) {
  const hash = subscriptionHash(input.endpoint);
  const host = new URL(input.endpoint).hostname.toLowerCase();
  const sealed = seal(JSON.stringify({ endpoint: input.endpoint, keys: input.keys }), SUBSCRIPTION_CONTEXT);
  const timestamp = now();
  const existing = one<{ id: string }>('SELECT id FROM push_subscriptions WHERE endpoint_hash=?', hash);
  const subscriptionId = existing?.id ?? id();
  if (existing) {
    run(`UPDATE push_subscriptions SET user_id=?,sealed=?,endpoint_host=?,user_agent=?,failures=0,last_error='',updated_at=? WHERE id=?`,
      userId, sealed, host, userAgent.slice(0, 200), timestamp, subscriptionId);
  } else {
    run(`INSERT INTO push_subscriptions(id,user_id,endpoint_hash,endpoint_host,sealed,user_agent,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`,
      subscriptionId, userId, hash, host, sealed, userAgent.slice(0, 200), timestamp, timestamp);
  }
  const extra = all<{ id: string }>(`SELECT id FROM push_subscriptions WHERE user_id=? ORDER BY updated_at DESC, created_at DESC LIMIT -1 OFFSET ?`,
    userId, MAX_SUBSCRIPTIONS_PER_USER);
  for (const row of extra) run('DELETE FROM push_subscriptions WHERE id=?', row.id);
  return { id: subscriptionId, created: !existing };
}

export function listSubscriptions(userId: string) {
  return all<{ id: string; endpoint_host: string; user_agent: string; failures: number; last_success_at: string | null; created_at: string }>(
    'SELECT id,endpoint_host,user_agent,failures,last_success_at,created_at FROM push_subscriptions WHERE user_id=? ORDER BY created_at DESC', userId);
}

/** Enqueues a push for every device of the user. Called from the notification hook (inside the transaction). */
export function enqueuePush(userId: string, notificationId: string | null, category: NotificationCategory, title: string, body: string, link: string) {
  const subscriptions = all<{ id: string }>('SELECT id FROM push_subscriptions WHERE user_id=?', userId);
  if (!subscriptions.length) return 0;
  const definition = categoryDefinition(category);
  const payload: PushPayload = {
    title: title.slice(0, 120),
    body: definition.privateBody ? 'Ouvrez Alpha pour voir le détail.' : body.replace(/\s+/g, ' ').trim().slice(0, 140),
    link: safeInternalLink(link),
    // Same link = same tag: a busy conversation replaces its previous notification on the device instead of stacking.
    tag: `alpha-${category}-${sha256Hex(safeInternalLink(link)).slice(0, 16)}`,
  };
  const serialized = JSON.stringify(payload);
  for (const subscription of subscriptions) {
    run('INSERT INTO push_outbox(id,subscription_id,user_id,notification_id,payload) VALUES (?,?,?,?,?)',
      id(), subscription.id, userId, notificationId, serialized);
  }
  return subscriptions.length;
}

function readSubscription(sealed: string): SealedSubscription | null {
  try {
    return JSON.parse(unseal(sealed, SUBSCRIPTION_CONTEXT)) as SealedSubscription;
  } catch {
    return null;
  }
}

function errorStatus(error: unknown): number {
  return typeof error === 'object' && error && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 0;
}

function errorMessage(error: unknown, status: number) {
  const message = error instanceof Error ? error.message : 'Erreur du service push';
  return `${status ? `HTTP ${status} ` : ''}${message}`.replace(/https?:\/\/\S+/g, '[url]').slice(0, 300);
}

export interface PushDeliveryResult { sent: number; failed: number; retried: number; removed: number }

export async function deliverQueuedPushes(limit = 50): Promise<PushDeliveryResult> {
  const result: PushDeliveryResult = { sent: 0, failed: 0, retried: 0, removed: 0 };
  if (!pushEnabled()) return result;
  const keys = vapidKeys(false);
  if (!keys) return result;
  const config = pushConfig();
  const due = all<{ id: string; subscription_id: string; payload: string; attempts: number; sealed: string }>(
    `SELECT o.id,o.subscription_id,o.payload,o.attempts,s.sealed FROM push_outbox o JOIN push_subscriptions s ON s.id=o.subscription_id
     WHERE o.status='queued' AND o.send_after<=? ORDER BY o.created_at LIMIT ?`, now(), limit);
  for (const item of due) {
    if (Number(run("UPDATE push_outbox SET status='sending',attempts=attempts+1 WHERE id=? AND status='queued'", item.id).changes) !== 1) continue;
    const subscription = readSubscription(item.sealed);
    if (!subscription || !URL.canParse(subscription.endpoint) || !allowedPushHost(new URL(subscription.endpoint).hostname)) {
      run('DELETE FROM push_subscriptions WHERE id=?', item.subscription_id);
      result.removed += 1;
      continue;
    }
    try {
      await sender(subscription, item.payload, {
        vapidDetails: { subject: vapidSubject(), publicKey: keys.publicKey, privateKey: keys.privateKey },
        TTL: config.ttl_seconds, timeout: 10000, contentEncoding: 'aes128gcm', urgency: 'normal',
      });
      transaction(() => {
        run("UPDATE push_outbox SET status='sent',sent_at=?,last_error='' WHERE id=?", now(), item.id);
        run("UPDATE push_subscriptions SET failures=0,last_error='',last_success_at=? WHERE id=?", now(), item.subscription_id);
      });
      result.sent += 1;
    } catch (error) {
      const status = errorStatus(error);
      const message = errorMessage(error, status);
      if (status === 404 || status === 410) {
        // The browser unsubscribed or the subscription expired: forget it (queued rows cascade).
        run('DELETE FROM push_subscriptions WHERE id=?', item.subscription_id);
        result.removed += 1;
        continue;
      }
      const permanent = status === 400 || status === 403 || status === 413;
      const attempts = item.attempts + 1;
      transaction(() => {
        if (permanent || attempts >= MAX_ATTEMPTS) {
          run("UPDATE push_outbox SET status='failed',last_error=? WHERE id=?", message, item.id);
          result.failed += 1;
        } else {
          run("UPDATE push_outbox SET status='queued',last_error=?,send_after=? WHERE id=?", message,
            new Date(Date.now() + Math.min(3600000, 30000 * 2 ** attempts)).toISOString(), item.id);
          result.retried += 1;
        }
        run('UPDATE push_subscriptions SET failures=failures+1,last_error=?,updated_at=? WHERE id=?', message, now(), item.subscription_id);
        if (permanent) run('DELETE FROM push_subscriptions WHERE id=? AND failures>=?', item.subscription_id, MAX_SUBSCRIPTION_FAILURES);
      });
      log.warn('push.failed', { outbox_id: item.id, status, attempts });
    }
  }
  return result;
}

export function recoverStuckPushes() {
  run("UPDATE push_outbox SET status='queued' WHERE status='sending'");
}

export function purgePushOutbox() {
  run("DELETE FROM push_outbox WHERE status='sent' AND created_at<?", new Date(Date.now() - 7 * 86400000).toISOString());
  run("DELETE FROM push_outbox WHERE status='failed' AND created_at<?", new Date(Date.now() - 30 * 86400000).toISOString());
}

export function pushStatus() {
  const keys = vapidKeys(false);
  const counts = one<{ subscriptions: number; users: number; failing: number }>(`SELECT COUNT(*) AS subscriptions, COUNT(DISTINCT user_id) AS users,
    COALESCE(SUM(failures>0),0) AS failing FROM push_subscriptions`)!;
  const outbox = one<{ queued: number; sent: number; failed: number }>(`SELECT COALESCE(SUM(status IN ('queued','sending')),0) AS queued,
    COALESCE(SUM(status='sent'),0) AS sent, COALESCE(SUM(status='failed'),0) AS failed FROM push_outbox`)!;
  const recentFailures = all<{ id: string; endpoint_host: string; last_error: string; created_at: string }>(
    `SELECT o.id,COALESCE(s.endpoint_host,'') AS endpoint_host,o.last_error,o.created_at FROM push_outbox o
     LEFT JOIN push_subscriptions s ON s.id=o.subscription_id WHERE o.status='failed' ORDER BY o.created_at DESC LIMIT 10`);
  const hosts = all<{ endpoint_host: string; count: number }>(
    'SELECT endpoint_host,COUNT(*) AS count FROM push_subscriptions GROUP BY endpoint_host ORDER BY count DESC LIMIT 10');
  const config = pushConfig();
  return {
    enabled: config.enabled,
    subject: config.subject,
    effective_subject: vapidSubject(),
    ttl_seconds: config.ttl_seconds,
    public_key: keys?.publicKey ?? null,
    private_key: { configured: !!keys, mask: keys ? '••••••••' : '' },
    keys_created_at: keys?.createdAt ?? null,
    ...counts,
    hosts,
    outbox,
    recent_failures: recentFailures,
  };
}

registerJob({
  name: 'push.deliver',
  description: 'Envoie les notifications Web Push en file d’attente (VAPID) et nettoie les abonnements expirés.',
  intervalMs: 10000,
  enabled: () => pushEnabled(),
  run: async () => {
    recoverStuckPushes();
    const result = await deliverQueuedPushes();
    purgePushOutbox();
    if (result.sent || result.failed || result.removed) log.info('push.delivered', { ...result });
  },
});
