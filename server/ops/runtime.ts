import { statfsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { one } from '../db.js';
import { databasePath, inMemoryDatabase } from './paths.js';

export { appVersion, backupDirectory, dataDirectory, databasePath, filesDirectory, inMemoryDatabase } from './paths.js';

/** Shared runtime facts for the ops module (paths, version, small DB helpers). */

export const startedAt = new Date();

export function tableExists(name: string): boolean {
  return !!one('SELECT 1 FROM sqlite_master WHERE type=\'table\' AND name=?', name);
}

export function fileSize(path: string): number {
  try { return statSync(path).size; } catch { return 0; }
}

export function databaseSizes() {
  const pages = one<{ page_count: number }>('PRAGMA page_count')?.page_count ?? 0;
  const pageSize = one<{ page_size: number }>('PRAGMA page_size')?.page_size ?? 0;
  const free = one<{ freelist_count: number }>('PRAGMA freelist_count')?.freelist_count ?? 0;
  const path = inMemoryDatabase() ? null : resolve(databasePath());
  return {
    database_bytes: pages * pageSize,
    free_pages_bytes: free * pageSize,
    wal_bytes: path ? fileSize(`${path}-wal`) : 0,
  };
}

/** Free/total bytes of the filesystem holding `path` (null when unavailable). */
export function diskSpace(path: string): { free_bytes: number; total_bytes: number } | null {
  try {
    const stats = statfsSync(path);
    return { free_bytes: stats.bavail * stats.bsize, total_bytes: stats.blocks * stats.bsize };
  } catch {
    return null;
  }
}
