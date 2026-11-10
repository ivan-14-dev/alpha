/**
 * SQLite -> PostgreSQL export with verification.
 *   npm run db:export:postgres -- --sqlite data/alpha.sqlite --pg postgres://user@host/db [--schema alpha] [--drop] [--batch 1000]
 *   npm run db:export:postgres -- --ddl-only alpha.sql            (DDL only, no PostgreSQL needed; "-" = stdout)
 *   npm run db:export:postgres -- --verify-only --pg ...           (re-check an existing export)
 * The connection string can come from ALPHA_PG_URL (recommended: keeps the password out of `ps`).
 * Exit codes: 0 OK, 1 export errors or verification mismatch, 2 usage / connection / fatal error.
 */
import '../server/config.js';
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { DEFAULT_PG_SCHEMA, assertSchemaName, convertSqliteSchema } from '../server/pg/convert.js';
import { type ExportResult, type VerifyReport, exportToPostgres, formatReport, maskConnectionString, openSqliteReadOnly, verifyExport, withSqliteSnapshot } from '../server/pg/copy.js';

const usage = `Usage : npm run db:export:postgres -- [options]
  --sqlite <chemin>    base SQLite source, ouverte en lecture seule (défaut : $DATABASE_PATH ou data/alpha.sqlite)
  --pg <url>           PostgreSQL cible (défaut : $ALPHA_PG_URL)
  --schema <nom>       schéma cible (défaut : ${DEFAULT_PG_SCHEMA})
  --drop               supprime puis recrée le schéma cible s’il existe
  --batch <n>          lignes par INSERT (défaut : 1000)
  --ddl-only <fichier> écrit seulement le DDL PostgreSQL (« - » = sortie standard), sans connexion
  --verify-only        compare une exportation existante sans rien écrire
  --no-rowid           n’exporte pas le rowid implicite des tables sans INTEGER PRIMARY KEY
  --report <fichier>   écrit aussi le rapport au format JSON
  -h, --help           affiche cette aide`;

function fail(message: string, code = 2): never {
  console.error(message);
  process.exit(code);
}

async function main(): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        sqlite: { type: 'string' },
        pg: { type: 'string' },
        schema: { type: 'string', default: DEFAULT_PG_SCHEMA },
        drop: { type: 'boolean', default: false },
        batch: { type: 'string', default: '1000' },
        'ddl-only': { type: 'string' },
        'verify-only': { type: 'boolean', default: false },
        'no-rowid': { type: 'boolean', default: false },
        report: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: false,
    });
  } catch (error) {
    fail(`${(error as Error).message}\n\n${usage}`);
  }
  const options = parsed.values;
  if (options.help) {
    console.log(usage);
    return 0;
  }
  const schema = options.schema!;
  try {
    assertSchemaName(schema);
  } catch (error) {
    fail((error as Error).message);
  }
  const batchSize = Number(options.batch);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100_000) fail('--batch doit être un entier entre 1 et 100000.');
  if (options.drop && options['verify-only']) fail('--drop et --verify-only sont incompatibles.');
  const sqlitePath = options.sqlite ?? process.env.DATABASE_PATH ?? 'data/alpha.sqlite';
  const rowid = !options['no-rowid'];

  let sqlite;
  try {
    sqlite = openSqliteReadOnly(sqlitePath);
  } catch (error) {
    fail((error as Error).message);
  }

  if (options['ddl-only'] !== undefined) {
    const conversion = convertSqliteSchema(sqlite, { schema, rowid });
    if (options['ddl-only'] === '-') process.stdout.write(conversion.ddl);
    else {
      writeFileSync(options['ddl-only'], conversion.ddl);
      console.error(`DDL écrit dans ${options['ddl-only']} : ${conversion.tables.length} tables, ${conversion.indexes.length} index, `
        + `${conversion.foreignKeys.length} clés étrangères, ${conversion.triggers.length} déclencheurs, ${conversion.views.length} vues.`);
    }
    if (conversion.warnings.length) console.error(`${conversion.warnings.length} avertissement(s) :\n${conversion.warnings.map((line) => `  - ${line}`).join('\n')}`);
    sqlite.close();
    return 0;
  }

  const connectionString = options.pg ?? process.env.ALPHA_PG_URL;
  if (!connectionString) fail(`Connexion PostgreSQL manquante : --pg <url> ou ALPHA_PG_URL.\n\n${usage}`);
  const target = maskConnectionString(connectionString);
  const client = new pg.Client({ connectionString, application_name: 'alpha-export-postgres' });
  try {
    await client.connect();
  } catch (error) {
    fail(`Connexion à ${target} impossible : ${maskConnectionString((error as Error).message)}`);
  }

  let exported: ExportResult | undefined;
  let verified: VerifyReport | undefined;
  try {
    await withSqliteSnapshot(sqlite, async () => {
      if (!options['verify-only']) {
        exported = await exportToPostgres({ sqlite, client, schema, drop: options.drop, batchSize, rowid, log: (line) => console.error(line) });
      }
      verified = await verifyExport({ sqlite, client, schema, rowid, conversion: exported?.conversion });
    });
  } catch (error) {
    console.error(`Échec : ${maskConnectionString((error as Error).message)}`);
    await client.end().catch(() => undefined);
    sqlite.close();
    return 2;
  }
  await client.end();
  sqlite.close();

  const conversion = exported?.conversion;
  console.log(formatReport({ source: sqlitePath, target, exported, verified, conversion }));
  if (options.report) {
    writeFileSync(options.report, `${JSON.stringify({
      source: sqlitePath,
      target,
      schema,
      ok: !exported?.errors.length && !!verified?.ok,
      rows: exported?.rows,
      exportErrors: exported?.errors ?? [],
      sequences: exported?.sequences ?? [],
      verification: verified,
      warnings: conversion?.warnings ?? [],
      unsupported: conversion?.unsupported ?? [],
    }, null, 2)}\n`);
  }
  return !exported?.errors.length && verified?.ok ? 0 : 1;
}

main().then((code) => process.exit(code), (error: unknown) => {
  console.error(maskConnectionString(error instanceof Error ? error.stack ?? error.message : String(error)));
  process.exit(2);
});
