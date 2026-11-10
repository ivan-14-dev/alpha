import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Deployment paths and version. No database import: safe for CLI scripts (backup/restore). */

export const appVersion: string = (() => {
  try {
    return (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

export function databasePath(): string { return process.env.DATABASE_PATH ?? './data/alpha.sqlite'; }
export function inMemoryDatabase(): boolean { return databasePath() === ':memory:'; }

/** Directory holding the database (and by default files/ and backups/). */
export function dataDirectory(): string {
  return inMemoryDatabase() ? resolve('data') : dirname(resolve(databasePath()));
}

/** Same default as the files module (server/files/storage.ts); null for in-memory databases (ephemeral files). */
export function filesDirectory(): string | null {
  if (process.env.FILES_DIR) return resolve(process.env.FILES_DIR);
  return inMemoryDatabase() ? null : join(dataDirectory(), 'files');
}
export function backupDirectory(): string { return resolve(process.env.BACKUP_DIR ?? join(dataDirectory(), 'backups')); }
