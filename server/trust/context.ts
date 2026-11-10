import { AsyncLocalStorage } from 'node:async_hooks';
import type { Request } from 'express';

/**
 * Per-request context opened by `capabilityMiddleware`, so synchronous domain-event hooks (which only receive
 * the audited action) can attach the request fingerprint hashes of the acting member.
 */
interface TrustRequestContext { req: Request }

const storage = new AsyncLocalStorage<TrustRequestContext>();

export function runWithRequest<T>(req: Request, work: () => T): T {
  return storage.run({ req }, work);
}

export const webhookPrefixes = ['/api/payments/webhooks/', '/api/integrations/webhooks/'];

/** Lower-cased, decoded, slash-normalised API path (Express routing is case-insensitive). */
export function normalizedPath(req: Request): string {
  const raw = (req.originalUrl ?? req.url ?? '').split('?')[0] ?? '';
  let path = raw;
  try { path = decodeURIComponent(raw); } catch { /* keep the raw path */ }
  return path.replace(/\\/g, '/').replace(/\/{2,}/g, '/').toLowerCase();
}

export const isWebhookRequest = (req: Request) => webhookPrefixes.some((prefix) => normalizedPath(req).startsWith(prefix));

/**
 * The current request, only when it was made by `actorId` itself (never a webhook, a job or another member's
 * request), so signals are never attributed to the wrong person.
 */
export function requestOf(actorId: string | null | undefined): Request | null {
  const req = storage.getStore()?.req;
  if (!req || !actorId || req.user?.id !== actorId || isWebhookRequest(req)) return null;
  return req;
}
