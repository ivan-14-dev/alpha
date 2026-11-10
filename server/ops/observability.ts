import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { log } from '../platform/log.js';
import { httpRequestEnded, httpRequestStarted, recordHttpRequest, routeLabel } from './metrics.js';

/** Requests slower than this are logged at warn level (long-lived realtime streams excluded). */
const slowRequestMs = 5000;

const matchedRoutes = new WeakMap<Request, { baseUrl: string }>();

/**
 * The router resets req.baseUrl when an error leaves a mounted router, so by the time the response finishes
 * the mount prefix may be gone. Record it at the moment the router assigns req.route instead.
 */
function captureRoutePattern(req: Request) {
  let route: Request['route'] = undefined;
  Object.defineProperty(req, 'route', {
    configurable: true,
    enumerable: true,
    get: () => route,
    set: (value: Request['route']) => {
      route = value;
      if (value) matchedRoutes.set(req, { baseUrl: req.baseUrl });
    },
  });
}

/**
 * Request id + access log + Prometheus HTTP metrics. OWNER: ops module.
 * Must stay first in the middleware chain.
 */
export function observability(req: Request, res: Response, next: NextFunction) {
  const incoming = req.headers['x-request-id'];
  const requestId = typeof incoming === 'string' && /^[A-Za-z0-9._-]{8,80}$/.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', requestId);
  const started = process.hrtime.bigint();
  captureRoutePattern(req);
  httpRequestStarted();
  res.once('close', httpRequestEnded);
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    // Raw URLs are never used as labels: only the pattern captured when the route matched.
    const route = routeLabel(matchedRoutes.get(req)?.baseUrl ?? req.baseUrl, req.route?.path, !!req.route, req.originalUrl);
    recordHttpRequest(req.method, route, res.statusCode, durationMs / 1000);
    if (route === '(static)') return;
    const fields = { request_id: requestId, method: req.method, route, status: res.statusCode, duration_ms: Math.round(durationMs) };
    const streaming = String(res.getHeader('content-type') ?? '').startsWith('text/event-stream');
    if (res.statusCode >= 500) log.warn('http.request', fields);
    else if (durationMs > slowRequestMs && !streaming) log.warn('http.slow_request', fields);
    else log.debug('http.request', fields);
  });
  next();
}
