import { createHash } from 'node:crypto';
import { z } from 'zod';
import { appOrigin, getSecretSetting, getSetting, hasSecretSetting } from '../platform/settings.js';
import { maskSecret } from '../platform/secrets.js';

export const oauthProviderIds = ['github', 'google'] as const;
export type OAuthProvider = typeof oauthProviderIds[number];

interface ProviderDefinition {
  name: string;
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
  consoleUrl: string;
}

export const providerDefinitions: Record<OAuthProvider, ProviderDefinition> = {
  github: {
    name: 'GitHub',
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scope: 'read:user user:email',
    consoleUrl: 'https://github.com/settings/developers',
  },
  google: {
    name: 'Google',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile',
    consoleUrl: 'https://console.cloud.google.com/apis/credentials',
  },
};

export const isOAuthProvider = (value: unknown): value is OAuthProvider => typeof value === 'string' && (oauthProviderIds as readonly string[]).includes(value);

export const providerConfigSchema = z.object({ enabled: z.boolean(), client_id: z.string().max(200) }).strict();
export type ProviderConfig = z.infer<typeof providerConfigSchema>;
export const oauthSettingKey = (provider: OAuthProvider) => `auth.oauth.${provider}`;
export const oauthSecretKey = (provider: OAuthProvider) => `auth.oauth.${provider}.client_secret`;
export const oauthCallbackUrl = (provider: OAuthProvider) => `${appOrigin()}/api/auth/oauth/${provider}/callback`;

export function oauthConfig(provider: OAuthProvider): ProviderConfig {
  return getSetting<ProviderConfig>(oauthSettingKey(provider), providerConfigSchema, { enabled: false, client_id: '' });
}

/** Enabled AND fully configured (client id + sealed secret). */
export function oauthReady(provider: OAuthProvider): boolean {
  const config = oauthConfig(provider);
  return config.enabled && !!config.client_id && hasSecretSetting(oauthSecretKey(provider));
}

export const enabledOAuthProviders = () => oauthProviderIds.filter(oauthReady);

/** Admin-safe description: the client secret is never returned, only a mask. */
export function describeOAuthProvider(provider: OAuthProvider) {
  const config = oauthConfig(provider);
  const secret = getSecretSetting(oauthSecretKey(provider));
  return {
    id: provider,
    name: providerDefinitions[provider].name,
    enabled: config.enabled,
    client_id: config.client_id,
    client_secret: { configured: !!secret, mask: maskSecret(secret) },
    callback_url: oauthCallbackUrl(provider),
    console_url: providerDefinitions[provider].consoleUrl,
    scope: providerDefinitions[provider].scope,
    ready: config.enabled && !!config.client_id && !!secret,
  };
}

/**
 * Same-site relative path only: one leading slash, no scheme/host, no backslash, printable ASCII,
 * and never an API route. Returns the normalised path or null.
 */
export function safeRedirectPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return null;
  if (!/^[\x21-\x7e]+$/.test(value) || value.includes('\\')) return null;
  if (!value.startsWith('/') || value.startsWith('//')) return null;
  const sentinel = 'http://alpha.invalid';
  let parsed: URL;
  try { parsed = new URL(value, sentinel); } catch { return null; }
  if (parsed.origin !== sentinel) return null;
  const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  if (!path.startsWith('/') || path.startsWith('//') || /^\/api(\/|$)/i.test(parsed.pathname)) return null;
  return path;
}

export function withQuery(path: string, params: Record<string, string>): string {
  const hashIndex = path.indexOf('#');
  const base = hashIndex === -1 ? path : path.slice(0, hashIndex);
  const hash = hashIndex === -1 ? '' : path.slice(hashIndex);
  const query = new URLSearchParams(params).toString();
  return `${base}${base.includes('?') ? '&' : '?'}${query}${hash}`;
}

export const pkceChallenge = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

export function authorizationUrl(provider: OAuthProvider, state: string, verifier: string): string {
  const definition = providerDefinitions[provider];
  const url = new URL(definition.authorizeUrl);
  const params: Record<string, string> = {
    client_id: oauthConfig(provider).client_id,
    redirect_uri: oauthCallbackUrl(provider),
    response_type: 'code',
    scope: definition.scope,
    state,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: 'S256',
  };
  if (provider === 'github') params.allow_signup = 'true';
  if (provider === 'google') params.prompt = 'select_account';
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

/** Thrown for provider-side failures; `code` becomes the `oauth_error` query parameter. */
export class OAuthFlowError extends Error {
  constructor(public code: OAuthErrorCode, detail: string = code) { super(detail); }
}
export type OAuthErrorCode = 'access_denied' | 'state' | 'provider_disabled' | 'login_required' | 'provider_error'
  | 'email_unverified' | 'account_exists' | 'identity_taken' | 'already_linked' | 'restricted';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
let fetchOverride: FetchLike | null = null;
/** Test hook: replaces the network client used to talk to OAuth providers (null restores global fetch). */
export function setOAuthFetchForTests(fetcher: FetchLike | null) { fetchOverride = fetcher; }

async function providerJson(url: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await (fetchOverride ?? fetch)(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10000) });
  } catch (error) {
    throw new OAuthFlowError('provider_error', `network: ${error instanceof Error ? error.name : 'unknown'}`);
  }
  const text = await response.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw new OAuthFlowError('provider_error', `invalid JSON (HTTP ${response.status})`); }
  if (!response.ok) throw new OAuthFlowError('provider_error', `HTTP ${response.status}`);
  return body;
}

const tokenResponse = z.object({ access_token: z.string().min(1).max(4096), token_type: z.string().optional() }).passthrough();

export async function exchangeCode(provider: OAuthProvider, code: string, verifier: string): Promise<string> {
  const config = oauthConfig(provider);
  const secret = getSecretSetting(oauthSecretKey(provider));
  if (!config.enabled || !config.client_id || !secret) throw new OAuthFlowError('provider_disabled');
  const form = new URLSearchParams({
    client_id: config.client_id,
    client_secret: secret,
    code,
    redirect_uri: oauthCallbackUrl(provider),
    code_verifier: verifier,
  });
  if (provider === 'google') form.set('grant_type', 'authorization_code');
  const body = await providerJson(providerDefinitions[provider].tokenUrl, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Alpha' },
    body: form.toString(),
  });
  // GitHub answers 200 with { error } for invalid or reused codes.
  const parsed = tokenResponse.safeParse(body);
  if (!parsed.success) throw new OAuthFlowError('provider_error', 'token exchange refused');
  return parsed.data.access_token;
}

export interface OAuthProfile {
  providerUserId: string;
  email: string;
  emailVerified: boolean;
  name: string;
}

const githubUser = z.object({ id: z.number().int().positive(), login: z.string().max(100), name: z.string().max(255).nullable().optional() }).passthrough();
const githubEmails = z.array(z.object({ email: z.string(), primary: z.boolean(), verified: z.boolean() }).passthrough());
const googleUser = z.object({
  sub: z.string().min(1).max(255),
  email: z.string().optional(),
  email_verified: z.union([z.boolean(), z.literal('true'), z.literal('false')]).optional(),
  name: z.string().max(255).optional(),
}).passthrough();
const emailFormat = z.string().trim().email().max(254);

function normalizedEmail(value: string | undefined): string | null {
  const parsed = emailFormat.safeParse(value);
  return parsed.success ? parsed.data.toLowerCase() : null;
}

export async function fetchProfile(provider: OAuthProvider, accessToken: string): Promise<OAuthProfile> {
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'User-Agent': 'Alpha' };
  if (provider === 'github') {
    const githubHeaders = { ...headers, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    const user = githubUser.safeParse(await providerJson('https://api.github.com/user', { headers: githubHeaders }));
    if (!user.success) throw new OAuthFlowError('provider_error', 'unexpected GitHub profile');
    const emails = githubEmails.safeParse(await providerJson('https://api.github.com/user/emails', { headers: githubHeaders }));
    if (!emails.success) throw new OAuthFlowError('provider_error', 'unexpected GitHub emails');
    const primary = emails.data.find((entry) => entry.primary);
    const email = normalizedEmail(primary?.email);
    if (!email) throw new OAuthFlowError('email_unverified', 'no usable primary e-mail');
    return { providerUserId: String(user.data.id), email, emailVerified: primary!.verified === true, name: (user.data.name || user.data.login).trim() };
  }
  const user = googleUser.safeParse(await providerJson('https://openidconnect.googleapis.com/v1/userinfo', { headers }));
  if (!user.success) throw new OAuthFlowError('provider_error', 'unexpected Google profile');
  const email = normalizedEmail(user.data.email);
  if (!email) throw new OAuthFlowError('email_unverified', 'no e-mail');
  const verified = user.data.email_verified === true || user.data.email_verified === 'true';
  return { providerUserId: user.data.sub, email, emailVerified: verified, name: (user.data.name ?? '').trim() };
}
