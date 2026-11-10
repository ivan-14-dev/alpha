import { Router } from 'express';
import { z } from 'zod';
import { all, one, transaction } from '../db.js';
import { audit, HttpError, requireAdmin } from '../core.js';
import { hasSecretSetting, setSecretSetting, setSetting } from '../platform/settings.js';
import { describeOAuthProvider, isOAuthProvider, oauthConfig, oauthProviderIds, oauthSecretKey, oauthSettingKey } from './oauth.js';
import { AUTH_POLICY_SETTING, authPolicy, authPolicySchema, mfaEnabled } from './status.js';

const providerInput = z.object({
  enabled: z.boolean(),
  client_id: z.string().trim().max(200).regex(/^[\x21-\x7e]*$/, 'Identifiant client invalide'),
  // undefined keeps the stored secret, null removes it.
  client_secret: z.string().trim().min(8).max(500).regex(/^[\x21-\x7e]+$/, 'Secret invalide').nullable().optional(),
}).strict();

const percent = (part: number, total: number) => total === 0 ? 0 : Math.round((part / total) * 1000) / 10;

function adminsWithoutMfa(): number {
  return one<{ count: number }>(`SELECT COUNT(*) AS count FROM users u WHERE u.role='admin'
    AND NOT EXISTS(SELECT 1 FROM mfa_totp m WHERE m.user_id=u.id AND m.enabled_at IS NOT NULL)`)!.count;
}

export function accountStats() {
  const totals = one<{ users: number; verified: number; mfa: number; admins: number; admins_mfa: number; passwordless: number }>(`
    SELECT COUNT(*) AS users,
      SUM(CASE WHEN u.email_verified_at IS NOT NULL THEN 1 ELSE 0 END) AS verified,
      SUM(CASE WHEN m.enabled_at IS NOT NULL THEN 1 ELSE 0 END) AS mfa,
      SUM(CASE WHEN u.role='admin' THEN 1 ELSE 0 END) AS admins,
      SUM(CASE WHEN u.role='admin' AND m.enabled_at IS NOT NULL THEN 1 ELSE 0 END) AS admins_mfa,
      SUM(CASE WHEN u.password_hash='' THEN 1 ELSE 0 END) AS passwordless
    FROM users u LEFT JOIN mfa_totp m ON m.user_id=u.id`)!;
  const identities = Object.fromEntries(oauthProviderIds.map((provider) => [provider, 0])) as Record<string, number>;
  for (const row of all<{ provider: string; count: number }>('SELECT provider,COUNT(*) AS count FROM oauth_identities GROUP BY provider')) identities[row.provider] = row.count;
  const users = totals.users ?? 0;
  return {
    users,
    email_verified: totals.verified ?? 0,
    email_verified_pct: percent(totals.verified ?? 0, users),
    mfa_enabled: totals.mfa ?? 0,
    mfa_pct: percent(totals.mfa ?? 0, users),
    admins: totals.admins ?? 0,
    admins_with_mfa: totals.admins_mfa ?? 0,
    passwordless: totals.passwordless ?? 0,
    identities,
    recovery_codes_low: one<{ count: number }>(`SELECT COUNT(*) AS count FROM mfa_totp m WHERE m.enabled_at IS NOT NULL
      AND (SELECT COUNT(*) FROM mfa_recovery_codes r WHERE r.user_id=m.user_id AND r.used_at IS NULL) < 3`)!.count,
  };
}

export const authAdminRouter = Router();

authAdminRouter.get('/oauth', (req, res) => {
  requireAdmin(req);
  res.json({ providers: oauthProviderIds.map(describeOAuthProvider) });
});

authAdminRouter.put('/oauth/:provider', (req, res) => {
  requireAdmin(req);
  const provider = req.params.provider;
  if (!isOAuthProvider(provider)) throw new HttpError(404, 'Fournisseur de connexion inconnu.');
  const input = providerInput.parse(req.body);
  transaction(() => {
    const admin = requireAdmin(req);
    const secretAfter = input.client_secret === undefined ? hasSecretSetting(oauthSecretKey(provider)) : input.client_secret !== null;
    if (input.enabled && (!input.client_id || !secretAfter)) {
      throw new HttpError(400, 'Renseignez l’identifiant client et le secret avant d’activer ce fournisseur.');
    }
    const previous = oauthConfig(provider);
    setSetting(oauthSettingKey(provider), { enabled: input.enabled, client_id: input.client_id }, admin.id);
    if (input.client_secret !== undefined) setSecretSetting(oauthSecretKey(provider), input.client_secret, admin.id);
    audit(admin.id, 'auth.oauth_config_updated', 'setting', oauthSettingKey(provider), JSON.stringify({
      enabled: input.enabled,
      was_enabled: previous.enabled,
      client_id_changed: previous.client_id !== input.client_id,
      secret: input.client_secret === undefined ? 'kept' : input.client_secret === null ? 'removed' : 'replaced',
    }));
  });
  res.json({ provider: describeOAuthProvider(provider) });
});

authAdminRouter.get('/policy', (req, res) => {
  requireAdmin(req);
  res.json({ policy: authPolicy(), admins_without_mfa: adminsWithoutMfa() });
});

authAdminRouter.put('/policy', (req, res) => {
  requireAdmin(req);
  const input = authPolicySchema.parse(req.body);
  transaction(() => {
    const admin = requireAdmin(req);
    if (input.require_admin_mfa && !mfaEnabled(admin.id)) {
      throw new HttpError(409, 'Activez d’abord la double authentification sur votre propre compte, sinon vous perdriez l’accès à l’administration.');
    }
    const previous = authPolicy();
    setSetting(AUTH_POLICY_SETTING, input, admin.id);
    audit(admin.id, 'auth.policy_updated', 'setting', AUTH_POLICY_SETTING, JSON.stringify({ previous, next: input }));
  });
  res.json({ policy: authPolicy(), admins_without_mfa: adminsWithoutMfa() });
});

authAdminRouter.get('/stats', (req, res) => {
  requireAdmin(req);
  res.json({ stats: accountStats() });
});
