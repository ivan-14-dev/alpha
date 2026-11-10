import { z } from 'zod';
import { HttpError } from '../core.js';
import { appOrigin, getSecretSetting, getSetting, hasSecretSetting, publicApiOrigin, settingUpdatedAt } from '../platform/settings.js';
import { maskSecret } from '../platform/secrets.js';
import { ProviderError, providerRequest } from './http.js';

export const providerIds = ['github', 'gitlab', 'figma'] as const;
export type ProviderId = (typeof providerIds)[number];
export const providerSchema = z.enum(providerIds);

export const providerLabels: Record<ProviderId, string> = { github: 'GitHub', gitlab: 'GitLab', figma: 'Figma' };

const scopeSchema = z.string().trim().min(1).max(60).regex(/^[a-z0-9_:.-]+$/i);
export const providerSettingsSchema = z.object({
  enabled: z.boolean(),
  client_id: z.string().trim().max(200),
  base_url: z.string().trim().max(300).optional(),
  scopes: z.array(scopeSchema).max(20),
  private_scopes: z.array(scopeSchema).max(20).optional(),
}).strict();
export type ProviderSettings = z.infer<typeof providerSettingsSchema>;

/**
 * Defaults are least-privilege. GitHub: `read:user` lists public repositories and `admin:repo_hook`
 * creates/deletes the repository webhook; `repo` is only requested when the member explicitly asks for
 * private repositories. GitLab: `read_api read_user` (add `api` to let Alpha create project hooks).
 * Figma: identity, file metadata/content read and webhook management.
 */
export const providerDefaults: Record<ProviderId, ProviderSettings & { base_url: string }> = {
  github: { enabled: false, client_id: '', base_url: 'https://github.com', scopes: ['read:user', 'admin:repo_hook'], private_scopes: ['repo'] },
  gitlab: { enabled: false, client_id: '', base_url: 'https://gitlab.com', scopes: ['read_api', 'read_user'], private_scopes: [] },
  figma: { enabled: false, client_id: '', base_url: 'https://www.figma.com', scopes: ['current_user:read', 'file_content:read', 'file_metadata:read', 'webhooks:write'], private_scopes: [] },
};

/** GitHub and GitLab support PKCE (S256). Figma relies on `state` plus the confidential client secret. */
export const supportsPkce: Record<ProviderId, boolean> = { github: true, gitlab: true, figma: false };

export const settingKey = (provider: ProviderId) => `integrations.${provider}`;
export const secretKey = (provider: ProviderId) => `integrations.${provider}.client_secret`;

export interface ProviderConfig {
  provider: ProviderId;
  enabled: boolean;
  client_id: string;
  base_url: string;
  scopes: string[];
  private_scopes: string[];
}

export function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && process.env.NODE_ENV !== 'production')) {
    throw new HttpError(400, 'L’URL de l’instance doit utiliser HTTPS.');
  }
  if (url.username || url.password || url.search || url.hash) throw new HttpError(400, 'URL d’instance invalide.');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export function providerConfig(provider: ProviderId): ProviderConfig {
  const defaults = providerDefaults[provider];
  const stored = getSetting(settingKey(provider), providerSettingsSchema, defaults);
  let baseUrl = defaults.base_url;
  if (provider === 'gitlab' && stored.base_url) {
    try { baseUrl = normalizeBaseUrl(stored.base_url); } catch { baseUrl = defaults.base_url; }
  }
  return {
    provider,
    enabled: stored.enabled,
    client_id: stored.client_id,
    base_url: baseUrl,
    scopes: stored.scopes.length ? stored.scopes : defaults.scopes,
    private_scopes: stored.private_scopes ?? defaults.private_scopes ?? [],
  };
}

export function clientSecret(provider: ProviderId): string | null {
  return getSecretSetting(secretKey(provider));
}

/** Enabled AND fully configured (client id + secret). */
export function providerReady(provider: ProviderId): boolean {
  const config = providerConfig(provider);
  return config.enabled && !!config.client_id && hasSecretSetting(secretKey(provider));
}

export function callbackUrl(provider: ProviderId): string {
  return `${appOrigin()}/api/integrations/oauth/${provider}/callback`;
}

export function inboundWebhookUrl(provider: ProviderId, sourceId: string): string {
  return `${publicApiOrigin()}/api/integrations/webhooks/${provider}/${sourceId}`;
}

/** Admin-safe description: secrets are only reported as configured + mask. */
export function describeProvider(provider: ProviderId) {
  const config = providerConfig(provider);
  const secret = clientSecret(provider);
  return {
    ...config,
    label: providerLabels[provider],
    client_secret: { configured: !!secret, mask: maskSecret(secret) },
    ready: config.enabled && !!config.client_id && !!secret,
    callback_url: callbackUrl(provider),
    pkce: supportsPkce[provider],
    default_scopes: providerDefaults[provider].scopes,
    updated_at: settingUpdatedAt(settingKey(provider)),
  };
}

// ---------------------------------------------------------------------------------------------
// OAuth endpoints
// ---------------------------------------------------------------------------------------------

export interface TokenSet {
  access_token: string;
  refresh_token: string | null;
  expires_at: string | null;
  scopes: string[] | null;
}

const apiBase = (provider: ProviderId, baseUrl: string) => provider === 'github' ? 'https://api.github.com'
  : provider === 'gitlab' ? `${baseUrl}/api/v4` : 'https://api.figma.com';

export function authorizeUrl(provider: ProviderId, config: ProviderConfig, input: { state: string; scopes: string[]; codeChallenge: string | null }): string {
  const target = new URL(provider === 'github' ? 'https://github.com/login/oauth/authorize'
    : provider === 'gitlab' ? `${config.base_url}/oauth/authorize` : 'https://www.figma.com/oauth');
  target.searchParams.set('client_id', config.client_id);
  target.searchParams.set('redirect_uri', callbackUrl(provider));
  target.searchParams.set('scope', input.scopes.join(provider === 'figma' ? ',' : ' '));
  target.searchParams.set('state', input.state);
  target.searchParams.set('response_type', 'code');
  if (provider === 'github') target.searchParams.set('allow_signup', 'false');
  if (input.codeChallenge) {
    target.searchParams.set('code_challenge', input.codeChallenge);
    target.searchParams.set('code_challenge_method', 'S256');
  }
  return target.toString();
}

interface RawToken {
  access_token?: string; refresh_token?: string; expires_in?: number | string; scope?: string;
  error?: string; error_description?: string;
}

function tokenSet(raw: RawToken, previousRefresh: string | null = null): TokenSet {
  if (!raw || typeof raw.access_token !== 'string' || !raw.access_token || raw.error) {
    throw new ProviderError(400, 'Échange OAuth refusé', raw);
  }
  const expiresIn = Number(raw.expires_in);
  return {
    access_token: raw.access_token,
    refresh_token: typeof raw.refresh_token === 'string' && raw.refresh_token ? raw.refresh_token : previousRefresh,
    expires_at: Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
    scopes: typeof raw.scope === 'string' ? raw.scope.split(/[\s,]+/).filter(Boolean) : null,
  };
}

const form = (values: Record<string, string>) => new URLSearchParams(values).toString();
const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;
const formHeaders = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };

function credentials(provider: ProviderId) {
  const config = providerConfig(provider);
  const secret = clientSecret(provider);
  if (!config.client_id || !secret) throw new HttpError(503, `L’application OAuth ${providerLabels[provider]} n’est pas configurée.`);
  return { config, secret };
}

export async function exchangeCode(provider: ProviderId, baseUrl: string, code: string, codeVerifier: string | null): Promise<TokenSet> {
  const { config, secret } = credentials(provider);
  const redirect = callbackUrl(provider);
  if (provider === 'github') {
    const response = await providerRequest<RawToken>('https://github.com/login/oauth/access_token', {
      method: 'POST', headers: formHeaders,
      body: form({ client_id: config.client_id, client_secret: secret, code, redirect_uri: redirect, ...(codeVerifier ? { code_verifier: codeVerifier } : {}) }),
    });
    return tokenSet(response.data);
  }
  if (provider === 'gitlab') {
    const response = await providerRequest<RawToken>(`${baseUrl}/oauth/token`, {
      method: 'POST', headers: formHeaders,
      body: form({ client_id: config.client_id, client_secret: secret, code, grant_type: 'authorization_code', redirect_uri: redirect, ...(codeVerifier ? { code_verifier: codeVerifier } : {}) }),
    });
    return tokenSet(response.data);
  }
  const response = await providerRequest<RawToken>('https://api.figma.com/v1/oauth/token', {
    method: 'POST', headers: { ...formHeaders, Authorization: basic(config.client_id, secret) },
    body: form({ redirect_uri: redirect, code, grant_type: 'authorization_code' }),
  });
  return tokenSet(response.data);
}

export async function refreshTokens(provider: ProviderId, baseUrl: string, refreshToken: string): Promise<TokenSet> {
  const { config, secret } = credentials(provider);
  if (provider === 'figma') {
    const response = await providerRequest<RawToken>('https://api.figma.com/v1/oauth/refresh', {
      method: 'POST', headers: { ...formHeaders, Authorization: basic(config.client_id, secret) },
      body: form({ refresh_token: refreshToken }),
    });
    return tokenSet(response.data, refreshToken);
  }
  const url = provider === 'github' ? 'https://github.com/login/oauth/access_token' : `${baseUrl}/oauth/token`;
  const response = await providerRequest<RawToken>(url, {
    method: 'POST', headers: formHeaders,
    body: form({ client_id: config.client_id, client_secret: secret, refresh_token: refreshToken, grant_type: 'refresh_token', ...(provider === 'gitlab' ? { redirect_uri: callbackUrl(provider) } : {}) }),
  });
  return tokenSet(response.data, refreshToken);
}

/** Best-effort revocation at the provider. Figma exposes no revocation endpoint (members revoke in Figma settings). */
export async function revokeAtProvider(provider: ProviderId, baseUrl: string, accessToken: string): Promise<boolean> {
  const config = providerConfig(provider);
  const secret = clientSecret(provider);
  if (!config.client_id || !secret || provider === 'figma') return false;
  try {
    if (provider === 'github') {
      await providerRequest(`https://api.github.com/applications/${encodeURIComponent(config.client_id)}/token`, {
        method: 'DELETE',
        headers: { Authorization: basic(config.client_id, secret), Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'Alpha-Integrations', 'X-GitHub-Api-Version': '2022-11-28' },
        body: JSON.stringify({ access_token: accessToken }),
      });
    } else {
      await providerRequest(`${baseUrl}/oauth/revoke`, {
        method: 'POST', headers: formHeaders,
        body: form({ client_id: config.client_id, client_secret: secret, token: accessToken }),
      });
    }
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Provider REST APIs (token = user's OAuth access token)
// ---------------------------------------------------------------------------------------------

function apiHeaders(provider: ProviderId, token: string, json = false): Record<string, string> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: provider === 'github' ? 'application/vnd.github+json' : 'application/json', 'User-Agent': 'Alpha-Integrations' };
  if (provider === 'github') headers['X-GitHub-Api-Version'] = '2022-11-28';
  if (json) headers['Content-Type'] = 'application/json';
  return headers;
}

export async function fetchIdentity(provider: ProviderId, baseUrl: string, token: string): Promise<{ external_id: string; login: string }> {
  if (provider === 'github') {
    const { data } = await providerRequest<{ id: number; login: string }>('https://api.github.com/user', { headers: apiHeaders(provider, token) });
    return { external_id: String(data.id), login: String(data.login ?? '') };
  }
  if (provider === 'gitlab') {
    const { data } = await providerRequest<{ id: number; username: string }>(`${apiBase(provider, baseUrl)}/user`, { headers: apiHeaders(provider, token) });
    return { external_id: String(data.id), login: String(data.username ?? '') };
  }
  const { data } = await providerRequest<{ id: string; handle: string }>('https://api.figma.com/v1/me', { headers: apiHeaders(provider, token) });
  return { external_id: String(data.id), login: String(data.handle ?? '') };
}

export interface RepositoryItem {
  external_id: string;
  full_name: string;
  url: string;
  private: boolean;
  default_branch: string;
  can_admin: boolean;
}

export async function listGithubRepos(token: string, page: number): Promise<{ items: RepositoryItem[]; has_more: boolean }> {
  const url = new URL('https://api.github.com/user/repos');
  url.searchParams.set('per_page', '30');
  url.searchParams.set('page', String(page));
  url.searchParams.set('sort', 'pushed');
  url.searchParams.set('affiliation', 'owner,collaborator,organization_member');
  const { data, headers } = await providerRequest<{ id: number; full_name: string; html_url: string; private: boolean; default_branch: string; permissions?: { admin?: boolean } }[]>(
    url.toString(), { headers: apiHeaders('github', token) });
  const items = (Array.isArray(data) ? data : []).map((repo) => ({
    external_id: String(repo.id), full_name: repo.full_name, url: repo.html_url, private: !!repo.private,
    default_branch: repo.default_branch ?? '', can_admin: !!repo.permissions?.admin,
  }));
  return { items, has_more: /rel="next"/.test(headers.get('link') ?? '') };
}

export async function listGitlabProjects(token: string, baseUrl: string, page: number, search: string): Promise<{ items: RepositoryItem[]; has_more: boolean }> {
  const url = new URL(`${apiBase('gitlab', baseUrl)}/projects`);
  url.searchParams.set('membership', 'true');
  url.searchParams.set('simple', 'true');
  url.searchParams.set('per_page', '30');
  url.searchParams.set('page', String(page));
  url.searchParams.set('order_by', 'last_activity_at');
  if (search) url.searchParams.set('search', search);
  const { data, headers } = await providerRequest<{ id: number; path_with_namespace: string; web_url: string; visibility?: string; default_branch?: string }[]>(
    url.toString(), { headers: apiHeaders('gitlab', token) });
  const items = (Array.isArray(data) ? data : []).map((project) => ({
    external_id: String(project.id), full_name: project.path_with_namespace, url: project.web_url,
    private: project.visibility !== 'public', default_branch: project.default_branch ?? '', can_admin: false,
  }));
  return { items, has_more: !!headers.get('x-next-page') };
}

export async function githubRepository(token: string, reference: string): Promise<RepositoryItem> {
  const path = /^\d+$/.test(reference) ? `/repositories/${reference}` : `/repos/${reference.split('/').map(encodeURIComponent).join('/')}`;
  const { data } = await providerRequest<{ id: number; full_name: string; html_url: string; private: boolean; default_branch: string; permissions?: { admin?: boolean } }>(
    `https://api.github.com${path}`, { headers: apiHeaders('github', token) });
  return { external_id: String(data.id), full_name: data.full_name, url: data.html_url, private: !!data.private, default_branch: data.default_branch ?? '', can_admin: !!data.permissions?.admin };
}

export async function gitlabProject(token: string, baseUrl: string, reference: string): Promise<RepositoryItem> {
  const { data } = await providerRequest<{ id: number; path_with_namespace: string; web_url: string; visibility?: string; default_branch?: string }>(
    `${apiBase('gitlab', baseUrl)}/projects/${encodeURIComponent(reference)}`, { headers: apiHeaders('gitlab', token) });
  return { external_id: String(data.id), full_name: data.path_with_namespace, url: data.web_url, private: data.visibility !== 'public', default_branch: data.default_branch ?? '', can_admin: false };
}

export async function figmaFile(token: string, fileKey: string): Promise<{ name: string }> {
  const { data } = await providerRequest<{ file?: { name?: string }; name?: string }>(
    `https://api.figma.com/v1/files/${encodeURIComponent(fileKey)}/meta`, { headers: apiHeaders('figma', token) });
  return { name: String(data.file?.name ?? data.name ?? fileKey) };
}

export const figmaEventTypes = ['FILE_VERSION_UPDATE', 'FILE_COMMENT'] as const;

/** Creates the provider-side webhook(s); returns their ids (comma-joined for Figma). */
export async function createProviderWebhook(provider: ProviderId, token: string, baseUrl: string, externalRef: string, endpoint: string, secret: string): Promise<string> {
  if (provider === 'github') {
    const { data } = await providerRequest<{ id: number }>(`https://api.github.com/repos/${externalRef.split('/').map(encodeURIComponent).join('/')}/hooks`, {
      method: 'POST', headers: apiHeaders(provider, token, true),
      body: JSON.stringify({ name: 'web', active: true, events: ['push', 'release'], config: { url: endpoint, content_type: 'json', secret, insecure_ssl: '0' } }),
    });
    return String(data.id);
  }
  if (provider === 'gitlab') {
    const { data } = await providerRequest<{ id: number }>(`${apiBase(provider, baseUrl)}/projects/${encodeURIComponent(externalRef)}/hooks`, {
      method: 'POST', headers: apiHeaders(provider, token, true),
      body: JSON.stringify({ url: endpoint, token: secret, push_events: true, tag_push_events: true, releases_events: true, enable_ssl_verification: true }),
    });
    return String(data.id);
  }
  const ids: string[] = [];
  try {
    for (const eventType of figmaEventTypes) {
      const { data } = await providerRequest<{ id: string }>('https://api.figma.com/v2/webhooks', {
        method: 'POST', headers: apiHeaders(provider, token, true),
        body: JSON.stringify({ event_type: eventType, context: 'file', context_id: externalRef, endpoint, passcode: secret, description: 'Alpha' }),
      });
      ids.push(String(data.id));
    }
  } catch (error) {
    for (const hookId of ids) await deleteProviderWebhook(provider, token, baseUrl, externalRef, hookId).catch(() => undefined);
    throw error;
  }
  return ids.join(',');
}

export async function deleteProviderWebhook(provider: ProviderId, token: string, baseUrl: string, externalRef: string, hookIds: string): Promise<void> {
  for (const hookId of hookIds.split(',').filter(Boolean)) {
    const url = provider === 'github' ? `https://api.github.com/repos/${externalRef.split('/').map(encodeURIComponent).join('/')}/hooks/${encodeURIComponent(hookId)}`
      : provider === 'gitlab' ? `${apiBase(provider, baseUrl)}/projects/${encodeURIComponent(externalRef)}/hooks/${encodeURIComponent(hookId)}`
        : `https://api.figma.com/v2/webhooks/${encodeURIComponent(hookId)}`;
    await providerRequest(url, { method: 'DELETE', headers: apiHeaders(provider, token) });
  }
}
