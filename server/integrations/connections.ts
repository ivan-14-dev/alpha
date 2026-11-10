import { createHash } from 'node:crypto';
import { audit, HttpError, id, now, type User } from '../core.js';
import { all, one, run, transaction } from '../db.js';
import { afterCommit } from '../platform/events.js';
import { log } from '../platform/log.js';
import { randomToken, seal, sha256Hex, unseal } from '../platform/secrets.js';
import { ProviderError } from './http.js';
import {
  authorizeUrl, exchangeCode, fetchIdentity, providerConfig, providerLabels, providerReady, refreshTokens, revokeAtProvider,
  supportsPkce, type ProviderId, type TokenSet,
} from './providers.js';

export const STATE_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_STATES = 10;

export interface ConnectionRow {
  id: string;
  user_id: string;
  provider: ProviderId;
  base_url: string;
  external_id: string;
  external_login: string;
  access_token_sealed: string;
  refresh_token_sealed: string | null;
  scopes: string;
  expires_at: string | null;
  last_error: string;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
}

interface StateRow {
  state_hash: string;
  user_id: string;
  provider: ProviderId;
  base_url: string;
  code_verifier_sealed: string | null;
  scopes: string;
  return_to: string;
  expires_at: string;
}

const accessContext = (connectionId: string) => `integration_connection:${connectionId}:access`;
const refreshContext = (connectionId: string) => `integration_connection:${connectionId}:refresh`;
const verifierContext = (stateHash: string) => `integration_oauth_state:${stateHash}`;

/** Only same-origin relative paths are accepted (`/x`, never `//host` or `/\host`). */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || value.length > 300) return '/integrations';
  if (!/^\/(?![/\\])[\w\-./?=&%~+:@,;]*$/.test(value)) return '/integrations';
  return value;
}

function withParam(path: string, key: string, value: string): string {
  const url = new URL(path, 'http://alpha.invalid');
  url.searchParams.set(key, value);
  return `${url.pathname}${url.search}`;
}

export function publicConnection(row: ConnectionRow) {
  const scopes = JSON.parse(row.scopes) as string[];
  const config = providerConfig(row.provider);
  return {
    id: row.id,
    provider: row.provider,
    label: providerLabels[row.provider],
    base_url: row.base_url,
    external_id: row.external_id,
    external_login: row.external_login,
    scopes,
    private_access: config.private_scopes.length > 0 && config.private_scopes.every((scope) => scopes.includes(scope)),
    expires_at: row.expires_at,
    needs_reconnect: !!row.last_error,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listConnections(userId: string): ConnectionRow[] {
  return all<ConnectionRow>('SELECT * FROM integration_connections WHERE user_id=? AND revoked_at IS NULL ORDER BY provider,created_at', userId);
}

/** The member's active connection for the provider, on the currently configured instance (GitLab). */
export function activeConnection(userId: string, provider: ProviderId): ConnectionRow | undefined {
  return one<ConnectionRow>(`SELECT * FROM integration_connections WHERE user_id=? AND provider=? AND base_url=? AND revoked_at IS NULL
    ORDER BY updated_at DESC LIMIT 1`, userId, provider, providerConfig(provider).base_url);
}

export function requireConnection(userId: string, provider: ProviderId): ConnectionRow {
  const connection = activeConnection(userId, provider);
  if (!connection) throw new HttpError(409, `Connectez d’abord votre compte ${providerLabels[provider]}.`);
  return connection;
}

/** Creates a one-time, user-bound state (only its hash is stored) and returns the provider authorize URL. */
export function startAuthorization(user: User, provider: ProviderId, options: { privateAccess: boolean; returnTo: unknown }): string {
  if (!providerReady(provider)) throw new HttpError(404, `La connexion ${providerLabels[provider]} n’est pas activée sur cette instance.`);
  const config = providerConfig(provider);
  const state = randomToken(32);
  const stateHash = sha256Hex(state);
  const verifier = supportsPkce[provider] ? randomToken(48) : null;
  const challenge = verifier ? createHash('sha256').update(verifier).digest('base64url') : null;
  const scopes = [...new Set([...config.scopes, ...(options.privateAccess ? config.private_scopes : [])])];
  transaction(() => {
    run('DELETE FROM integration_oauth_states WHERE expires_at<?', now());
    run(`DELETE FROM integration_oauth_states WHERE user_id=? AND state_hash NOT IN (
      SELECT state_hash FROM integration_oauth_states WHERE user_id=? ORDER BY created_at DESC LIMIT ?)`, user.id, user.id, MAX_PENDING_STATES - 1);
    run(`INSERT INTO integration_oauth_states (state_hash,user_id,provider,base_url,code_verifier_sealed,scopes,return_to,expires_at)
      VALUES (?,?,?,?,?,?,?,?)`, stateHash, user.id, provider, config.base_url, verifier ? seal(verifier, verifierContext(stateHash)) : null,
    JSON.stringify(scopes), safeReturnTo(options.returnTo), new Date(Date.now() + STATE_TTL_MS).toISOString());
  });
  return authorizeUrl(provider, config, { state, scopes, codeChallenge: challenge });
}

export type CallbackErrorCode = 'state' | 'denied' | 'exchange' | 'disabled' | 'session';

/**
 * Completes the OAuth flow and returns a RELATIVE redirect path. The state is consumed atomically
 * (single use) and must belong to the signed-in member and to this provider, within 10 minutes.
 */
export async function completeAuthorization(user: User | undefined, provider: ProviderId, query: Record<string, unknown>): Promise<string> {
  const fail = (code: CallbackErrorCode) => `/integrations?integration_error=${code}`;
  const state = typeof query.state === 'string' && query.state.length <= 200 ? query.state : '';
  if (!user) return fail('session');
  if (!state) return fail('state');
  const stateHash = sha256Hex(state);
  const row = transaction(() => {
    const owned = one<StateRow>('SELECT * FROM integration_oauth_states WHERE state_hash=?', stateHash);
    // A state minted for another member is left untouched so a forged callback cannot burn the victim's flow.
    if (!owned || owned.user_id !== user.id) return undefined;
    run('DELETE FROM integration_oauth_states WHERE state_hash=?', stateHash);
    return owned;
  });
  if (!row || row.provider !== provider || row.expires_at <= now()) return fail('state');
  if (typeof query.error === 'string' && query.error) return fail('denied');
  const code = typeof query.code === 'string' && query.code.length <= 2000 ? query.code : '';
  if (!code) return fail('state');
  if (!providerReady(provider)) return fail('disabled');
  let tokens: TokenSet;
  let identity: { external_id: string; login: string };
  try {
    const verifier = row.code_verifier_sealed ? unseal(row.code_verifier_sealed, verifierContext(stateHash)) : null;
    tokens = await exchangeCode(provider, row.base_url, code, verifier);
    identity = await fetchIdentity(provider, row.base_url, tokens.access_token);
  } catch (error) {
    log.warn('integrations.oauth_exchange_failed', { provider, status: error instanceof ProviderError ? error.status : 0 });
    return fail('exchange');
  }
  const requestedScopes = JSON.parse(row.scopes) as string[];
  let replacedToken: string | null = null;
  transaction(() => {
    const existing = one<ConnectionRow>('SELECT * FROM integration_connections WHERE user_id=? AND provider=? AND base_url=? AND revoked_at IS NULL',
      user.id, provider, row.base_url);
    const connectionId = existing?.id ?? id();
    const values = [identity.external_id, identity.login.slice(0, 200), seal(tokens.access_token, accessContext(connectionId)),
      tokens.refresh_token ? seal(tokens.refresh_token, refreshContext(connectionId)) : null,
      JSON.stringify(tokens.scopes ?? requestedScopes), tokens.expires_at] as const;
    if (existing) {
      try {
        const previous = unseal(existing.access_token_sealed, accessContext(existing.id));
        if (previous !== tokens.access_token) replacedToken = previous;
      } catch { /* unreadable previous token: nothing to revoke */ }
      run(`UPDATE integration_connections SET external_id=?,external_login=?,access_token_sealed=?,refresh_token_sealed=?,scopes=?,expires_at=?,
        last_error='',updated_at=? WHERE id=?`, ...values, now(), existing.id);
    } else {
      run(`INSERT INTO integration_connections (id,user_id,provider,base_url,external_id,external_login,access_token_sealed,refresh_token_sealed,scopes,expires_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`, connectionId, user.id, provider, row.base_url, ...values);
    }
    audit(user.id, existing ? 'integration.connection.renewed' : 'integration.connection.created', 'integration_connection', connectionId, provider);
  });
  const previousToken = replacedToken as string | null;
  if (previousToken) afterCommit(() => { void revokeAtProvider(provider, row.base_url, previousToken); });
  return withParam(row.return_to, 'connected', provider);
}

const refreshing = new Map<string, Promise<string>>();

/** Returns a valid access token, refreshing it (once, even under concurrency) when it expires within a minute. */
export async function accessToken(connection: ConnectionRow): Promise<string> {
  if (connection.revoked_at || !connection.access_token_sealed) throw new HttpError(409, `Reconnectez votre compte ${providerLabels[connection.provider]}.`);
  const expiresSoon = connection.expires_at && Date.parse(connection.expires_at) - Date.now() < 60_000;
  if (!expiresSoon) return unseal(connection.access_token_sealed, accessContext(connection.id));
  if (!connection.refresh_token_sealed) {
    markConnectionError(connection.id, 'expired');
    throw new HttpError(409, `La connexion ${providerLabels[connection.provider]} a expiré. Reconnectez votre compte.`);
  }
  const pending = refreshing.get(connection.id);
  if (pending) return pending;
  const work = (async () => {
    const latest = one<ConnectionRow>('SELECT * FROM integration_connections WHERE id=? AND revoked_at IS NULL', connection.id);
    if (!latest?.refresh_token_sealed) throw new HttpError(409, `Reconnectez votre compte ${providerLabels[connection.provider]}.`);
    if (latest.expires_at && Date.parse(latest.expires_at) - Date.now() >= 60_000) return unseal(latest.access_token_sealed, accessContext(latest.id));
    let tokens: TokenSet;
    try {
      tokens = await refreshTokens(latest.provider, latest.base_url, unseal(latest.refresh_token_sealed, refreshContext(latest.id)));
    } catch (error) {
      if (error instanceof ProviderError && error.status >= 400 && error.status < 500) {
        markConnectionError(latest.id, 'refresh_rejected');
        throw new HttpError(409, `La connexion ${providerLabels[latest.provider]} a expiré. Reconnectez votre compte.`);
      }
      throw new HttpError(502, `${providerLabels[latest.provider]} n’a pas répondu correctement. Réessayez plus tard.`);
    }
    run(`UPDATE integration_connections SET access_token_sealed=?,refresh_token_sealed=?,expires_at=?,scopes=COALESCE(?,scopes),last_error='',updated_at=?
      WHERE id=? AND revoked_at IS NULL`, seal(tokens.access_token, accessContext(latest.id)),
    tokens.refresh_token ? seal(tokens.refresh_token, refreshContext(latest.id)) : null, tokens.expires_at,
    tokens.scopes ? JSON.stringify(tokens.scopes) : null, now(), latest.id);
    return tokens.access_token;
  })();
  refreshing.set(connection.id, work);
  try { return await work; } finally { refreshing.delete(connection.id); }
}

export function markConnectionError(connectionId: string, reason: string) {
  run('UPDATE integration_connections SET last_error=?,updated_at=? WHERE id=?', reason.slice(0, 200), now(), connectionId);
}

/** Captures the plaintext tokens of connections (used before deleting/revoking them). */
export function connectionTokens(rows: ConnectionRow[]) {
  return rows.flatMap((row) => {
    try {
      return row.access_token_sealed ? [{ provider: row.provider, base_url: row.base_url, token: unseal(row.access_token_sealed, accessContext(row.id)) }] : [];
    } catch { return []; }
  });
}

/** Disconnects locally (tokens wiped in the same transaction) and revokes at the provider when an API exists. */
export async function disconnect(userId: string, connectionId: string): Promise<{ revoked_at_provider: boolean; provider: ProviderId }> {
  const connection = one<ConnectionRow>('SELECT * FROM integration_connections WHERE id=? AND user_id=? AND revoked_at IS NULL', connectionId, userId);
  if (!connection) throw new HttpError(404, 'Connexion introuvable.');
  const [captured] = connectionTokens([connection]);
  transaction(() => {
    run(`UPDATE integration_connections SET revoked_at=?,access_token_sealed='',refresh_token_sealed=NULL,updated_at=? WHERE id=?`, now(), now(), connection.id);
    audit(userId, 'integration.connection.revoked', 'integration_connection', connection.id, connection.provider);
  });
  const revoked = captured ? await revokeAtProvider(connection.provider, connection.base_url, captured.token) : false;
  return { revoked_at_provider: revoked, provider: connection.provider };
}
