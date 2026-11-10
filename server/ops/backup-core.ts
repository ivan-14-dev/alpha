import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { createGunzip, createGzip } from 'node:zlib';
import { latestSchemaVersion } from '../migrations.js';

/**
 * Backup/restore primitives shared by the `ops.backup` job, the admin API and the CLI scripts.
 * Deliberately independent from server/db.ts so CLI tools never run migrations or open the app connection.
 *
 * A backup set `<id>` is: `<id>.sqlite.gz` (+ `.sha256`), optionally `<id>.files.tar.gz` (+ `.sha256`),
 * and `<id>.json` (manifest, written last: a set without manifest is incomplete).
 */

const execFileAsync = promisify(execFile);

export interface BackupArtifact { file: string; bytes: number; sha256: string }
export interface BackupManifest {
  id: string;
  created_at: string;
  app_version: string;
  schema_version: number | null;
  database: BackupArtifact & { uncompressed_bytes: number };
  files: (BackupArtifact & { source: string }) | null;
  files_skipped?: string;
}

export interface CreateBackupOptions {
  /** Open connection (in-memory/test databases) or path of the SQLite file (opened read-only). */
  source: DatabaseSync | string;
  backupDir: string;
  keep?: number;
  /** Directory of uploaded files to archive with tar (skipped when null/missing/empty). */
  filesDir?: string | null;
  appVersion?: string;
  now?: Date;
}

const manifestPattern = /^alpha-\d{8}T\d{9}Z(?:-\d+)?\.json$/;

function stamp(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, '');
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/** `sha256sum -c` compatible line. */
function writeChecksum(path: string, digest: string) {
  writeFileSync(`${path}.sha256`, `${digest}  ${basename(path)}\n`, { mode: 0o600 });
}

function readChecksum(path: string): string {
  const checksumFile = `${path}.sha256`;
  if (!existsSync(checksumFile)) throw new Error(`Fichier de somme de contrôle introuvable : ${checksumFile}`);
  const digest = readFileSync(checksumFile, 'utf8').trim().split(/\s+/)[0] ?? '';
  if (!/^[a-f0-9]{64}$/i.test(digest)) throw new Error(`Somme de contrôle illisible : ${checksumFile}`);
  return digest.toLowerCase();
}

/** Throws when the artifact does not match its `.sha256` companion. */
export async function verifyChecksum(path: string): Promise<string> {
  if (!existsSync(path)) throw new Error(`Sauvegarde introuvable : ${path}`);
  const expected = readChecksum(path);
  const actual = await sha256File(path);
  if (actual !== expected) throw new Error(`Somme de contrôle invalide pour ${basename(path)} : la sauvegarde est corrompue ou a été modifiée.`);
  return actual;
}

function integrity(database: DatabaseSync): string {
  const rows = database.prepare('PRAGMA integrity_check').all() as Array<Record<string, unknown>>;
  return rows.map((row) => String(Object.values(row)[0])).join('; ');
}

function schemaVersion(database: DatabaseSync): number | null {
  const table = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
  if (!table) return null;
  return (database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null }).version;
}

/** Checks a plain SQLite file: integrity + schema not newer than this code base. */
export function inspectDatabaseFile(path: string): { schema_version: number | null } {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const result = integrity(database);
    if (result !== 'ok') throw new Error(`Contrôle d’intégrité SQLite en échec : ${result.slice(0, 300)}`);
    const version = schemaVersion(database);
    if (version !== null && version > latestSchemaVersion) {
      throw new Error(`La sauvegarde utilise le schéma ${version}, plus récent que cette version de l’application (${latestSchemaVersion}).`);
    }
    return { schema_version: version };
  } finally {
    database.close();
  }
}

async function gzipFile(source: string, target: string) {
  await pipeline(createReadStream(source), createGzip({ level: 9 }), createWriteStream(target, { mode: 0o600 }));
}

async function gunzipFile(source: string, target: string) {
  await pipeline(createReadStream(source), createGunzip(), createWriteStream(target, { mode: 0o600 }));
}

function directoryHasEntries(path: string): boolean {
  try { return readdirSync(path).length > 0; } catch { return false; }
}

/** Consistent online snapshot with `VACUUM INTO` (works while the server is running, WAL mode). */
function snapshot(source: DatabaseSync | string, target: string) {
  if (typeof source !== 'string') {
    source.exec(`VACUUM INTO ${sqlString(target)}`);
    return;
  }
  if (!existsSync(source)) throw new Error(`Base de données introuvable : ${source}`);
  const database = new DatabaseSync(source, { readOnly: true });
  try {
    database.exec('PRAGMA busy_timeout = 10000');
    database.exec(`VACUUM INTO ${sqlString(target)}`);
  } finally {
    database.close();
  }
}

function removeSet(directory: string, id: string) {
  for (const suffix of ['.json', '.sqlite.gz', '.sqlite.gz.sha256', '.files.tar.gz', '.files.tar.gz.sha256']) {
    rmSync(join(directory, `${id}${suffix}`), { force: true });
  }
}

export function listBackups(directory: string): BackupManifest[] {
  if (!existsSync(directory)) return [];
  const manifests: BackupManifest[] = [];
  for (const name of readdirSync(directory)) {
    if (!manifestPattern.test(name)) continue;
    try {
      const manifest = JSON.parse(readFileSync(join(directory, name), 'utf8')) as BackupManifest;
      if (manifest.id === name.slice(0, -5) && manifest.database?.file) manifests.push(manifest);
    } catch {
      // Unreadable manifest: ignored (the set is treated as incomplete).
    }
  }
  return manifests.sort((left, right) => right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id));
}

/** Keeps the `keep` most recent complete sets and removes stale partial files (> 1 day). */
export function pruneBackups(directory: string, keep: number): string[] {
  const removed: string[] = [];
  for (const manifest of listBackups(directory).slice(Math.max(1, keep))) {
    removeSet(directory, manifest.id);
    removed.push(manifest.id);
  }
  const dayAgo = Date.now() - 86_400_000;
  for (const name of existsSync(directory) ? readdirSync(directory) : []) {
    if (!name.endsWith('.partial')) continue;
    const path = join(directory, name);
    try { if (statSync(path).mtimeMs < dayAgo) rmSync(path, { force: true }); } catch { /* concurrently removed */ }
  }
  return removed;
}

export async function createBackup(options: CreateBackupOptions): Promise<BackupManifest> {
  const directory = resolve(options.backupDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const createdAt = options.now ?? new Date();
  let id = `alpha-${stamp(createdAt)}`;
  for (let suffix = 1; existsSync(join(directory, `${id}.json`)) || existsSync(join(directory, `${id}.sqlite.gz`)); suffix += 1) {
    id = `alpha-${stamp(createdAt)}-${suffix}`;
  }
  const rawFile = join(directory, `${id}.sqlite.partial`);
  const databaseFile = join(directory, `${id}.sqlite.gz`);
  const filesArchive = join(directory, `${id}.files.tar.gz`);
  const partials = [rawFile, `${databaseFile}.partial`, `${filesArchive}.partial`];
  try {
    snapshot(options.source, rawFile);
    const { schema_version } = inspectDatabaseFile(rawFile);
    const uncompressed = statSync(rawFile).size;
    await gzipFile(rawFile, `${databaseFile}.partial`);
    rmSync(rawFile, { force: true });
    renameSync(`${databaseFile}.partial`, databaseFile);
    const databaseDigest = await sha256File(databaseFile);
    writeChecksum(databaseFile, databaseDigest);

    let files: BackupManifest['files'] = null;
    let filesSkipped: string | undefined;
    const filesDir = options.filesDir ? resolve(options.filesDir) : null;
    if (filesDir && directoryHasEntries(filesDir)) {
      try {
        await execFileAsync('tar', ['-czf', `${filesArchive}.partial`, '-C', filesDir, '.']);
        renameSync(`${filesArchive}.partial`, filesArchive);
        const digest = await sha256File(filesArchive);
        writeChecksum(filesArchive, digest);
        files = { file: basename(filesArchive), bytes: statSync(filesArchive).size, sha256: digest, source: filesDir };
      } catch (error) {
        rmSync(`${filesArchive}.partial`, { force: true });
        filesSkipped = `Archive des fichiers impossible : ${error instanceof Error ? error.message.slice(0, 200) : 'erreur inconnue'}`;
      }
    } else if (filesDir) {
      filesSkipped = 'Aucun fichier à archiver.';
    }

    const manifest: BackupManifest = {
      id,
      created_at: createdAt.toISOString(),
      app_version: options.appVersion ?? '0.0.0',
      schema_version,
      database: { file: basename(databaseFile), bytes: statSync(databaseFile).size, sha256: databaseDigest, uncompressed_bytes: uncompressed },
      files,
      ...(filesSkipped ? { files_skipped: filesSkipped } : {}),
    };
    writeFileSync(join(directory, `${id}.json.partial`), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    renameSync(join(directory, `${id}.json.partial`), join(directory, `${id}.json`));
    if (options.keep) pruneBackups(directory, options.keep);
    return manifest;
  } catch (error) {
    for (const partial of partials) rmSync(partial, { force: true });
    removeSet(directory, id);
    throw error;
  }
}

/**
 * True when another connection holds the database open (a running Alpha server keeps one in WAL mode).
 * Uses SQLite's own locks: an exclusive-mode transaction cannot start while another connection uses the WAL.
 */
export function databaseInUse(path: string): boolean {
  if (!existsSync(path)) return false;
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path);
    database.exec('PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE;');
    database.exec('BEGIN EXCLUSIVE');
    database.prepare('SELECT COUNT(*) FROM sqlite_master').get();
    database.exec('COMMIT');
    return false;
  } catch (error) {
    if (error instanceof Error && /locked|busy/i.test(error.message)) return true;
    throw error;
  } finally {
    database?.close();
  }
}

export interface RestoreOptions {
  /** `<id>.json` manifest or `<id>.sqlite.gz` archive. */
  archive: string;
  databasePath: string;
  /** Restore uploaded files too (from the manifest's `files` archive) into this directory. */
  filesDir?: string | null;
  /** Skip the "server running" lock check. */
  force?: boolean;
  now?: Date;
}

export interface RestoreResult {
  database: string;
  schema_version: number | null;
  pre_restore_copy: string | null;
  files_restored: boolean;
  pre_restore_files: string | null;
}

function resolveSet(archive: string): { databaseArchive: string; filesArchive: string | null } {
  const path = resolve(archive);
  const directory = dirname(path);
  if (!path.endsWith('.json') && !path.endsWith('.sqlite.gz')) throw new Error('Indiquez un manifeste `<id>.json` ou une archive `<id>.sqlite.gz`.');
  const manifestFile = path.endsWith('.json') ? path : path.replace(/\.sqlite\.gz$/, '.json');
  if (existsSync(manifestFile)) {
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as BackupManifest;
    return {
      databaseArchive: join(directory, basename(manifest.database.file)),
      filesArchive: manifest.files ? join(directory, basename(manifest.files.file)) : null,
    };
  }
  if (!path.endsWith('.sqlite.gz')) throw new Error(`Manifeste introuvable : ${path}`);
  const files = path.replace(/\.sqlite\.gz$/, '.files.tar.gz');
  return { databaseArchive: path, filesArchive: existsSync(files) ? files : null };
}

/** Restores a verified backup set. The previous database (and files) are kept next to the originals. */
export async function restoreBackup(options: RestoreOptions): Promise<RestoreResult> {
  if (options.databasePath === ':memory:') throw new Error('Impossible de restaurer une base en mémoire.');
  const target = resolve(options.databasePath);
  const { databaseArchive, filesArchive } = resolveSet(options.archive);
  await verifyChecksum(databaseArchive);
  const restoreFiles = !!options.filesDir && !!filesArchive;
  if (restoreFiles) await verifyChecksum(filesArchive!);
  if (!options.force && databaseInUse(target)) {
    throw new Error('La base est ouverte par un autre processus (serveur Alpha en cours d’exécution ?). Arrêtez-le avant la restauration ou utilisez --force.');
  }

  const suffix = stamp(options.now ?? new Date());
  mkdirSync(dirname(target), { recursive: true });
  const staged = `${target}.restore-${suffix}`;
  let schema: number | null;
  try {
    await gunzipFile(databaseArchive, staged);
    schema = inspectDatabaseFile(staged).schema_version;
  } catch (error) {
    rmSync(staged, { force: true });
    throw error;
  }

  let preRestoreCopy: string | null = null;
  if (existsSync(target)) {
    preRestoreCopy = `${target}.pre-restore-${suffix}`;
    try {
      snapshot(target, preRestoreCopy);
    } catch {
      // Unreadable/corrupted current database: keep the raw files instead.
      rmSync(preRestoreCopy, { force: true });
      renameSync(target, preRestoreCopy);
      if (existsSync(`${target}-wal`)) renameSync(`${target}-wal`, `${preRestoreCopy}-wal`);
    }
  }
  for (const companion of [target, `${target}-wal`, `${target}-shm`, `${target}-journal`]) rmSync(companion, { force: true });
  renameSync(staged, target);

  let preRestoreFiles: string | null = null;
  if (restoreFiles) {
    const filesDir = resolve(options.filesDir!);
    if (existsSync(filesDir)) {
      preRestoreFiles = `${filesDir}.pre-restore-${suffix}`;
      renameSync(filesDir, preRestoreFiles);
    }
    mkdirSync(filesDir, { recursive: true, mode: 0o700 });
    await execFileAsync('tar', ['-xzf', filesArchive!, '-C', filesDir, '--no-same-owner', '--no-same-permissions']);
  }
  return { database: target, schema_version: schema, pre_restore_copy: preRestoreCopy, files_restored: restoreFiles, pre_restore_files: preRestoreFiles };
}
