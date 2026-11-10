import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { attachUser } from '../auth.js';
import { HttpError, type User } from '../core.js';
import { afterCommit, onDomainEvent, subscribeUserEvents } from '../platform/events.js';
import { accountRestriction } from '../platform/guards.js';
import { log } from '../platform/log.js';

/**
 * Server-Sent Events hub (single process). Every connection belongs to one user and one session cookie;
 * the cookie is re-validated through the regular `attachUser` middleware on every heartbeat so revoked,
 * expired or banned sessions stop receiving events within one heartbeat (or immediately after an audited
 * account change). Scaling to several nodes requires a shared bus (see docs/v4/realtime.md).
 */
export const MAX_CONNECTIONS_PER_USER = 5;
const MAX_BUFFERED_BYTES = 1024 * 1024;
const timing = { heartbeatMs: 25000, maxLifetimeMs: 30 * 60000, revalidateTimeoutMs: 5000, retryMs: 5000 };

/** Tests shorten the heartbeat to exercise revalidation without waiting 25 s. */
export function setRealtimeTimingForTests(overrides: Partial<typeof timing>) { Object.assign(timing, overrides); }

interface Connection {
  id: string;
  userId: string;
  req: Request;
  res: Response;
  openedAt: number;
  closed: boolean;
  checking: boolean;
  heartbeat?: NodeJS.Timeout;
  lifetime?: NodeJS.Timeout;
}

const connections = new Map<string, Set<Connection>>();
let sequence = 0;
const eventType = /^[a-z][a-z0-9._-]{0,60}$/;

function write(connection: Connection, chunk: string) {
  if (connection.closed || connection.res.destroyed || connection.res.writableEnded) return;
  connection.res.write(chunk);
  // A client that stops reading must not make the server buffer unbounded data.
  if (connection.res.writableLength > MAX_BUFFERED_BYTES) {
    log.warn('realtime.slow_consumer', { user_id: connection.userId, connection_id: connection.id });
    close(connection);
  }
}

function send(connection: Connection, type: string, data: unknown) {
  sequence += 1;
  write(connection, `id: ${sequence}\nevent: ${type}\ndata: ${JSON.stringify(data ?? null)}\n\n`);
}

function close(connection: Connection) {
  if (connection.closed) return;
  connection.closed = true;
  clearInterval(connection.heartbeat);
  clearTimeout(connection.lifetime);
  const set = connections.get(connection.userId);
  set?.delete(connection);
  if (set && !set.size) connections.delete(connection.userId);
  if (!connection.res.writableEnded) {
    try { connection.res.end(); } catch { /* socket already gone */ }
  }
}

const probeResponse = {
  locals: {}, headersSent: true,
  setHeader() { return this; }, getHeader() { return undefined; }, removeHeader() { return this; },
  append() { return this; }, cookie() { return this; }, clearCookie() { return this; },
} as unknown as Response;

/** Re-runs the accounts middleware against the original request headers (cookie) of the stream. */
async function stillAuthorized(connection: Connection): Promise<boolean> {
  const probe = Object.create(connection.req) as Request;
  probe.user = undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('revalidation timeout')), timing.revalidateTimeoutMs);
      const done = (error?: unknown) => { clearTimeout(timer); if (error) reject(error); else resolve(); };
      try {
        const result: unknown = attachUser(probe, probeResponse, done);
        if (result && typeof (result as Promise<void>).then === 'function') (result as Promise<void>).catch(done);
      } catch (error) { done(error); }
    });
  } catch (error) {
    log.warn('realtime.revalidation_failed', { user_id: connection.userId, error });
    return false;
  }
  const resolved = (probe as { user?: User }).user;
  return resolved?.id === connection.userId && !accountRestriction(connection.userId, 'login');
}

async function revalidate(connection: Connection) {
  if (connection.closed || connection.checking) return;
  connection.checking = true;
  try {
    if (!(await stillAuthorized(connection))) {
      send(connection, 'session.expired', { reason: 'session' });
      close(connection);
      return;
    }
    write(connection, `: ping ${Date.now()}\n\n`);
  } finally {
    connection.checking = false;
  }
}

export function revalidateUserStreams(userId: string): Promise<void> {
  return Promise.all([...(connections.get(userId) ?? [])].map((connection) => revalidate(connection))).then(() => undefined);
}

/** Opens the stream. Throws HttpError(429) when the user already has the maximum number of streams. */
export function openStream(req: Request, res: Response, user: User, ready: () => unknown) {
  const existing = connections.get(user.id);
  if (existing && existing.size >= MAX_CONNECTIONS_PER_USER) {
    res.setHeader('Retry-After', '30');
    throw new HttpError(429, 'Trop de connexions temps réel ouvertes pour ce compte. Fermez un onglet puis réessayez.');
  }
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  req.socket.setNoDelay(true);
  req.socket.setKeepAlive(true, 15000);
  const connection: Connection = { id: randomUUID(), userId: user.id, req, res, openedAt: Date.now(), closed: false, checking: false };
  const set = existing ?? new Set<Connection>();
  set.add(connection);
  connections.set(user.id, set);
  res.on('close', () => close(connection));
  res.on('error', () => close(connection));
  write(connection, `retry: ${timing.retryMs}\n\n`);
  send(connection, 'ready', ready());
  connection.heartbeat = setInterval(() => { void revalidate(connection); }, timing.heartbeatMs);
  connection.heartbeat.unref();
  // Bounded lifetime (with jitter) so long-lived streams periodically re-authenticate from scratch.
  connection.lifetime = setTimeout(() => close(connection), timing.maxLifetimeMs * (0.9 + Math.random() * 0.2));
  connection.lifetime.unref();
  return connection.id;
}

export function streamStats() {
  let total = 0;
  for (const set of connections.values()) total += set.size;
  return { connections: total, users: connections.size, max_per_user: MAX_CONNECTIONS_PER_USER, heartbeat_ms: timing.heartbeatMs };
}

export function userStreamCount(userId: string) { return connections.get(userId)?.size ?? 0; }

/** Graceful shutdown (and tests): ends every open stream so `server.close()` can complete. */
export function closeAllStreams() {
  for (const set of [...connections.values()]) for (const connection of [...set]) close(connection);
}

subscribeUserEvents((userId, event) => {
  const set = connections.get(userId);
  if (!set || !eventType.test(event.type)) return;
  for (const connection of [...set]) send(connection, event.type, event.data);
});

// Any audited change targeting a user (session revoked, password changed, sanction...) re-checks their streams right away.
onDomainEvent('realtime.session-guard', (event) => {
  if (event.target_type !== 'user' || !connections.has(event.target_id)) return;
  const userId = event.target_id;
  afterCommit(() => revalidateUserStreams(userId));
});
