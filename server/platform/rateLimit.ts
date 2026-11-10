import type { NextFunction, Request, Response } from 'express';
import { one, run, transaction } from '../db.js';
import { HttpError } from '../core.js';
import { registerJob } from './jobs.js';
import { keyedHash } from './secrets.js';

export interface RateResult { allowed: boolean; remaining: number; resetAt: string }

/**
 * Durable fixed-window limiter stored in SQLite (survives restarts). Keys are HMAC-hashed so raw
 * IP addresses or emails are never persisted. Call inside or outside a transaction.
 */
export function hit(rawKey: string, limit: number, windowMs: number): RateResult {
  const key = keyedHash(rawKey, 'rate-limit');
  const current = new Date();
  const fresh = new Date(current.getTime() + windowMs).toISOString();
  const work = () => {
    run(`INSERT INTO rate_limit_buckets(key,count,reset_at) VALUES (?,1,?)
      ON CONFLICT(key) DO UPDATE SET
        count=CASE WHEN reset_at<=? THEN 1 ELSE count+1 END,
        reset_at=CASE WHEN reset_at<=? THEN excluded.reset_at ELSE reset_at END`, key, fresh, current.toISOString(), current.toISOString());
    return one<{ count: number; reset_at: string }>('SELECT count,reset_at FROM rate_limit_buckets WHERE key=?', key)!;
  };
  const bucket = transaction(work);
  return { allowed: bucket.count <= limit, remaining: Math.max(0, limit - bucket.count), resetAt: bucket.reset_at };
}

/** Clears a bucket (e.g. after a successful login). */
export function resetHits(rawKey: string) {
  run('DELETE FROM rate_limit_buckets WHERE key=?', keyedHash(rawKey, 'rate-limit'));
}

export function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

export function rateLimit(options: { name: string; limit: number; windowMs: number; key?: (req: Request) => string; message?: string }) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = `${options.name}:${options.key ? options.key(req) : clientIp(req)}`;
    const result = hit(key, options.limit, options.windowMs);
    res.setHeader('RateLimit-Limit', String(options.limit));
    res.setHeader('RateLimit-Remaining', String(result.remaining));
    if (!result.allowed) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((Date.parse(result.resetAt) - Date.now()) / 1000))));
      throw new HttpError(429, options.message ?? 'Trop de tentatives. Reessayez plus tard.');
    }
    next();
  };
}

registerJob({
  name: 'rate-limit.purge',
  description: 'Supprime les compteurs anti-abus expirés.',
  intervalMs: 10 * 60000,
  run: () => { run('DELETE FROM rate_limit_buckets WHERE reset_at<=?', new Date().toISOString()); },
});
