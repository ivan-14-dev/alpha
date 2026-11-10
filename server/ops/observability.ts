import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { log } from '../platform/log.js';

/**
 * Request id + access log. OWNER: ops module (adds Prometheus metrics, latency histograms).
 * Must stay first in the middleware chain.
 */
export function observability(req: Request, res: Response, next: NextFunction) {
  const incoming = req.headers['x-request-id'];
  const requestId = typeof incoming === 'string' && /^[A-Za-z0-9._-]{8,80}$/.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', requestId);
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    if (!req.originalUrl.startsWith('/api')) return;
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    log.debug('http.request', { request_id: requestId, method: req.method, path: req.route?.path ?? req.path, status: res.statusCode, duration_ms: Math.round(durationMs) });
  });
  next();
}
