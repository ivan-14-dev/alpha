import { z } from 'zod';
import { all, one } from '../db.js';
import type { User } from '../core.js';
import { getSetting } from '../platform/settings.js';
import { pendingRequiredDocuments, type LegalDocument } from '../platform/legal.js';
import { hasUsablePassword } from './passwords.js';

export const AUTH_POLICY_SETTING = 'auth.policy';
export const authPolicySchema = z.object({ require_admin_mfa: z.boolean() }).strict();
export type AuthPolicy = z.infer<typeof authPolicySchema>;
export const authPolicy = (): AuthPolicy => getSetting<AuthPolicy>(AUTH_POLICY_SETTING, authPolicySchema, { require_admin_mfa: false });

export function mfaEnabled(userId: string): boolean {
  return !!one('SELECT 1 FROM mfa_totp WHERE user_id=? AND enabled_at IS NOT NULL', userId);
}

export interface AccountFlags {
  email_verified: boolean;
  email_verified_at: string | null;
  mfa_enabled: boolean;
  has_password: boolean;
}

export function accountFlags(userId: string): AccountFlags {
  const row = one<{ email_verified_at: string | null; password_hash: string; mfa: number }>(
    `SELECT u.email_verified_at,u.password_hash,
      EXISTS(SELECT 1 FROM mfa_totp m WHERE m.user_id=u.id AND m.enabled_at IS NOT NULL) AS mfa
     FROM users u WHERE u.id=?`, userId);
  return {
    email_verified: !!row?.email_verified_at,
    email_verified_at: row?.email_verified_at ?? null,
    mfa_enabled: !!row?.mfa,
    has_password: hasUsablePassword(row?.password_hash),
  };
}

/** True when the admin MFA policy is on and this (stored) admin has not enabled MFA: admin rights are suspended. */
export function adminMfaMissing(userId: string, storedRole: string): boolean {
  return storedRole === 'admin' && authPolicy().require_admin_mfa && !mfaEnabled(userId);
}

export interface AccountUser extends User {
  email_verified: boolean;
  mfa_enabled: boolean;
  has_password: boolean;
  pending_legal: LegalDocument[];
  admin_mfa_required: boolean;
}

/** Public user plus security flags, as returned by /api/auth/me. */
export function enrichUser(user: User): AccountUser {
  const flags = accountFlags(user.id);
  const storedRole = one<{ role: string }>('SELECT role FROM users WHERE id=?', user.id)?.role ?? user.role;
  return {
    ...user,
    email_verified: flags.email_verified,
    mfa_enabled: flags.mfa_enabled,
    has_password: flags.has_password,
    pending_legal: pendingRequiredDocuments(user.id),
    admin_mfa_required: adminMfaMissing(user.id, storedRole),
  };
}

export interface LinkedIdentity { provider: 'github' | 'google'; email: string; created_at: string; last_login_at: string | null }

export function linkedIdentities(userId: string): LinkedIdentity[] {
  return all<LinkedIdentity>('SELECT provider,email,created_at,last_login_at FROM oauth_identities WHERE user_id=? ORDER BY provider', userId);
}

export function recoveryCodesRemaining(userId: string): number {
  return one<{ count: number }>('SELECT COUNT(*) AS count FROM mfa_recovery_codes WHERE user_id=? AND used_at IS NULL', userId)!.count;
}

export function mfaStatus(userId: string) {
  const row = one<{ enabled_at: string | null; created_at: string }>('SELECT enabled_at,created_at FROM mfa_totp WHERE user_id=?', userId);
  return {
    enabled: !!row?.enabled_at,
    enabled_at: row?.enabled_at ?? null,
    pending_setup: !!row && !row.enabled_at,
    recovery_codes_remaining: row?.enabled_at ? recoveryCodesRemaining(userId) : 0,
  };
}
