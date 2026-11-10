import { onCommit } from '../db.js';
import { log } from './log.js';

/**
 * In-process event hooks. Synchronous hooks run INSIDE the caller's SQLite transaction, so they may only
 * do synchronous DB writes (outbox rows, deliveries, risk signals) that must commit/rollback together.
 * Anything with external side effects (SSE push, network) must be deferred with `afterCommit`, which only
 * runs after the outermost COMMIT (rolled-back work is discarded).
 */
export interface NotificationEvent {
  id: string;
  user_id: string;
  kind: string;
  title: string;
  body: string;
  link: string;
}

export interface DomainEvent {
  action: string;
  actor_id: string;
  target_type: string;
  target_id: string;
  detail: string;
}

export interface RealtimeEvent { type: string; data: unknown }

type NotificationHook = (event: NotificationEvent) => void;
type DomainHook = (event: DomainEvent) => void;
type UserListener = (userId: string, event: RealtimeEvent) => void;

const notificationHooks = new Map<string, NotificationHook>();
const domainHooks = new Map<string, DomainHook>();
const userListeners = new Set<UserListener>();

/** Idempotent by name, so module reloads (tsx watch) never register twice. */
export function onNotification(name: string, hook: NotificationHook) { notificationHooks.set(name, hook); }
export function onDomainEvent(name: string, hook: DomainHook) { domainHooks.set(name, hook); }

/** Called by core.notify(). Hook failures propagate so the surrounding transaction rolls back consistently. */
export function emitNotification(event: NotificationEvent) {
  for (const hook of notificationHooks.values()) hook(event);
}

/** Called by core.audit() for every audited domain action. */
export function emitDomainEvent(event: DomainEvent) {
  for (const hook of domainHooks.values()) hook(event);
}

/** Realtime fan-out (SSE). Deferred: never blocks or fails the caller. */
export function publishToUser(userId: string, event: RealtimeEvent) {
  afterCommit(() => { for (const listener of userListeners) listener(userId, event); });
}

export function subscribeUserEvents(listener: UserListener): () => void {
  userListeners.add(listener);
  return () => { userListeners.delete(listener); };
}

/**
 * Runs asynchronously after the outermost transaction COMMITs (next tick if none is open).
 * Never runs when the transaction rolls back. Errors are logged, never thrown to the caller.
 */
export function afterCommit(work: () => void | Promise<void>) {
  onCommit(() => {
    setImmediate(() => {
      Promise.resolve().then(work).catch((error) => log.error('after_commit.failed', { error }));
    });
  });
}
