import { z } from 'zod';
import { all, one, run } from '../db.js';
import { now } from '../core.js';
import { categoryDefinitions, NOTIFICATION_CATEGORIES, type NotificationCategory } from './categories.js';

export type EmailFrequency = 'immediate' | 'daily';
export interface ChannelPreference { email: boolean; push: boolean }

export function preferencesFor(userId: string): Record<NotificationCategory, ChannelPreference> {
  const rows = all<{ category: string; email: number; push: number }>(
    'SELECT category,email,push FROM notification_preferences WHERE user_id=?', userId);
  const result = {} as Record<NotificationCategory, ChannelPreference>;
  for (const definition of categoryDefinitions) {
    const row = rows.find((item) => item.category === definition.id);
    result[definition.id] = row ? { email: !!row.email, push: !!row.push } : { ...definition.defaults };
  }
  return result;
}

export function preferenceFor(userId: string, category: NotificationCategory): ChannelPreference {
  const row = one<{ email: number; push: number }>(
    'SELECT email,push FROM notification_preferences WHERE user_id=? AND category=?', userId, category);
  if (row) return { email: !!row.email, push: !!row.push };
  return { ...categoryDefinitions.find((item) => item.id === category)!.defaults };
}

export function emailFrequency(userId: string): EmailFrequency {
  return one<{ email_frequency: EmailFrequency }>('SELECT email_frequency FROM notification_settings WHERE user_id=?', userId)?.email_frequency ?? 'immediate';
}

const channel = z.object({ email: z.boolean().optional(), push: z.boolean().optional() }).strict();
export const preferencesInput = z.object({
  categories: z.record(z.string(), channel).optional()
    .refine((value) => !value || Object.keys(value).every((key) => (NOTIFICATION_CATEGORIES as readonly string[]).includes(key)), 'Catégorie de notification inconnue.'),
  email_frequency: z.enum(['immediate', 'daily']).optional(),
}).strict();
export type PreferencesInput = z.infer<typeof preferencesInput>;

/** Must run inside a transaction. Only categories present in the input are changed. */
export function updatePreferences(userId: string, input: PreferencesInput) {
  const current = preferencesFor(userId);
  const timestamp = now();
  for (const [category, change] of Object.entries(input.categories ?? {})) {
    const merged = { ...current[category as NotificationCategory], ...Object.fromEntries(Object.entries(change).filter(([, value]) => value !== undefined)) };
    run(`INSERT INTO notification_preferences(user_id,category,email,push,updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(user_id,category) DO UPDATE SET email=excluded.email,push=excluded.push,updated_at=excluded.updated_at`,
    userId, category, merged.email ? 1 : 0, merged.push ? 1 : 0, timestamp);
  }
  if (input.email_frequency) {
    const previous = emailFrequency(userId);
    // Switching to the daily digest starts a fresh 24 h window, so nothing already emailed is repeated.
    const lastDigest = input.email_frequency === 'daily' && previous !== 'daily' ? timestamp : null;
    run(`INSERT INTO notification_settings(user_id,email_frequency,last_digest_at,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET email_frequency=excluded.email_frequency,
        last_digest_at=CASE WHEN excluded.last_digest_at IS NOT NULL THEN excluded.last_digest_at ELSE last_digest_at END,
        updated_at=excluded.updated_at`, userId, input.email_frequency, lastDigest, timestamp);
  }
}

let verifiedColumn = false;
/** `users.email_verified_at` is added by migration 005 (accounts). Missing column = nobody is verified. */
export function hasVerifiedColumn(): boolean {
  if (verifiedColumn) return true;
  verifiedColumn = all<{ name: string }>('PRAGMA table_info(users)').some((column) => column.name === 'email_verified_at');
  return verifiedColumn;
}

export function verifiedEmail(userId: string): string | null {
  if (!hasVerifiedColumn()) return null;
  const user = one<{ email: string; email_verified_at: string | null }>('SELECT email,email_verified_at FROM users WHERE id=?', userId);
  if (!user?.email_verified_at || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email) || /\.invalid$/i.test(user.email)) return null;
  return user.email;
}
