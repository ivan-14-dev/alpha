import { HttpError } from '../core.js';

/**
 * HTTP client for provider APIs (GitHub, GitLab, Figma). Tests inject a fake fetch so no request
 * ever leaves the machine. Redirects are refused: provider APIs never need them for our calls and
 * following them could leak the bearer token to another host.
 */
let fetchOverride: typeof fetch | null = null;

export function setIntegrationsFetchForTests(value: typeof fetch | null) {
  if (value && process.env.NODE_ENV === 'production') throw new Error('Surcharge réservée aux tests.');
  fetchOverride = value;
}

export class ProviderError extends Error {
  constructor(public status: number, message: string, public body: unknown = null) { super(message); }
}

export interface ProviderResponse<T> { status: number; data: T; headers: Headers }

export async function providerRequest<T>(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<ProviderResponse<T>> {
  const { timeoutMs = 15000, ...rest } = init;
  let response: Response;
  try {
    response = await (fetchOverride ?? globalThis.fetch)(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs), ...rest });
  } catch (error) {
    throw new ProviderError(0, error instanceof Error && error.name === 'TimeoutError' ? 'Délai dépassé' : 'Service injoignable');
  }
  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = Object.fromEntries(new URLSearchParams(text)); }
  }
  if (!response.ok) throw new ProviderError(response.status, `HTTP ${response.status}`, data);
  return { status: response.status, data: data as T, headers: response.headers };
}

/** Converts provider failures into actionable French API errors without leaking provider bodies. */
export function providerFailure(error: unknown, label: string): never {
  if (error instanceof HttpError) throw error;
  if (error instanceof ProviderError) {
    if (error.status === 401) throw new HttpError(409, `La connexion ${label} a expiré ou a été révoquée. Reconnectez votre compte.`);
    if (error.status === 403) throw new HttpError(403, `${label} refuse l’accès à cette ressource avec les autorisations accordées.`);
    if (error.status === 404) throw new HttpError(404, `Ressource ${label} introuvable ou inaccessible avec ce compte.`);
    if (error.status === 429) throw new HttpError(429, `${label} limite temporairement les requêtes. Réessayez dans quelques minutes.`);
    throw new HttpError(502, `${label} n’a pas répondu correctement. Réessayez plus tard.`);
  }
  throw error;
}
