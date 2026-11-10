import type { z } from 'zod';
import { one, run } from '../db.js';
import { now } from '../core.js';
import { seal, unseal } from './secrets.js';

/**
 * Admin-editable platform configuration. Non-secret values are JSON; secrets are sealed with
 * AES-256-GCM (context = setting key) and are never returned to the browser.
 */
export function getSetting<T>(key: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, fallback: T): T {
  const row = one<{ value: string }>('SELECT value FROM platform_settings WHERE key=?', key);
  if (!row) return fallback;
  const parsed = schema.safeParse(JSON.parse(row.value));
  return parsed.success ? parsed.data : fallback;
}

/** Must be called inside the caller's transaction when combined with other writes. */
export function setSetting(key: string, value: unknown, actorId: string | null) {
  run(`INSERT INTO platform_settings(key,value,updated_by,updated_at) VALUES (?,?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,updated_at=excluded.updated_at`,
  key, JSON.stringify(value ?? null), actorId, now());
}

export function getSecretSetting(key: string): string | null {
  const row = one<{ secret: string | null }>('SELECT secret FROM platform_settings WHERE key=?', key);
  return row?.secret ? unseal(row.secret, `setting:${key}`) : null;
}

export function hasSecretSetting(key: string): boolean {
  return !!one<{ present: number }>('SELECT secret IS NOT NULL AS present FROM platform_settings WHERE key=?', key)?.present;
}

/** `null` removes the secret. Must be called inside the caller's transaction when combined with other writes. */
export function setSecretSetting(key: string, plaintext: string | null, actorId: string | null) {
  const sealed = plaintext === null ? null : seal(plaintext, `setting:${key}`);
  run(`INSERT INTO platform_settings(key,value,secret,updated_by,updated_at) VALUES (?, 'null', ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET secret=excluded.secret,updated_by=excluded.updated_by,updated_at=excluded.updated_at`,
  key, sealed, actorId, now());
}

export function settingUpdatedAt(key: string): string | null {
  return one<{ updated_at: string }>('SELECT updated_at FROM platform_settings WHERE key=?', key)?.updated_at ?? null;
}

/** Public origin used to build absolute links in emails, OAuth callbacks and provider redirects. */
export function appOrigin(): string {
  return (process.env.APP_ORIGIN ?? `http://127.0.0.1:${process.env.VITE_PORT ?? 5173}`).replace(/\/$/, '');
}

/** Origin reachable by external services (webhooks). Defaults to APP_ORIGIN. */
export function publicApiOrigin(): string {
  return (process.env.PUBLIC_API_ORIGIN ?? appOrigin()).replace(/\/$/, '');
}
