import type { NextFunction, Request, Response } from 'express';
import { HttpError, requireUser, type User } from '../core.js';

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
}

/** Returns the active restriction blocking `capability`, or null. `login` restrictions make attachUser treat the user as signed out. */
export function accountRestriction(_userId: string, _capability: Capability): Restriction | null {
  return null;
}

export function requireCapability(req: Request, capability: Capability): User {
  const user = requireUser(req);
  const restriction = accountRestriction(user.id, capability);
  if (restriction) throw new HttpError(403, restriction.message);
  return user;
}

/** Maps mutating API prefixes to the capability they need. Mounted in app.ts after attachUser. */
export function capabilityMiddleware(_req: Request, _res: Response, next: NextFunction) {
  next();
}

export type SignalKind = 'register' | 'login' | 'login_failed' | 'oauth_login' | 'password_reset' | 'mfa_failed'
  | 'payment' | 'withdrawal' | 'review' | 'payout' | 'listing' | 'message';

/** Records a privacy-preserving risk signal (keyed hashes only). Must never throw for the caller. */
export function recordSignal(_req: Request | null, _userId: string | null, _kind: SignalKind, _meta: Record<string, unknown> = {}) {
  // Implemented by the trust module.
}
