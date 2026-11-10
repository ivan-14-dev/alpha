/**
 * Restores a backup set created by `npm run backup` or the `ops.backup` job.
 *   npm run restore -- --list
 *   npm run restore -- <BACKUP_DIR>/alpha-20261110T030000000Z.json      (or the .sqlite.gz archive)
 *   npm run restore -- <set> --yes           -> non-interactive confirmation (otherwise type "oui" on a terminal)
 *   npm run restore -- <set> --no-files      -> database only
 *   npm run restore -- <set> --force         -> skip the "server running" lock check (dangerous)
 * Steps: sha256 verification, gunzip to a staging file, PRAGMA integrity_check, schema version check,
 * refusal while the database is open by a running server, copy of the current database to
 * `<db>.pre-restore-<date>`, atomic swap. Uploaded files are restored the same way (`<dir>.pre-restore-<date>`).
 */
import '../server/config.js';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { listBackups, restoreBackup } from '../server/ops/backup-core.js';
import { backupDirectory, databasePath, filesDirectory } from '../server/ops/paths.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'no-files': { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    yes: { type: 'boolean', short: 'y', default: false },
    list: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help || (!values.list && positionals.length !== 1)) {
  console.log('Usage : npm run restore -- <sauvegarde.json|sauvegarde.sqlite.gz> [--yes] [--no-files] [--force]\n        npm run restore -- --list');
  process.exit(values.help ? 0 : 1);
}

try {
  if (values.list) {
    const directory = backupDirectory();
    const backups = listBackups(directory);
    if (!backups.length) console.log(`Aucune sauvegarde dans ${directory}.`);
    for (const item of backups) console.log(`${directory}/${item.id}.json\t${item.created_at}\tschéma ${item.schema_version ?? '?'}${item.files ? '\t+ fichiers' : ''}`);
    process.exit(0);
  }
  const target = databasePath() === ':memory:' ? ':memory:' : resolve(databasePath());
  const files = values['no-files'] ? null : filesDirectory();
  console.log(`Sauvegarde : ${resolve(positionals[0])}\nBase cible : ${target} (DATABASE_PATH)${files ? `\nFichiers cibles : ${files}` : ''}`);
  if (values.force) console.warn('Attention : --force ignore la détection d’un serveur en cours d’exécution.');
  if (!values.yes) {
    if (!process.stdin.isTTY) throw new Error('confirmation requise : relancez avec --yes après avoir vérifié la base cible.');
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await prompt.question('Remplacer cette base ? Tapez « oui » pour confirmer : ');
    prompt.close();
    if (answer.trim().toLowerCase() !== 'oui') throw new Error('annulée par l’opérateur.');
  }
  const result = await restoreBackup({
    archive: positionals[0],
    databasePath: databasePath(),
    filesDir: files,
    force: values.force,
  });
  console.log(`Base restaurée : ${result.database} (schéma ${result.schema_version ?? '?'})`);
  if (result.pre_restore_copy) console.log(`Ancienne base conservée : ${result.pre_restore_copy}`);
  if (result.files_restored) console.log(`Fichiers restaurés${result.pre_restore_files ? ` (anciens fichiers : ${result.pre_restore_files})` : ''}.`);
  console.log('Redémarrez le serveur : les migrations manquantes seront appliquées au démarrage.');
} catch (error) {
  console.error(`Restauration refusée : ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
