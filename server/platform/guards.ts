import type { NextFunction, Request, Response } from 'express';
import { HttpError, requireUser, type User } from '../core.js';
import { riskLevelOf } from '../trust/cases.js';
import { normalizedPath, runWithRequest } from '../trust/context.js';
import { blockingSanction, restrictionOf } from '../trust/sanctions.js';
import { storeSignal } from '../trust/signals.js';
import { log } from './log.js';
import '../trust/runtime.js';

/**
 * Account restrictions and abuse signals.
 * OWNER: trust/anti-abuse module. The signatures below are the contract used by auth, payments and app.ts;
 * implementations may change but must stay synchronous and cheap (indexed lookups).
 */
export type Capability = 'login' | 'publish' | 'message' | 'trade' | 'money' | 'withdraw' | 'review' | 'test';

export interface Restriction {
  sanction_id: string;
  kind: 'warning' | 'restriction' | 'suspension' | 'ban';
  message: string;
  until: string | null;
  appealable: boolean;
  /** Capability that was refused (absent for unmapped mutations blocked by a suspension or a ban). */
  capability?: Capability;
}

/**
 * Returns the active restriction blocking `capability`, or null. `login` restrictions make attachUser treat the user as signed out.
 * `login` is blocked only by a NON-appealable ban: suspended (or appealably banned) members can still sign in to read the
 * statement of reasons and appeal, while capabilityMiddleware blocks their mutations.
 */
export function accountRestriction(userId: string, capability: Capability): Restriction | null {
  const sanction = blockingSanction(userId, capability);
  return sanction ? restrictionOf(sanction, capability) : null;
}

/** 403 carrying the structured restriction (statement of reasons) next to the public message. */
export class RestrictionError extends HttpError {
  constructor(public restriction: Restriction) { super(403, restriction.message); }
}

export function requireCapability(req: Request, capability: Capability): User {
  const user = requireUser(req);
  const restriction = accountRestriction(user.id, capability);
  if (restriction) throw new RestrictionError(restriction);
  return user;
}

/** Self-service routes that stay reachable while restricted, suspended or banned (sign-out, appeals, GDPR, notifications). */
const alwaysAllowed = [
  '/api/auth', '/api/trust/appeals', '/api/trust/me', '/api/privacy', '/api/payments/webhooks', '/api/integrations/webhooks',
  '/api/communication/notifications', '/api/realtime/preferences', '/api/realtime/push',
];
const allowedPatterns = [/^\/api\/communication\/conversations\/[^/]+\/read$/];
/** Administration tools of a module are never covered by a member capability (only a suspension or a ban blocks them). */
const adminTools = /^\/api\/[a-z-]+\/admin(\/|$)/;
/** Opening a dispute or a report is a redress mechanism: only a suspension or a ban blocks it. */
const redress = [/^\/api\/marketplace\/orders\/[^/]+\/dispute$/, /^\/api\/testing\/missions\/[^/]+\/dispute$/, /^\/api\/trust\/reports$/];

const capabilityPrefixes: [string, Capability][] = [
  ['/api/compliance/withdrawals', 'withdraw'],
  ['/api/compliance/payout-methods', 'withdraw'],
  ['/api/compliance', 'money'],
  ['/api/payments', 'money'],
  ['/api/marketplace', 'trade'],
  ['/api/communication', 'message'],
  ['/api/realtime/typing', 'message'],
  ['/api/reputation', 'review'],
  ['/api/testing', 'test'],
  ['/api/sandbox', 'test'],
  ['/api/projects', 'publish'],
  ['/api/community', 'publish'],
  ['/api/workspace', 'publish'],
  ['/api/people', 'publish'],
  ['/api/network', 'publish'],
  ['/api/discovery', 'publish'],
  ['/api/integrations', 'publish'],
  ['/api/files', 'publish'],
];

const within = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

/** Capability required by a mutating request; `null` = unmapped (only a suspension or a ban blocks it); `'allow'` = never blocked. */
export function capabilityForPath(path: string): Capability | null | 'allow' {
  if (alwaysAllowed.some((prefix) => within(path, prefix)) || allowedPatterns.some((pattern) => pattern.test(path))) return 'allow';
  if (adminTools.test(path) || redress.some((pattern) => pattern.test(path))) return null;
  return capabilityPrefixes.find(([prefix]) => within(path, prefix))?.[1] ?? null;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Maps mutating API prefixes to the capability they need. Mounted in app.ts after attachUser. */
export function capabilityMiddleware(req: Request, res: Response, next: NextFunction) {
  runWithRequest(req, () => {
    if (SAFE_METHODS.has(req.method) || !req.user) { next(); return; }
    const path = normalizedPath(req);
    if (!path.startsWith('/api/')) { next(); return; }
    const capability = capabilityForPath(path);
    if (capability === 'allow') { next(); return; }
    let sanction;
    try {
      sanction = blockingSanction(req.user.id, capability);
    } catch (error) {
      // Fail open on a lookup error: the route-level requireCapability checks still apply.
      log.error('trust.capability_check_failed', { error, path });
      next();
      return;
    }
    if (!sanction) { next(); return; }
    const restriction = restrictionOf(sanction, capability);
    res.status(403).json({ error: restriction.message, restriction });
  });
}

export type RiskLevel = 'low' | 'medium' | 'high';

/** Aggregated risk used to hold withdrawals/payouts for manual review (high = always manual). */
export function riskLevel(userId: string): RiskLevel {
  return riskLevelOf(userId);
}

export type SignalKind = 'register' | 'login' | 'login_failed' | 'oauth_login' | 'password_reset' | 'mfa_failed'
  | 'payment' | 'withdrawal' | 'review' | 'payout' | 'listing' | 'message' | 'mission' | 'order';

/** Records a privacy-preserving risk signal (keyed hashes only). Must never throw for the caller. */
export function recordSignal(req: Request | null, userId: string | null, kind: SignalKind, meta: Record<string, unknown> = {}) {
  try {
    storeSignal(req, userId, kind, meta);
  } catch (error) {
    log.error('trust.signal_failed', { kind, error });
  }
}
