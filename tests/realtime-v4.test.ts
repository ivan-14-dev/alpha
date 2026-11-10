import assert from 'node:assert/strict';
import { createECDH, createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

process.env.DATABASE_PATH = ':memory:';
const { app } = await import('../server/app.js');
const { all, one, run, transaction } = await import('../server/db.js');
const { notify } = await import('../server/core.js');
const { runJob } = await import('../server/platform/jobs.js');
const { setMailTransportForTests } = await import('../server/platform/mailer.js');
const { personalDataHandlers } = await import('../server/platform/privacy.js');
const { closeAllStreams, setRealtimeTimingForTests, userStreamCount, MAX_CONNECTIONS_PER_USER } = await import('../server/realtime/sse.js');
const { setPushSenderForTests, allowedPushHost } = await import('../server/realtime/push.js');
const { runDigest } = await import('../server/realtime/email.js');
const { categoryForKind, safeInternalLink } = await import('../server/realtime/categories.js');

interface Actor { id: string; name: string; email: string; password: string; cookie: string }
interface SseEvent { type: string; data: Record<string, unknown> }
interface Stream {
  status: number;
  headers: Headers;
  events: SseEvent[];
  comments: string[];
  error: unknown;
  closed: () => boolean;
  waitFor: (type: string, predicate?: (data: Record<string, unknown>) => boolean, timeoutMs?: number) => Promise<SseEvent>;
  waitClosed: (timeoutMs?: number) => Promise<void>;
  close: () => void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const WEB_HEADERS = { 'X-Alpha-Client': 'web', Origin: 'http://127.0.0.1:5173' };

async function until(check: () => boolean, timeoutMs = 3000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timeout waiting for ${label}`);
    await sleep(10);
  }
}

function pushKeys() {
  const ecdh = createECDH('prime256v1');
  return { p256dh: ecdh.generateKeys().toString('base64url'), auth: randomBytes(16).toString('base64url') };
}

test('V4 realtime & notifications', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  t.after(async () => {
    setRealtimeTimingForTests({ heartbeatMs: 25000 });
    closeAllStreams();
    setPushSenderForTests(null);
    setMailTransportForTests(null);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  });

  async function request<T>(actor: Actor | null, path: string, expected = 200, method = 'GET', body?: unknown) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(method === 'GET' ? {} : WEB_HEADERS),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(actor?.cookie ? { Cookie: actor.cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    assert.equal(response.status, expected, `${method} ${path}: ${text}`);
    const cookie = response.headers.get('set-cookie');
    if (actor && cookie) actor.cookie = cookie.split(';', 1)[0];
    const data = (text ? JSON.parse(text) : null) as T;
    if (expected >= 400) assert.equal(typeof (data as { error?: unknown }).error, 'string', 'Errors must be actionable JSON');
    return { data, text, response };
  }
  const api = async <T = Record<string, unknown>>(actor: Actor | null, path: string, expected = 200, method = 'GET', body?: unknown) =>
    (await request<T>(actor, path, expected, method, body)).data;

  async function stream(actor: Actor | null): Promise<Stream> {
    const controller = new AbortController();
    const response = await fetch(`${base}/realtime/stream`, {
      headers: { Accept: 'text/event-stream', ...(actor?.cookie ? { Cookie: actor.cookie } : {}) },
      signal: controller.signal,
    });
    const events: SseEvent[] = [];
    const comments: string[] = [];
    let closed = false;
    let error: unknown = null;
    if (response.status === 200) {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      void (async () => {
        let buffer = '';
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let index: number;
            while ((index = buffer.indexOf('\n\n')) >= 0) {
              const chunk = buffer.slice(0, index);
              buffer = buffer.slice(index + 2);
              let type = 'message';
              const data: string[] = [];
              for (const line of chunk.split('\n')) {
                if (line.startsWith(':')) comments.push(line);
                else if (line.startsWith('event: ')) type = line.slice(7);
                else if (line.startsWith('data: ')) data.push(line.slice(6));
              }
              if (data.length) events.push({ type, data: JSON.parse(data.join('\n')) });
            }
          }
        } catch (caught) {
          error = caught;
        }
        closed = true;
      })();
    } else {
      closed = true;
    }
    return {
      status: response.status,
      headers: response.headers,
      events,
      comments,
      get error() { return error; },
      closed: () => closed,
      async waitFor(type, predicate = () => true, timeoutMs = 3000) {
        let found: SseEvent | undefined;
        await until(() => !!(found = events.find((event) => event.type === type && predicate(event.data))), timeoutMs, `event ${type}`);
        return found!;
      },
      waitClosed: (timeoutMs = 3000) => until(() => closed, timeoutMs, 'stream close'),
      close: () => controller.abort(),
    };
  }

  function actor(name: string): Actor {
    return { id: '', name, email: `${name.toLowerCase()}@example.test`, password: 'Alpha-realtime-password-2026!', cookie: '' };
  }
  const admin = actor('Admin');
  const alice = actor('Alice');
  const bob = actor('Bob');
  const outsider = actor('Outsider');
  for (const account of [admin, alice, bob, outsider]) {
    const data = await api<{ user: { id: string } }>(account, '/auth/register', 201, 'POST', {
      name: account.name, email: account.email, password: account.password, accept_terms: true,
    });
    account.id = data.user.id;
  }
  run("UPDATE users SET role='admin' WHERE id=?", admin.id);
  if (!all<{ name: string }>('PRAGMA table_info(users)').some((column) => column.name === 'email_verified_at')) {
    run('ALTER TABLE users ADD COLUMN email_verified_at TEXT');
  }
  const verify = (account: Actor, verified: boolean) =>
    run('UPDATE users SET email_verified_at=? WHERE id=?', verified ? new Date().toISOString() : null, account.id);
  const notificationEmails = (account: Actor) => all<{ id: string; category: string; subject: string; text_body: string; sensitive: number }>(
    "SELECT id,category,subject,text_body,sensitive FROM email_outbox WHERE user_id=? AND category LIKE 'notification.%' ORDER BY created_at,rowid", account.id);
  let conversationId = '';

  await t.test('kinds map to categories and links stay same-origin', () => {
    assert.equal(categoryForKind('message'), 'messages');
    assert.equal(categoryForKind('payment'), 'payments');
    assert.equal(categoryForKind('network.follow'), 'network');
    assert.equal(categoryForKind('community.project_update'), 'community');
    assert.equal(categoryForKind('dispute'), 'trust');
    assert.equal(categoryForKind('application'), 'testing');
    assert.equal(categoryForKind('order'), 'marketplace');
    assert.equal(categoryForKind('something.new'), 'account');
    assert.equal(safeInternalLink('//evil.example/x'), '/notifications');
    assert.equal(safeInternalLink('javascript:alert(1)'), '/notifications');
    assert.equal(safeInternalLink('/messages?conversation=abc'), '/messages?conversation=abc');
    assert.ok(allowedPushHost('fcm.googleapis.com'));
    assert.ok(allowedPushHost('updates.push.services.mozilla.com'));
    assert.ok(allowedPushHost('wns2-par02p.notify.windows.com'));
    assert.ok(allowedPushHost('web.push.apple.com'));
    assert.ok(!allowedPushHost('push.services.mozilla.com.evil.example'));
    assert.ok(!allowedPushHost('evilfcm.googleapis.com'));
    assert.ok(!allowedPushHost('.push.apple.com'));
  });

  await t.test('the stream requires a session and uses SSE headers', async () => {
    const anonymous = await stream(null);
    assert.equal(anonymous.status, 401);
    const live = await stream(alice);
    assert.equal(live.status, 200);
    assert.match(live.headers.get('content-type') ?? '', /^text\/event-stream/);
    assert.equal(live.headers.get('cache-control'), 'no-store');
    assert.equal(live.headers.get('x-accel-buffering'), 'no');
    const ready = await live.waitFor('ready');
    assert.equal(ready.data.unread, 0);
    assert.deepEqual(await api(alice, '/realtime/unread'), { unread: 0 });
    await api(null, '/realtime/unread', 401);
    live.close();
    await until(() => userStreamCount(alice.id) === 0, 3000, 'server cleanup');
  });

  await t.test('real actions publish notification.created and message events to participants only', async () => {
    const [aliceStream, bobStream, outsiderStream] = await Promise.all([stream(alice), stream(bob), stream(outsider)]);
    await Promise.all([aliceStream.waitFor('ready'), bobStream.waitFor('ready'), outsiderStream.waitFor('ready')]);

    const created = await api<{ conversation: { id: string } }>(alice, '/communication/conversations', 201, 'POST', {
      recipient_id: bob.id, subject: 'Recette de la version 2', body: 'Bonjour Bob, peux-tu tester la connexion ?',
    });
    conversationId = created.conversation.id;
    const notice = await bobStream.waitFor('notification.created');
    assert.equal(notice.data.kind, 'message');
    assert.equal(notice.data.category, 'messages');
    assert.equal(notice.data.link, `/messages?conversation=${conversationId}`);
    assert.equal(notice.data.unread, 1);
    const bobMessage = await bobStream.waitFor('message.created');
    assert.equal(bobMessage.data.conversation_id, conversationId);
    assert.equal((bobMessage.data.message as { body: string }).body, 'Bonjour Bob, peux-tu tester la connexion ?');
    assert.ok(bobMessage.data.conversation, 'new conversations are announced with their metadata');
    await aliceStream.waitFor('message.created');

    const reply = await api<{ message: { id: string } }>(bob, `/communication/conversations/${conversationId}/messages`, 201, 'POST', { body: 'Oui, je regarde ça.' });
    const aliceNotice = await aliceStream.waitFor('notification.created');
    assert.equal(aliceNotice.data.unread, 1);
    await aliceStream.waitFor('message.created', (data) => (data.message as { id: string }).id === reply.message.id);

    // Typing indicator: only the other participants, never the author nor outsiders.
    await api(bob, '/realtime/typing', 202, 'POST', { conversation_id: conversationId });
    const typing = await aliceStream.waitFor('typing');
    assert.deepEqual({ conversation_id: typing.data.conversation_id, user_id: typing.data.user_id }, { conversation_id: conversationId, user_id: bob.id });
    await api(outsider, '/realtime/typing', 404, 'POST', { conversation_id: conversationId });
    await api(outsider, '/realtime/typing', 404, 'POST', { conversation_id: 'does-not-exist' });
    await api(bob, '/realtime/typing', 400, 'POST', { conversation_id: conversationId, extra: true });
    await api(null, '/realtime/typing', 401, 'POST', { conversation_id: conversationId });

    // Read receipt: participants see conversation.read, the reader gets the new unread counter.
    const read = await api<{ notifications_read: number; unread_count: number }>(bob, `/communication/conversations/${conversationId}/read`, 200, 'POST', {});
    assert.equal(read.notifications_read, 1);
    assert.equal(read.unread_count, 0);
    const receipt = await aliceStream.waitFor('conversation.read', (data) => data.user_id === bob.id);
    assert.equal(receipt.data.conversation_id, conversationId);
    const bobUnread = await bobStream.waitFor('notification.read');
    assert.equal(bobUnread.data.unread, 0);
    await api(outsider, `/communication/conversations/${conversationId}/read`, 404, 'POST', {});
    const thread = await api<{ reads: { user_id: string }[] }>(alice, `/communication/conversations/${conversationId}`);
    assert.ok(thread.reads.some((entry) => entry.user_id === bob.id));
    const list = await api<{ conversations: { id: string; unread_count: number }[] }>(alice, '/communication/conversations');
    assert.equal(list.conversations.find((item) => item.id === conversationId)!.unread_count, 1);

    // Marking notifications read through the inbox also updates the live counter.
    await api(alice, '/communication/notifications/read-all', 200, 'POST', {});
    const aliceRead = await aliceStream.waitFor('notification.read');
    assert.equal(aliceRead.data.unread, 0);

    await sleep(100);
    assert.deepEqual(outsiderStream.events.map((event) => event.type), ['ready'], 'outsider must not receive any private event');
    assert.ok(!bobStream.events.some((event) => event.type === 'typing'), 'authors do not receive their own typing events');
    assert.ok(!aliceStream.events.some((event) => event.type === 'notification.created' && event.data.link !== `/messages?conversation=${conversationId}`));
    closeAllStreams();
    await Promise.all([aliceStream.waitClosed(), bobStream.waitClosed(), outsiderStream.waitClosed()]);
  });

  await t.test('rolled back actions never publish events nor queue channels', async () => {
    verify(alice, true);
    const live = await stream(alice);
    await live.waitFor('ready');
    const before = notificationEmails(alice).length;
    assert.throws(() => transaction(() => {
      notify(alice.id, 'payment', 'Paiement annulé', 'Ne doit pas partir', '/wallet');
      throw new Error('business failure');
    }), /business failure/);
    await sleep(80);
    assert.ok(!live.events.some((event) => event.type === 'notification.created'));
    assert.equal(notificationEmails(alice).length, before);
    live.close();
  });

  await t.test('each user is limited to a few simultaneous streams', async () => {
    closeAllStreams();
    const streams: Stream[] = [];
    for (let index = 0; index < MAX_CONNECTIONS_PER_USER; index += 1) {
      const opened = await stream(outsider);
      assert.equal(opened.status, 200);
      streams.push(opened);
    }
    const refused = await stream(outsider);
    assert.equal(refused.status, 429);
    assert.equal(userStreamCount(outsider.id), MAX_CONNECTIONS_PER_USER);
    const otherUser = await stream(bob);
    assert.equal(otherUser.status, 200, 'the cap is per user');
    streams[0].close();
    await until(() => userStreamCount(outsider.id) === MAX_CONNECTIONS_PER_USER - 1, 3000, 'slot release');
    const again = await stream(outsider);
    assert.equal(again.status, 200);
    closeAllStreams();
    assert.equal(userStreamCount(outsider.id), 0);
  });

  await t.test('revoked or expired sessions close their streams', async () => {
    closeAllStreams();
    const secondDevice: Actor = { ...alice, cookie: '' };
    await api(secondDevice, '/auth/login', 200, 'POST', { email: alice.email, password: alice.password });
    assert.notEqual(secondDevice.cookie, alice.cookie);
    const live = await stream(secondDevice);
    await live.waitFor('ready');
    const sessions = await api<{ sessions: { id: string; current: boolean }[] }>(alice, '/auth/sessions');
    const other = sessions.sessions.find((session) => !session.current)!;
    await api(alice, `/auth/sessions/${other.id}`, 200, 'DELETE');
    const expired = await live.waitFor('session.expired');
    assert.equal(expired.data.reason, 'session');
    await live.waitClosed();
    assert.equal(userStreamCount(alice.id), 0);

    // Expiry without any audited event is caught by the heartbeat revalidation.
    setRealtimeTimingForTests({ heartbeatMs: 40 });
    const thirdDevice: Actor = { ...alice, cookie: '' };
    await api(thirdDevice, '/auth/login', 200, 'POST', { email: alice.email, password: alice.password });
    const pinged = await stream(thirdDevice);
    await pinged.waitFor('ready');
    await until(() => pinged.comments.some((line) => line.startsWith(': ping')), 2000, 'heartbeat');
    assert.ok(!pinged.closed(), 'a valid session stays open across heartbeats');
    const token = thirdDevice.cookie.split('=')[1];
    run('UPDATE sessions SET expires_at=? WHERE token_hash=?', new Date(Date.now() - 1000).toISOString(), createHash('sha256').update(token).digest('hex'));
    await pinged.waitFor('session.expired', () => true, 2000);
    await pinged.waitClosed();
    setRealtimeTimingForTests({ heartbeatMs: 25000 });
    // The main session is untouched.
    const main = await stream(alice);
    assert.equal(main.status, 200);
    main.close();
  });

  await t.test('preferences have defaults, are validated and are private to each member', async () => {
    await api(null, '/realtime/preferences', 401);
    const defaults = await api<{ categories: { id: string; email: boolean; push: boolean; in_app: boolean }[]; email_frequency: string }>(alice, '/realtime/preferences');
    const byId = Object.fromEntries(defaults.categories.map((category) => [category.id, category]));
    assert.deepEqual(Object.keys(byId).sort(), ['account', 'community', 'marketplace', 'messages', 'network', 'payments', 'testing', 'trust']);
    assert.equal(byId.payments.email, true);
    assert.equal(byId.trust.email, true);
    assert.equal(byId.account.email, true);
    assert.equal(byId.testing.email, true);
    assert.equal(byId.community.email, false);
    assert.equal(byId.network.email, false);
    assert.equal(byId.messages.push, true);
    assert.ok(defaults.categories.every((category) => category.in_app));
    assert.equal(defaults.email_frequency, 'immediate');

    await api(alice, '/realtime/preferences', 400, 'PUT', { categories: { unknown: { email: true } } });
    await api(alice, '/realtime/preferences', 400, 'PUT', { categories: { payments: { email: 'yes' } } });
    await api(alice, '/realtime/preferences', 400, 'PUT', { categories: { payments: { sms: true } } });
    await api(alice, '/realtime/preferences', 400, 'PUT', { email_frequency: 'weekly' });
    await api(alice, '/realtime/preferences', 400, 'PUT', { in_app: false });
    const updated = await api<{ categories: { id: string; email: boolean; push: boolean }[] }>(alice, '/realtime/preferences', 200, 'PUT', {
      categories: { community: { email: true }, payments: { push: false } },
    });
    const after = Object.fromEntries(updated.categories.map((category) => [category.id, category]));
    assert.deepEqual({ email: after.community.email, push: after.community.push }, { email: true, push: false });
    assert.deepEqual({ email: after.payments.email, push: after.payments.push }, { email: true, push: false });
    const bobPrefs = await api<{ categories: { id: string; email: boolean }[] }>(bob, '/realtime/preferences');
    assert.equal(bobPrefs.categories.find((category) => category.id === 'community')!.email, false);
    await api(alice, '/realtime/preferences', 200, 'PUT', { categories: { community: { email: false }, payments: { push: true } } });
  });

  await t.test('notification emails are queued only for verified addresses with the channel enabled', async () => {
    run("DELETE FROM email_outbox WHERE category LIKE 'notification.%'");
    verify(alice, false);
    notify(alice.id, 'payment', 'Paiement reçu (non vérifié)', 'Montant : 12 €', '/wallet');
    assert.equal(notificationEmails(alice).length, 0, 'unverified address: no email');

    verify(alice, true);
    notify(alice.id, 'payment', 'Paiement reçu', 'Montant : 12 €', '/wallet');
    let emails = notificationEmails(alice);
    assert.equal(emails.length, 1);
    assert.equal(emails[0].category, 'notification.payments');
    assert.equal(emails[0].sensitive, 1);
    assert.ok(!emails[0].text_body.includes('12 €'), 'private categories never copy the notification body');
    assert.match(emails[0].text_body, /\/wallet/);

    notify(alice.id, 'community.project_update', 'Nouvelle actualité', 'Version 2 publiée', '/projects/x');
    assert.equal(notificationEmails(alice).length, 1, 'community emails are off by default');
    await api(alice, '/realtime/preferences', 200, 'PUT', { categories: { community: { email: true } } });
    notify(alice.id, 'community.project_update', 'Nouvelle actualité 2', 'Version 2.1 publiée', '//evil.example/phish');
    emails = notificationEmails(alice);
    assert.equal(emails.length, 2);
    assert.match(emails[1].text_body, /Version 2\.1 publiée/);
    assert.ok(!emails[1].text_body.includes('evil.example'), 'unsafe links are replaced');

    await api(alice, '/realtime/preferences', 200, 'PUT', { categories: { payments: { email: false } } });
    notify(alice.id, 'payment', 'Paiement reçu 2', 'Montant : 13 €', '/wallet');
    assert.equal(notificationEmails(alice).length, 2, 'disabled category: no email');

    // Global admin kill switch.
    await api(alice, '/realtime/admin/channels', 403, 'PUT', { email_notifications: false });
    await api(admin, '/realtime/admin/channels', 200, 'PUT', { email_notifications: false });
    notify(alice.id, 'dispute', 'Litige ouvert', 'Détails', '/trust');
    assert.equal(notificationEmails(alice).length, 2, 'kill switch: no email');
    await api(admin, '/realtime/admin/channels', 200, 'PUT', { email_notifications: true });
    assert.ok(one("SELECT 1 FROM audit_events WHERE action='realtime.channels_updated' AND actor_id=?", admin.id));

    // Messages: email off by default, even through a real action.
    verify(bob, true);
    await api(alice, `/communication/conversations/${conversationId}/messages`, 201, 'POST', { body: 'Message privé à ne pas envoyer par e-mail.' });
    assert.equal(notificationEmails(bob).length, 0);

    // Daily digest: immediate emails stop (except account notices) and a single summary is queued.
    await api(alice, '/realtime/preferences', 200, 'PUT', { email_frequency: 'daily' });
    notify(alice.id, 'community.project_update', 'Actualité du soir', 'Nouvelle version', '/projects/y');
    assert.equal(notificationEmails(alice).length, 2);
    notify(alice.id, 'security.login', 'Nouvelle connexion', 'Depuis un nouvel appareil', '/settings');
    assert.equal(notificationEmails(alice).at(-1)!.category, 'notification.account');
    assert.deepEqual(runDigest(Date.now()), { users: 0, emails: 0 }, 'digest is not due yet');
    const digest = runDigest(Date.now() + 25 * 3600000);
    assert.equal(digest.emails, 1);
    const summary = notificationEmails(alice).at(-1)!;
    assert.equal(summary.category, 'notification.digest');
    assert.match(summary.text_body, /Actualité du soir/);
    assert.ok(!summary.text_body.includes('Nouvelle connexion'), 'account notices are sent immediately, not in the digest');
    await api(alice, '/realtime/preferences', 200, 'PUT', { email_frequency: 'immediate', categories: { community: { email: false }, payments: { email: true } } });
  });

  await t.test('push subscriptions are validated against browser push services', async () => {
    await api(null, '/realtime/push/public-key', 401);
    const key = await api<{ enabled: boolean; public_key: string }>(alice, '/realtime/push/public-key');
    assert.equal(key.enabled, true);
    assert.equal(Buffer.from(key.public_key, 'base64url').length, 65);
    assert.equal((await api<{ public_key: string }>(bob, '/realtime/push/public-key')).public_key, key.public_key, 'keys are generated once');
    const stored = one<{ value: string; secret: string }>("SELECT value,secret FROM platform_settings WHERE key='push.vapid'")!;
    assert.ok(stored.secret && !stored.value.includes(stored.secret));

    const keys = pushKeys();
    for (const endpoint of [
      'https://evil.example.com/push/abc',
      'http://fcm.googleapis.com/fcm/send/abc',
      'https://fcm.googleapis.com:8443/fcm/send/abc',
      'https://user:pass@fcm.googleapis.com/fcm/send/abc',
      'https://169.254.169.254/latest/meta-data',
      'https://fcm.googleapis.com.evil.example/fcm/send/abc',
      'not a url at all',
    ]) {
      await api(alice, '/realtime/push/subscriptions', 400, 'POST', { endpoint, keys });
    }
    await api(alice, '/realtime/push/subscriptions', 400, 'POST', { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { ...keys, p256dh: randomBytes(32).toString('base64url') } });
    await api(alice, '/realtime/push/subscriptions', 400, 'POST', { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { ...keys, auth: randomBytes(8).toString('base64url') } });
    await api(null, '/realtime/push/subscriptions', 401, 'POST', { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys });
    assert.equal(one<{ count: number }>('SELECT COUNT(*) AS count FROM push_subscriptions')!.count, 0);

    const fcm = { endpoint: `https://fcm.googleapis.com/fcm/send/${randomBytes(12).toString('hex')}`, expirationTime: null, keys };
    const created = await api<{ subscription: { id: string; endpoint_host: string } }>(alice, '/realtime/push/subscriptions', 201, 'POST', fcm);
    assert.equal(created.subscription.endpoint_host, 'fcm.googleapis.com');
    const again = await api<{ subscription: { id: string } }>(alice, '/realtime/push/subscriptions', 200, 'POST', fcm);
    assert.equal(again.subscription.id, created.subscription.id, 'subscribing twice is idempotent');
    const row = one<{ sealed: string }>('SELECT sealed FROM push_subscriptions WHERE id=?', created.subscription.id)!;
    assert.ok(!row.sealed.includes('fcm.googleapis.com') && !row.sealed.includes(keys.auth), 'endpoint and keys are sealed at rest');
    const list = await request(alice, '/realtime/push/subscriptions');
    assert.ok(!list.text.includes(fcm.endpoint) && !list.text.includes(keys.p256dh));
    await api(bob, `/realtime/push/subscriptions/${created.subscription.id}`, 404, 'DELETE');
    await api(bob, '/realtime/push/subscriptions', 404, 'DELETE', { endpoint: fcm.endpoint });
  });

  await t.test('the push.deliver job sends minimal payloads, retries and removes gone subscriptions', async () => {
    const mozilla = { endpoint: `https://updates.push.services.mozilla.com/wpush/v2/${randomBytes(16).toString('hex')}`, keys: pushKeys() };
    await api(alice, '/realtime/push/subscriptions', 201, 'POST', mozilla);
    run('DELETE FROM push_outbox');
    const sent: { endpoint: string; payload: Record<string, string>; ttl: number | undefined; subject: string | undefined }[] = [];
    let mode: 'ok' | 'gone' | 'error' = 'gone';
    setPushSenderForTests(async (subscription, payload, options) => {
      if (subscription.endpoint.includes('mozilla') && mode === 'gone') throw Object.assign(new Error('Gone'), { statusCode: 410 });
      if (mode === 'error') throw Object.assign(new Error('Service Unavailable'), { statusCode: 503 });
      sent.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload), ttl: options.TTL, subject: options.vapidDetails?.subject });
      return { statusCode: 201 };
    });

    await api(bob, `/communication/conversations/${conversationId}/messages`, 201, 'POST', { body: 'Contenu confidentiel du message.' });
    assert.equal(one<{ count: number }>("SELECT COUNT(*) AS count FROM push_outbox WHERE user_id=? AND status='queued'", alice.id)!.count, 2);
    await runJob('push.deliver');
    assert.equal(sent.length, 1);
    assert.match(sent[0].endpoint, /fcm\.googleapis\.com/);
    assert.equal(sent[0].payload.link, `/messages?conversation=${conversationId}`);
    assert.match(sent[0].payload.title, /Bob/);
    assert.ok(!JSON.stringify(sent[0].payload).includes('confidentiel'), 'private message content never leaves in push payloads');
    assert.deepEqual(Object.keys(sent[0].payload).sort(), ['body', 'link', 'tag', 'title']);
    assert.equal(sent[0].ttl, 86400);
    assert.match(sent[0].subject ?? '', /^(mailto:|https:)/);
    assert.equal(one<{ count: number }>("SELECT COUNT(*) AS count FROM push_subscriptions WHERE endpoint_host LIKE '%mozilla%'")!.count, 0, '410 removes the subscription');
    assert.equal(one<{ count: number }>("SELECT COUNT(*) AS count FROM push_outbox WHERE status='sent'")!.count, 1);

    mode = 'error';
    notify(alice.id, 'application', 'Candidature acceptée', 'Votre candidature a été retenue.', '/testing');
    await runJob('push.deliver');
    const retried = one<{ status: string; attempts: number; send_after: string; last_error: string }>(
      "SELECT status,attempts,send_after,last_error FROM push_outbox WHERE status<>'sent' ORDER BY created_at DESC LIMIT 1")!;
    assert.equal(retried.status, 'queued');
    assert.equal(retried.attempts, 1);
    assert.ok(Date.parse(retried.send_after) > Date.now());
    assert.match(retried.last_error, /503/);
    mode = 'ok';
    run("UPDATE push_outbox SET send_after=? WHERE status='queued'", new Date(Date.now() - 1000).toISOString());
    await runJob('push.deliver');
    assert.equal(sent.at(-1)!.payload.body, 'Votre candidature a été retenue.');
    assert.equal(one<{ count: number }>("SELECT COUNT(*) AS count FROM push_outbox WHERE status='queued'")!.count, 0);

    // Preference off: nothing is enqueued.
    await api(alice, '/realtime/preferences', 200, 'PUT', { categories: { testing: { push: false } } });
    const before = one<{ count: number }>('SELECT COUNT(*) AS count FROM push_outbox')!.count;
    notify(alice.id, 'application', 'Autre candidature', 'Texte', '/testing');
    assert.equal(one<{ count: number }>('SELECT COUNT(*) AS count FROM push_outbox')!.count, before);
    await api(alice, '/realtime/preferences', 200, 'PUT', { categories: { testing: { push: true } } });

    // Admin kill switch for push.
    await api(admin, '/realtime/admin/channels', 200, 'PUT', { push: false });
    assert.deepEqual(await api(alice, '/realtime/push/public-key'), { enabled: false, public_key: null });
    await api(alice, '/realtime/push/subscriptions', 409, 'POST', { endpoint: 'https://web.push.apple.com/abc123def456', keys: pushKeys() });
    notify(alice.id, 'application', 'Encore une', 'Texte', '/testing');
    assert.equal(one<{ count: number }>('SELECT COUNT(*) AS count FROM push_outbox')!.count, before);
    await api(admin, '/realtime/admin/channels', 200, 'PUT', { push: true });

    const owned = await api<{ subscriptions: { id: string }[] }>(alice, '/realtime/push/subscriptions');
    assert.equal(owned.subscriptions.length, 1);
    await api(alice, `/realtime/push/subscriptions/${owned.subscriptions[0].id}`, 200, 'DELETE');
    assert.equal((await api<{ subscriptions: unknown[] }>(alice, '/realtime/push/subscriptions')).subscriptions.length, 0);
  });

  await t.test('admin email & push console never exposes secrets', async () => {
    await api(null, '/realtime/admin/status', 401);
    await api(alice, '/realtime/admin/status', 403);
    await api(alice, '/realtime/admin/email/smtp', 403, 'PUT', { host: 'smtp.example.test', port: 587, secure: false, user: 'x', from: 'a@b.test' });
    const password = 'Sup3r-Secret-SMTP-Pass!';
    const smtp = { host: 'smtp.example.test', port: 587, secure: false, user: 'mailer', from: 'Alpha <no-reply@example.test>', password };
    await api(admin, '/realtime/admin/email/smtp', 400, 'PUT', { ...smtp, host: 'smtp example test' });
    await api(admin, '/realtime/admin/email/smtp', 400, 'PUT', { ...smtp, from: 'Alpha <no-reply@example.test>\r\nBcc: victim@example.test' });
    await api(admin, '/realtime/admin/email/smtp', 400, 'PUT', { ...smtp, port: 70000 });
    await api(admin, '/realtime/admin/email/smtp', 400, 'PUT', { ...smtp, unknown: true });
    const saved = await request<{ password: { configured: boolean; mask: string }; settings: { host: string } }>(admin, '/realtime/admin/email/smtp', 200, 'PUT', smtp);
    assert.ok(!saved.text.includes(password));
    assert.equal(saved.data.password.configured, true);
    assert.equal(saved.data.settings.host, 'smtp.example.test');
    const status = await request(admin, '/realtime/admin/status');
    assert.ok(!status.text.includes(password));
    assert.ok(!status.text.includes(one<{ secret: string }>("SELECT secret FROM platform_settings WHERE key='push.vapid'")!.secret));
    const settingsRow = one<{ value: string; secret: string | null }>("SELECT value,secret FROM platform_settings WHERE key='mail.smtp.password'")!;
    assert.ok(settingsRow.secret && !settingsRow.secret.includes(password));
    const auditRows = all<{ detail: string }>("SELECT detail FROM audit_events WHERE action='realtime.smtp_updated'");
    assert.ok(auditRows.length >= 1 && auditRows.every((entry) => !entry.detail.includes(password)));
    const kept = await api<{ password: { configured: boolean } }>(admin, '/realtime/admin/email/smtp', 200, 'PUT', { ...smtp, password: undefined, port: 465, secure: true });
    assert.equal(kept.password.configured, true, 'omitting the password keeps the stored one');

    // Test email through an injected transport.
    const delivered: { to: unknown; subject: unknown }[] = [];
    setMailTransportForTests({ sendMail: async (message: { to?: unknown; subject?: unknown }) => { delivered.push({ to: message.to, subject: message.subject }); return {}; } } as never);
    const testEmail = await api<{ email: { id: string; status: string } }>(admin, '/realtime/admin/email/test', 202, 'POST', {});
    assert.equal(testEmail.email.status, 'sent');
    assert.ok(delivered.some((entry) => entry.to === admin.email));
    await api(alice, '/realtime/admin/email/test', 403, 'POST', {});

    // Outbox: no bodies in lists, sensitive bodies never shown, retry/cancel state machine.
    const outbox = await request<{ emails: Record<string, unknown>[] }>(admin, '/realtime/admin/email/outbox?limit=100');
    assert.ok(outbox.data.emails.length > 0);
    assert.ok(outbox.data.emails.every((email) => !('text_body' in email) && !('html_body' in email)));
    const sensitive = one<{ id: string }>("SELECT id FROM email_outbox WHERE sensitive=1 LIMIT 1")!;
    const sensitiveDetail = await api<{ email: { text_body: string | null; body_hidden: boolean } }>(admin, `/realtime/admin/email/outbox/${sensitive.id}`);
    assert.equal(sensitiveDetail.email.text_body, null);
    assert.equal(sensitiveDetail.email.body_hidden, true);
    const filtered = await api<{ emails: { status: string }[] }>(admin, '/realtime/admin/email/outbox?status=sent');
    assert.ok(filtered.emails.every((email) => email.status === 'sent'));
    await api(admin, '/realtime/admin/email/outbox?status=bogus', 400);
    run("UPDATE email_outbox SET status='failed',last_error='SMTP down' WHERE id=?", testEmail.email.id);
    const retried = await api<{ email: { status: string } }>(admin, `/realtime/admin/email/outbox/${testEmail.email.id}/retry`, 200, 'POST', {});
    assert.equal(retried.email.status, 'queued');
    await api(admin, `/realtime/admin/email/outbox/${testEmail.email.id}/retry`, 409, 'POST', {});
    const cancelled = await api<{ email: { status: string } }>(admin, `/realtime/admin/email/outbox/${testEmail.email.id}/cancel`, 200, 'POST', {});
    assert.equal(cancelled.email.status, 'cancelled');
    await api(admin, `/realtime/admin/email/outbox/${testEmail.email.id}/cancel`, 409, 'POST', {});
    await api(admin, '/realtime/admin/email/outbox/unknown-id/retry', 404, 'POST', {});
    await api(alice, `/realtime/admin/email/outbox/${testEmail.email.id}/retry`, 403, 'POST', {});

    // Push administration.
    await api(admin, '/realtime/admin/push', 400, 'PUT', { subject: 'http://insecure.example' });
    const push = await api<{ ttl_seconds: number; public_key: string; private_key: { configured: boolean; mask: string } }>(admin, '/realtime/admin/push', 200, 'PUT', { ttl_seconds: 3600, subject: 'mailto:ops@example.test' });
    assert.equal(push.ttl_seconds, 3600);
    assert.equal(push.private_key.configured, true);
    await api(admin, '/realtime/admin/push/keys', 400, 'POST', { rotate: true });
    const rotated = await api<{ public_key: string }>(admin, '/realtime/admin/push/keys', 200, 'POST', { rotate: true, confirm: true });
    assert.notEqual(rotated.public_key, push.public_key);

    const cleared = await api<{ password: { configured: boolean } }>(admin, '/realtime/admin/email/smtp', 200, 'PUT', { ...smtp, password: undefined, clear_password: true });
    assert.equal(cleared.password.configured, false);
    const removed = await api<{ source: string }>(admin, '/realtime/admin/email/smtp', 200, 'DELETE');
    assert.equal(removed.source, process.env.SMTP_URL ? 'env' : 'none');
  });

  await t.test('personal data handlers export and erase realtime data', async () => {
    const handlers = Object.fromEntries(personalDataHandlers());
    assert.ok(handlers.realtime && handlers.communication);
    await api(bob, '/realtime/push/subscriptions', 201, 'POST', { endpoint: `https://fcm.googleapis.com/fcm/send/${randomBytes(8).toString('hex')}`, keys: pushKeys() });
    await api(bob, '/realtime/preferences', 200, 'PUT', { categories: { network: { email: true } } });
    const exported = JSON.stringify(handlers.realtime.export(bob.id));
    assert.match(exported, /fcm\.googleapis\.com/);
    assert.ok(!exported.includes('/fcm/send/'), 'export lists devices without their secret endpoint');
    const communication = handlers.communication.export(bob.id) as { messages_sent: { body: string }[] };
    assert.ok(communication.messages_sent.length >= 1);
    transaction(() => { handlers.realtime.erase(bob.id); handlers.communication.erase(bob.id); });
    assert.equal(one<{ count: number }>('SELECT COUNT(*) AS count FROM push_subscriptions WHERE user_id=?', bob.id)!.count, 0);
    assert.equal(one<{ count: number }>('SELECT COUNT(*) AS count FROM notification_preferences WHERE user_id=?', bob.id)!.count, 0);
    assert.ok(all<{ body: string }>('SELECT body FROM messages WHERE sender_id=?', bob.id).every((message) => !message.body.includes('confidentiel')));
  });
});
