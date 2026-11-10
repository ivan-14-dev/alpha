import { all, one } from '../db.js';
import { exponent } from '../payments/mode.js';

/** Schema introspection so the module degrades gracefully while sibling migrations (005, 007) are not applied. */
export function tableExists(table: string): boolean {
  return !!one("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", table);
}

export function columnExists(table: string, column: string): boolean {
  if (!/^[a-z_]+$/.test(table)) return false;
  return all<{ name: string }>(`PRAGMA table_info(${table})`).some((item) => item.name === column);
}

/** Fails closed: without the accounts migration nobody counts as verified. */
export function emailVerified(userId: string): boolean {
  if (!columnExists('users', 'email_verified_at')) return false;
  return !!one<{ verified: string | null }>('SELECT email_verified_at AS verified FROM users WHERE id=?', userId)?.verified;
}

export const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (char) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[char]);

/** CSV cell safe against formula injection (OWASP): text starting with = + - @ TAB CR is prefixed with a quote. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function formatMoney(minor: number, currency: string): string {
  const digits = exponent(currency);
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits })
    .format(minor / 10 ** digits);
}

export const isoIn = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();
export const isoAgo = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();

export function ageInYears(dateOfBirth: string, at = new Date()): number {
  const [year, month, day] = dateOfBirth.split('-').map(Number);
  let age = at.getUTCFullYear() - year;
  if (at.getUTCMonth() + 1 < month || (at.getUTCMonth() + 1 === month && at.getUTCDate() < day)) age -= 1;
  return age;
}

export function isRealDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export const isoCountry = /^[A-Z]{2}$/;
