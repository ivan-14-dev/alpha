/**
 * Consistent online backup (VACUUM INTO) of the SQLite database, plus the uploaded files directory.
 *   npm run backup                       -> BACKUP_DIR (default <data>/backups), files included
 *   npm run backup -- --keep 14          -> also prune to the 14 most recent sets
 *   npm run backup -- --no-files --dir /mnt/backups
 *   npm run backup -- --list
 * Safe while the server runs. Copy the result off-site (restic, rclone): see docs/operations.md.
 */
import '../server/config.js';
import { parseArgs } from 'node:util';
import { createBackup, listBackups } from '../server/ops/backup-core.js';
import { appVersion, backupDirectory, databasePath, filesDirectory } from '../server/ops/paths.js';

const { values } = parseArgs({
  options: {
    dir: { type: 'string' },
    keep: { type: 'string' },
    'no-files': { type: 'boolean', default: false },
    list: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.log('Usage : npm run backup -- [--dir <dossier>] [--keep <n>] [--no-files] [--list]');
  process.exit(0);
}

const directory = values.dir ?? backupDirectory();
try {
  if (values.list) {
    const backups = listBackups(directory);
    if (!backups.length) console.log(`Aucune sauvegarde dans ${directory}.`);
    for (const item of backups) {
      console.log(`${item.id}\t${item.created_at}\tschéma ${item.schema_version ?? '?'}\t${item.database.bytes} o${item.files ? `\t+ fichiers ${item.files.bytes} o` : ''}`);
    }
    process.exit(0);
  }
  const keep = values.keep === undefined ? undefined : Number(values.keep);
  if (keep !== undefined && (!Number.isInteger(keep) || keep < 1)) throw new Error('--keep attend un entier positif.');
  if (databasePath() === ':memory:') throw new Error('DATABASE_PATH=:memory: ne peut pas être sauvegardé.');
  const manifest = await createBackup({
    source: databasePath(),
    backupDir: directory,
    keep,
    filesDir: values['no-files'] ? null : filesDirectory(),
    appVersion,
  });
  console.log(`Sauvegarde créée : ${directory}/${manifest.database.file} (${manifest.database.bytes} octets, sha256 ${manifest.database.sha256})`);
  if (manifest.files) console.log(`Fichiers : ${directory}/${manifest.files.file} (${manifest.files.bytes} octets)`);
  else if (manifest.files_skipped) console.log(`Fichiers non archivés : ${manifest.files_skipped}`);
} catch (error) {
  console.error(`Échec de la sauvegarde : ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
