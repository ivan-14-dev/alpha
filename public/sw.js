/* Alpha service worker — Web Push only (no offline cache, no fetch interception). OWNER: realtime module. */
'use strict';

const ICON = '/favicon.svg';
const FALLBACK_URL = '/notifications';

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });

/** Only same-origin paths are ever opened, whatever the payload says. */
function safeUrl(value) {
  try {
    const url = new URL(typeof value === 'string' && value ? value : FALLBACK_URL, self.location.origin);
    return url.origin === self.location.origin && (url.protocol === 'https:' || url.protocol === 'http:') ? url.href : new URL(FALLBACK_URL, self.location.origin).href;
  } catch {
    return new URL(FALLBACK_URL, self.location.origin).href;
  }
}

function text(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch { payload = { body: event.data ? event.data.text() : '' }; }
  const title = text(payload.title, 120) || 'Alpha';
  const options = {
    body: text(payload.body, 240),
    icon: ICON,
    badge: ICON,
    lang: 'fr',
    tag: text(payload.tag, 80) || undefined,
    renotify: !!payload.tag,
    data: { url: safeUrl(payload.link) },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = safeUrl(event.notification.data && event.notification.data.url);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const sameOrigin = windows.filter((client) => new URL(client.url).origin === self.location.origin);
    const exact = sameOrigin.find((client) => client.url === target);
    if (exact) return exact.focus();
    const existing = sameOrigin.find((client) => 'navigate' in client) || sameOrigin[0];
    if (existing) {
      const focused = await existing.focus();
      if ('navigate' in focused) {
        try { return await focused.navigate(target); } catch { /* uncontrolled client: fall through */ }
      }
      return focused;
    }
    return self.clients.openWindow(target);
  })());
});

function base64UrlToBytes(value) {
  const padded = `${value}${'='.repeat((4 - (value.length % 4)) % 4)}`.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

/** The browser rotated the subscription: subscribe again with the current VAPID key and register it (session cookie required). */
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const response = await fetch('/api/realtime/push/public-key', { credentials: 'same-origin', headers: { 'X-Alpha-Client': 'web' } });
    if (!response.ok) return;
    const { enabled, public_key: publicKey } = await response.json();
    if (!enabled || !publicKey) return;
    const subscription = event.newSubscription
      || await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(publicKey) });
    const json = subscription.toJSON();
    if (!json.endpoint || !json.keys) return;
    await fetch('/api/realtime/push/subscriptions', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Alpha-Client': 'web' },
      body: JSON.stringify({ endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } }),
    });
  })().catch(() => undefined));
});
