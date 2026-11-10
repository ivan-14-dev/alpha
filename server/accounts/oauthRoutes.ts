import { Router, type Request, type Response } from 'express';
import { one, run, transaction } from '../db.js';
import { audit, HttpError, id, now } from '../core.js';
import { recordLegalAcceptance } from '../platform/legal.js';
import { accountRestriction, recordSignal } from '../platform/guards.js';
import { log } from '../platform/log.js';
import { clientIp, rateLimit } from '../platform/rateLimit.js';
import { appOrigin } from '../platform/settings.js';
import { randomToken, safeEqual, seal, sha256Hex, unseal } from '../platform/secrets.js';
import { queueSecurityEmail } from './emails.js';
import { createMfaChallenge } from './mfa.js';
import {
  authorizationUrl, enabledOAuthProviders, exchangeCode, fetchProfile, isOAuthProvider, OAuthFlowError, providerDefinitions,
  safeRedirectPath, withQuery, type OAuthErrorCode, type OAuthProfile, type OAuthProvider,
} from './oauth.js';
import { hasUsablePassword } from './passwords.js';
import { insertSession, readCookie, requireLiveSession, setScopedCookie, setSessionCookie } from './session.js';
import { mfaEnabled } from './status.js';

export const oauthStateCookie = 'alpha_oauth_state';
const statePath = '/api/auth/oauth';
const stateTtlMs = 10 * 60000;
const avatarColors = ['#6658e8', '#0f9d8a', '#d9534f', '#e08e0b', '#2f80ed', '#9b51e0', '#219653', '#c2185b'];

interface StateRow { provider: OAuthProvider; mode: 'login' | 'link'; user_id: string | null; verifier_sealed: string; redirect_path: string; expires_at: string }
type Outcome =
  | { kind: 'session'; token: string; userId: string; created: boolean }
  | { kind: 'mfa'; challenge: string }
  | { kind: 'linked' };

const absolute = (path: string) => `${appOrigin()}${path}`;
const errorTarget = (mode: 'login' | 'link', redirect: string, code: OAuthErrorCode) =>
  absolute(mode === 'link' ? withQuery(redirect, { oauth_error: code }) : withQuery('/login', { oauth_error: code }));

function providerParam(req: Request): OAuthProvider {
  const provider = req.params.provider;
  if (!isOAuthProvider(provider)) throw new HttpError(404, 'Fournisseur de connexion inconnu.');
  return provider;
}

function displayName(profile: OAuthProfile): string {
  const fallback = profile.email.split('@')[0];
  const name = (profile.name || fallback).replace(/\s+/g, ' ').trim().slice(0, 80);
  return name.length >= 2 ? name : `${name || 'Membre'} Alpha`.slice(0, 80);
}

function linkIdentity(userId: string, provider: OAuthProvider, profile: OAuthProfile) {
  run('INSERT INTO oauth_identities(id,provider,provider_user_id,user_id,email,last_login_at) VALUES (?,?,?,?,?,?)',
    id(), provider, profile.providerUserId, userId, profile.email, now());
  audit(userId, 'auth.oauth_linked', 'user', userId, JSON.stringify({ provider }));
  const user = one<{ id: string; email: string; name: string }>('SELECT id,email,name FROM users WHERE id=?', userId)!;
  queueSecurityEmail(user, `Compte ${providerDefinitions[provider].name} associé`,
    `Le compte ${providerDefinitions[provider].name} (${profile.email}) peut désormais être utilisé pour vous connecter à Alpha.`);
}

/** Runs inside one transaction: decides between login, link, account creation and MFA. Throws OAuthFlowError to roll back. */
function resolveOAuth(req: Request, provider: OAuthProvider, profile: OAuthProfile, state: StateRow): Outcome {
  const identity = one<{ user_id: string }>('SELECT user_id FROM oauth_identities WHERE provider=? AND provider_user_id=?', provider, profile.providerUserId);
  if (state.mode === 'link') {
    if (!req.user || req.user.id !== state.user_id) throw new OAuthFlowError('login_required');
    requireLiveSession(req);
    if (identity) {
      if (identity.user_id !== req.user.id) throw new OAuthFlowError('identity_taken');
      return { kind: 'linked' };
    }
    if (one('SELECT 1 FROM oauth_identities WHERE user_id=? AND provider=?', req.user.id, provider)) throw new OAuthFlowError('already_linked');
    linkIdentity(req.user.id, provider, profile);
    // The provider verified this address, so it proves ownership of the account e-mail too.
    run('UPDATE users SET email_verified_at=COALESCE(email_verified_at,?) WHERE id=? AND email=?', now(), req.user.id, profile.email);
    return { kind: 'linked' };
  }

  let userId: string;
  let created = false;
  if (identity) {
    userId = identity.user_id;
    run('UPDATE oauth_identities SET email=?,last_login_at=? WHERE provider=? AND provider_user_id=?', profile.email, now(), provider, profile.providerUserId);
  } else {
    const local = one<{ id: string; email_verified_at: string | null }>('SELECT id,email_verified_at FROM users WHERE email=?', profile.email);
    if (local) {
      // Auto-link only when BOTH sides proved ownership of the address; otherwise the user must sign in and link manually.
      if (!local.email_verified_at || one('SELECT 1 FROM oauth_identities WHERE user_id=? AND provider=?', local.id, provider)) {
        throw new OAuthFlowError('account_exists');
      }
      if (accountRestriction(local.id, 'login')) throw new OAuthFlowError('restricted');
      linkIdentity(local.id, provider, profile);
      userId = local.id;
    } else {
      userId = id();
      created = true;
      run('INSERT INTO users(id,name,email,password_hash,avatar_color,email_verified_at) VALUES (?,?,?,?,?,?)',
        userId, displayName(profile), profile.email, '', avatarColors[parseInt(sha256Hex(userId).slice(0, 2), 16) % avatarColors.length], now());
      run('INSERT INTO oauth_identities(id,provider,provider_user_id,user_id,email,last_login_at) VALUES (?,?,?,?,?,?)',
        id(), provider, profile.providerUserId, userId, profile.email, now());
      // The sign-in page states that continuing with a provider accepts the terms and privacy policy.
      recordLegalAcceptance(userId, ['terms', 'privacy']);
      audit(userId, 'auth.oauth_registered', 'user', userId, JSON.stringify({ provider }));
      recordSignal(req, userId, 'register', { method: 'oauth', provider });
    }
  }
  if (accountRestriction(userId, 'login')) throw new OAuthFlowError('restricted');
  if (mfaEnabled(userId)) return { kind: 'mfa', challenge: createMfaChallenge(userId, 'oauth', provider) };
  const token = insertSession(req, userId);
  recordSignal(req, userId, 'oauth_login', { provider, created });
  return { kind: 'session', token, userId, created };
}

export const oauthRouter = Router();

oauthRouter.get('/providers', (_req, res) => {
  res.json({ providers: enabledOAuthProviders().map((provider) => ({ id: provider, name: providerDefinitions[provider].name })) });
});

oauthRouter.get('/:provider/start', rateLimit({ name: 'auth.oauth-start', limit: 30, windowMs: 15 * 60000, message: 'Trop de tentatives de connexion. Réessayez dans 15 minutes.' }), (req, res) => {
  const provider = providerParam(req);
  const mode = req.query.mode === undefined ? 'login' : req.query.mode;
  if (mode !== 'login' && mode !== 'link') throw new HttpError(400, 'Mode de connexion invalide.');
  const redirect = req.query.redirect === undefined ? (mode === 'link' ? '/settings' : '/') : safeRedirectPath(req.query.redirect);
  if (!redirect) throw new HttpError(400, 'Adresse de retour invalide : seules les pages d’Alpha sont autorisées.');
  if (!enabledOAuthProviders().includes(provider)) return res.redirect(302, errorTarget(mode, redirect, 'provider_disabled'));
  if (mode === 'link' && !req.user) return res.redirect(302, errorTarget('login', redirect, 'login_required'));
  const state = randomToken(32);
  const verifier = randomToken(48);
  const stateHash = sha256Hex(state);
  transaction(() => {
    if (mode === 'link') requireLiveSession(req);
    run('DELETE FROM oauth_states WHERE expires_at<=?', now());
    run('INSERT INTO oauth_states(state_hash,provider,mode,user_id,verifier_sealed,redirect_path,expires_at) VALUES (?,?,?,?,?,?,?)',
      stateHash, provider, mode, mode === 'link' ? req.user!.id : null, seal(verifier, `oauth-state:${stateHash}`), redirect,
      new Date(Date.now() + stateTtlMs).toISOString());
  });
  setScopedCookie(res, oauthStateCookie, state, statePath, stateTtlMs / 1000);
  res.redirect(302, authorizationUrl(provider, state, verifier));
});

oauthRouter.get('/:provider/callback', rateLimit({ name: 'auth.oauth-callback', limit: 30, windowMs: 15 * 60000, message: 'Trop de tentatives de connexion. Réessayez dans 15 minutes.' }), async (req: Request, res: Response) => {
  const provider = providerParam(req);
  setScopedCookie(res, oauthStateCookie, '', statePath, 0);
  const queryState = typeof req.query.state === 'string' ? req.query.state : '';
  const cookieState = readCookie(req, oauthStateCookie) ?? '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(queryState) || !safeEqual(queryState, cookieState)) {
    return res.redirect(302, errorTarget('login', '/', 'state'));
  }
  const stateHash = sha256Hex(queryState);
  const state = transaction(() => {
    const row = one<StateRow>('SELECT provider,mode,user_id,verifier_sealed,redirect_path,expires_at FROM oauth_states WHERE state_hash=?', stateHash);
    run('DELETE FROM oauth_states WHERE state_hash=?', stateHash);
    return row;
  });
  if (!state || state.provider !== provider || state.expires_at <= now()) return res.redirect(302, errorTarget('login', '/', 'state'));
  const fail = (code: OAuthErrorCode) => res.redirect(302, errorTarget(state.mode, state.redirect_path, code));

  if (typeof req.query.error === 'string') return fail(req.query.error === 'access_denied' ? 'access_denied' : 'provider_error');
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  if (!code || code.length > 2048) return fail('provider_error');

  let profile: OAuthProfile;
  try {
    const accessToken = await exchangeCode(provider, code, unseal(state.verifier_sealed, `oauth-state:${stateHash}`));
    profile = await fetchProfile(provider, accessToken);
  } catch (error) {
    if (error instanceof OAuthFlowError) {
      log.warn('auth.oauth_provider_failed', { provider, reason: error.message });
      return fail(error.code);
    }
    throw error;
  }
  if (!profile.emailVerified) return fail('email_unverified');

  let outcome: Outcome;
  try {
    outcome = transaction(() => resolveOAuth(req, provider, profile, state));
  } catch (error) {
    if (error instanceof OAuthFlowError) {
      if (error.code === 'login_required' || error.code === 'restricted') log.warn('auth.oauth_refused', { provider, reason: error.code });
      return fail(error.code);
    }
    if (error instanceof HttpError && error.status === 401) return fail('login_required');
    throw error;
  }
  if (outcome.kind === 'linked') return res.redirect(302, absolute(withQuery(state.redirect_path, { oauth: 'linked', provider })));
  if (outcome.kind === 'mfa') {
    return res.redirect(302, absolute(withQuery('/login', { mfa: outcome.challenge, next: state.redirect_path })));
  }
  setSessionCookie(res, outcome.token);
  res.redirect(302, absolute(state.redirect_path));
});

oauthRouter.delete('/identities/:provider', rateLimit({
  name: 'auth.oauth-unlink', limit: 20, windowMs: 15 * 60000, key: (req: Request) => req.user?.id ?? clientIp(req),
}), (req, res) => {
  const provider = providerParam(req);
  transaction(() => {
    const { user } = requireLiveSession(req);
    if (!one('SELECT 1 FROM oauth_identities WHERE user_id=? AND provider=?', user.id, provider)) throw new HttpError(404, 'Aucun compte de ce fournisseur n’est associé.');
    const account = one<{ password_hash: string }>('SELECT password_hash FROM users WHERE id=?', user.id)!;
    const others = one<{ count: number }>('SELECT COUNT(*) AS count FROM oauth_identities WHERE user_id=? AND provider!=?', user.id, provider)!.count;
    if (!hasUsablePassword(account.password_hash) && others === 0) {
      throw new HttpError(409, 'Définissez d’abord un mot de passe ou associez un autre compte : sinon vous ne pourriez plus vous connecter.');
    }
    run('DELETE FROM oauth_identities WHERE user_id=? AND provider=?', user.id, provider);
    audit(user.id, 'auth.oauth_unlinked', 'user', user.id, JSON.stringify({ provider }));
    queueSecurityEmail(user, `Compte ${providerDefinitions[provider].name} dissocié`,
      `Le compte ${providerDefinitions[provider].name} ne permet plus de vous connecter à Alpha.`);
  });
  res.json({ ok: true });
});
