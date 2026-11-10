import { z } from 'zod';
import { db } from '../db.js';
import { registerJob } from '../platform/jobs.js';
import { log } from '../platform/log.js';
import { getSetting } from '../platform/settings.js';
import { createBackup, listBackups, type BackupManifest } from './backup-core.js';
import { appVersion, backupDirectory, databasePath, filesDirectory, inMemoryDatabase } from './runtime.js';

export const BACKUP_SETTING = 'ops.backup';
export const backupSettingsSchema = z.object({
  enabled: z.boolean(),
  keep: z.number().int().min(1).max(365),
  include_files: z.boolean(),
}).strict();
export type BackupSettings = z.infer<typeof backupSettingsSchema>;

/** Scheduled backups are on by default in production only (dev machines keep their data dir clean). */
export function backupSettings(): BackupSettings {
  return getSetting(BACKUP_SETTING, backupSettingsSchema, { enabled: process.env.NODE_ENV === 'production', keep: 14, include_files: true });
}

/** The job wakes up hourly (restarts never postpone it) and backs up when the latest set is older than this. */
const backupEveryMs = 24 * 3_600_000;
const tolerance = 30 * 60_000;

let inProgress: Promise<BackupManifest> | null = null;

export class BackupBusyError extends Error {
  constructor() { super('Une sauvegarde est déjà en cours.'); }
}

export function backupInProgress(): boolean { return inProgress !== null; }

export function latestBackup(): BackupManifest | null {
  return listBackups(backupDirectory())[0] ?? null;
}

/** Creates a backup set now. Async work happens outside any transaction; never runs twice concurrently. */
export async function runBackup(options: { includeFiles?: boolean } = {}): Promise<BackupManifest> {
  if (inProgress) throw new BackupBusyError();
  const settings = backupSettings();
  inProgress = createBackup({
    source: inMemoryDatabase() ? db : databasePath(),
    backupDir: backupDirectory(),
    keep: settings.keep,
    filesDir: (options.includeFiles ?? settings.include_files) ? filesDirectory() : null,
    appVersion,
  });
  try {
    const manifest = await inProgress;
    log.info('ops.backup.created', { id: manifest.id, bytes: manifest.database.bytes, files: !!manifest.files });
    return manifest;
  } finally {
    inProgress = null;
  }
}

export function backupDue(now = Date.now()): boolean {
  const latest = latestBackup();
  return !latest || now - Date.parse(latest.created_at) >= backupEveryMs - tolerance;
}

registerJob({
  name: 'ops.backup',
  description: 'Sauvegarde quotidienne cohérente de la base (VACUUM INTO) et des fichiers, avec rotation. Vérifiée toutes les heures.',
  intervalMs: 3_600_000,
  enabled: () => backupSettings().enabled,
  run: async () => {
    if (!backupDue()) return;
    await runBackup();
  },
});
