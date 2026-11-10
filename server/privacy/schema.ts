import { all, one } from '../db.js';

/** Schema introspection so privacy can cooperate with optional tables owned by other modules without importing them. */
export function tableExists(name: string): boolean {
  return !!one("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name);
}

export function tableColumns(name: string): string[] {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name) || !tableExists(name)) return [];
  return all<{ name: string }>(`PRAGMA table_info(${name})`).map((column) => column.name);
}

export function hasColumns(table: string, ...columns: string[]): boolean {
  const existing = tableColumns(table);
  return columns.every((column) => existing.includes(column));
}

export function foreignKeyViolations(): number {
  return all('PRAGMA foreign_key_check').length;
}

/** Keys never exported, whatever their origin (core tables or module handlers). */
const forbiddenKey = /(password|passwd|token|secret|hash|sealed|cipher|totp|otp_|mfa_secret|recovery_code|private_key|api_key|signature|salt|storage_key)/i;
/** Values that look like sealed secrets (server/platform/secrets.ts format). */
const sealedValue = /^v1\.[a-f0-9]{12}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./;

/** Deep copy without secrets: drops forbidden keys, masks sealed values, converts BigInt/Buffers. */
export function stripSecrets(value: unknown, depth = 0): unknown {
  if (depth > 25) return '[profondeur maximale atteinte]';
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') return sealedValue.test(value) ? '[donnée chiffrée non exportée]' : value;
  if (typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return '[contenu binaire non exporté]';
  if (Array.isArray(value)) return value.map((item) => stripSecrets(item, depth + 1));
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (forbiddenKey.test(key)) continue;
    result[key] = stripSecrets(item, depth + 1);
  }
  return result;
}
