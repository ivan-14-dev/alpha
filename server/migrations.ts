import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

const migrations = [
  { version: 2, name: 'network', file: new URL('./migrations/002-network.sql', import.meta.url) },
  { version: 3, name: 'professional', file: new URL('./migrations/003-professional.sql', import.meta.url) },
];

export function migrate(database: DatabaseSync) {
  database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);
  database.exec('BEGIN IMMEDIATE');
  try {
    const applied = database.prepare('SELECT version,name,checksum FROM schema_migrations ORDER BY version').all();
    for (const migration of applied) {
      if (!migrations.some((known) => known.version === migration.version)) {
        throw new Error(`Version de base inconnue : ${migration.version}. Utilisez une version compatible de l'application.`);
      }
    }
    for (const migration of migrations) {
      const sql = readFileSync(migration.file, 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = applied.find((item) => item.version === migration.version);
      if (existing) {
        if (existing.name !== migration.name || existing.checksum !== checksum) {
          throw new Error(`La migration ${migration.version} a ete modifiee apres son application. Creez une nouvelle migration.`);
        }
        continue;
      }
      database.exec(sql);
      database.prepare('INSERT INTO schema_migrations(version,name,checksum) VALUES (?,?,?)').run(migration.version, migration.name, checksum);
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
