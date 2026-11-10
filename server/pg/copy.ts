/**
 * SQLite -> PostgreSQL data export and verification (row counts, ordered md5 checksums, FK validation, objects, sequences).
 * The SQLite side is read through node:sqlite (read-only); the PostgreSQL side through `pg`.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type pg from 'pg';
import { type ColumnPlan, type ConversionResult, type TablePlan, DEFAULT_PG_SCHEMA, assertSchemaName, convertSqliteSchema, renderCheck, renderCreateTable, renderForeignKey } from './convert.js';
import type { PgType } from './translate.js';
import { quoteIdent } from './translate.js';

export type PgClient = pg.ClientBase;

export interface StepError {
  phase: 'check' | 'index' | 'foreign_key' | 'sequence' | 'trigger' | 'view' | 'validate';
  object: string;
  message: string;
}

export interface ExportOptions {
  sqlite: DatabaseSync;
  client: PgClient;
  schema?: string;
  /** Drop the target schema first (otherwise it must be empty or absent). */
  drop?: boolean;
  /** Rows per INSERT statement (capped by the 65535 bind-parameter limit). */
  batchSize?: number;
  rowid?: boolean;
  log?: (message: string) => void;
}

export interface ExportResult {
  conversion: ConversionResult;
  rows: Record<string, number>;
  sequences: { table: string; column: string; next: string }[];
  errors: StepError[];
  durationMs: number;
}

export interface TableVerification {
  table: string;
  sqliteRows: number;
  pgRows: number;
  sqliteChecksum: string;
  pgChecksum: string;
  ok: boolean;
  /** First differing row (key and columns) when checksums differ. */
  mismatch?: string;
}

export interface VerifyReport {
  ok: boolean;
  schema: string;
  tables: TableVerification[];
  foreignKeys: { name: string; table: string; ok: boolean; orphans?: number }[];
  objects: { kind: 'table' | 'check' | 'index' | 'trigger' | 'view'; expected: number; present: number; missing: string[] }[];
  sequences: { table: string; column: string; max: string | null; next: string; ok: boolean }[];
  sourceForeignKeyViolations: number;
  errors: string[];
  durationMs: number;
}

/** Hides the password of a PostgreSQL URL or key=value connection string. */
export function maskConnectionString(connection: string): string {
  let masked = connection;
  if (/^postgres(ql)?:\/\//i.test(connection)) {
    try {
      const url = new URL(connection);
      if (url.password) url.password = '****';
      if (url.searchParams.has('password')) url.searchParams.set('password', '****');
      masked = url.toString();
    } catch {
      masked = connection.replace(/(:\/\/[^:/@]*:)[^@]*@/, '$1****@');
    }
  }
  return masked.replace(/(password\s*=\s*)('(?:[^'\\]|\\.)*'|[^\s&]+)/gi, '$1****');
}

export function openSqliteReadOnly(path: string): DatabaseSync {
  if (!existsSync(path)) throw new Error(`Base SQLite introuvable : ${path}`);
  const db = new DatabaseSync(path, { readOnly: true });
  db.exec('PRAGMA query_only = ON');
  return db;
}

/** Runs `fn` inside one read transaction so the export and the verification see the same SQLite snapshot. */
export async function withSqliteSnapshot<T>(db: DatabaseSync, fn: () => Promise<T>): Promise<T> {
  const inTransaction = (db as unknown as { isTransaction?: boolean }).isTransaction === true;
  if (inTransaction) return fn();
  db.exec('BEGIN');
  try {
    return await fn();
  } finally {
    db.exec('ROLLBACK');
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toPgValue(value: unknown, column: ColumnPlan, table: string): unknown {
  if (value === null || value === undefined) return null;
  if (column.pgType === 'bytea') return value instanceof Uint8Array ? Buffer.from(value.buffer, value.byteOffset, value.byteLength) : Buffer.from(String(value), 'utf8');
  if (value instanceof Uint8Array) throw new Error(`${table}.${column.name} : valeur BLOB dans une colonne ${column.pgType}`);
  if (typeof value === 'bigint' || typeof value === 'number') return String(value);
  return value;
}

/** Canonical text of a SQLite value, identical to {@link canonicalPg} for the same stored value. */
function canonicalSqlite(value: unknown, type: PgType): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('hex');
  switch (type) {
    case 'bytea': return Buffer.from(String(value), 'utf8').toString('hex');
    case 'double precision': return String(Number(value));
    case 'numeric': return canonicalNumeric(String(value));
    default: return String(value);
  }
}

function canonicalPg(value: string | null, type: PgType): string | null {
  if (value === null) return null;
  if (type === 'double precision') return String(Number(value));
  if (type === 'numeric') return canonicalNumeric(value);
  return value;
}

function canonicalNumeric(value: string): string {
  return /^-?\d+$/.test(value) ? BigInt(value).toString() : String(Number(value));
}

function sqliteSequence(db: DatabaseSync, table: string): bigint | undefined {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'").get()) return undefined;
  const statement = db.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?');
  statement.setReadBigInts(true);
  const row = statement.get(table) as { seq: bigint } | undefined;
  return row?.seq;
}

async function copyTable(options: Required<Pick<ExportOptions, 'sqlite' | 'client'>> & { schema: string; batchSize: number }, table: TablePlan): Promise<number> {
  const { sqlite, client, schema } = options;
  const columns = table.columns.filter((column) => !column.generated);
  const statement = sqlite.prepare(`SELECT ${columns.map((column, index) => `${column.source} AS c${index}`).join(', ')} FROM ${quoteIdent(table.name)}`);
  statement.setReadBigInts(true);
  const perStatement = Math.max(1, Math.min(options.batchSize, Math.floor(65535 / columns.length)));
  const head = `INSERT INTO ${quoteIdent(schema)}.${quoteIdent(table.name)} (${columns.map((column) => quoteIdent(column.name)).join(', ')}) VALUES `;
  let batch: unknown[] = [];
  let rows = 0;
  let pending = 0;
  const flush = async () => {
    if (!pending) return;
    const tuples: string[] = [];
    for (let row = 0; row < pending; row += 1) {
      tuples.push(`(${columns.map((_, index) => `$${row * columns.length + index + 1}`).join(', ')})`);
    }
    await client.query(head + tuples.join(', '), batch);
    batch = [];
    pending = 0;
  };
  for (const row of statement.iterate() as Iterable<Record<string, unknown>>) {
    columns.forEach((column, index) => batch.push(toPgValue(row[`c${index}`], column, table.name)));
    pending += 1;
    rows += 1;
    if (pending >= perStatement) await flush();
  }
  await flush();
  return rows;
}

export async function exportToPostgres(options: ExportOptions): Promise<ExportResult> {
  const started = Date.now();
  const schema = options.schema ?? DEFAULT_PG_SCHEMA;
  assertSchemaName(schema);
  const { sqlite, client } = options;
  const log = options.log ?? (() => undefined);
  const s = quoteIdent(schema);
  const conversion = convertSqliteSchema(sqlite, { schema, rowid: options.rowid });
  const errors: StepError[] = [];
  const rows: Record<string, number> = {};
  const sequences: ExportResult['sequences'] = [];

  const soft = async (phase: StepError['phase'], object: string, statements: string[]) => {
    await client.query('SAVEPOINT alpha_export_step');
    try {
      for (const sql of statements) await client.query(sql);
      await client.query('RELEASE SAVEPOINT alpha_export_step');
      return true;
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT alpha_export_step');
      errors.push({ phase, object, message: errorMessage(error) });
      return false;
    }
  };

  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL client_min_messages = 'warning'");
    await client.query('SET LOCAL standard_conforming_strings = on');
    const existing = await client.query<{ present: boolean; objects: string }>(
      `SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1) AS present,
        (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1)
        + (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1) AS objects`, [schema]);
    if (existing.rows[0].present) {
      if (options.drop) {
        log(`Suppression du schéma ${s}…`);
        await client.query(`DROP SCHEMA ${s} CASCADE`);
      } else if (Number(existing.rows[0].objects) > 0) {
        throw new Error(`Le schéma PostgreSQL ${s} existe déjà et n’est pas vide : relancer avec --drop pour le remplacer.`);
      }
    }
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${s}`);
    await client.query(`SET LOCAL search_path TO ${s}, public`);
    for (const helper of conversion.helpers) await client.query(helper.sql);
    for (const table of conversion.tables) await client.query(renderCreateTable(table, schema, { inlineChecks: false }));
    log(`${conversion.tables.length} tables créées, copie des lignes…`);

    for (const table of conversion.tables) {
      try {
        rows[table.name] = await copyTable({ sqlite, client, schema, batchSize: options.batchSize ?? 1000 }, table);
      } catch (error) {
        throw new Error(`Copie de la table ${table.name} : ${errorMessage(error)}`);
      }
      log(`  ${table.name} : ${rows[table.name]} ligne(s)`);
    }

    // Constraints and indexes are created after the load: faster, and they double as a check of the translated semantics.
    for (const table of conversion.tables) {
      for (const check of table.checks) await soft('check', `${table.name}.${check.name}`, [renderCheck(table, check, schema)]);
    }
    for (const index of conversion.indexes) await soft('index', index.name, [index.sql]);
    for (const fk of conversion.foreignKeys) await soft('foreign_key', `${fk.table}.${fk.name}`, [renderForeignKey(fk, schema, { notValid: true })]);
    for (const table of conversion.tables) {
      for (const column of table.columns.filter((item) => item.identity)) {
        const statement = sqlite.prepare(`SELECT max(${column.source}) AS value FROM ${quoteIdent(table.name)}`);
        statement.setReadBigInts(true);
        const max = (statement.get() as { value: bigint | null }).value ?? 0n;
        const seq = !column.rowid ? sqliteSequence(sqlite, table.name) ?? 0n : 0n;
        let next = (max > seq ? max : seq) + 1n;
        if (next < 1n) next = 1n;
        const ok = await soft('sequence', `${table.name}.${column.name}`, [
          `SELECT setval(pg_get_serial_sequence('${`${s}.${quoteIdent(table.name)}`.replace(/'/g, "''")}', '${column.name.replace(/'/g, "''")}'), ${next}, false)`,
        ]);
        if (ok) sequences.push({ table: table.name, column: column.name, next: next.toString() });
      }
    }
    // Triggers come last so they never fire during the load.
    for (const trigger of conversion.triggers) await soft('trigger', trigger.name, [trigger.functionSql, ...trigger.sql]);
    let pendingViews = [...conversion.views];
    for (let pass = 0; pendingViews.length && pass < conversion.views.length; pass += 1) {
      const failed: typeof pendingViews = [];
      for (const view of pendingViews) {
        const before = errors.length;
        if (!(await soft('view', view.name, [view.sql]))) {
          errors.splice(before);
          failed.push(view);
        }
      }
      if (failed.length === pendingViews.length) break;
      pendingViews = failed;
    }
    for (const view of pendingViews) await soft('view', view.name, [view.sql]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }

  log(`Validation de ${conversion.foreignKeys.length} clés étrangères…`);
  for (const fk of conversion.foreignKeys) {
    if (errors.some((error) => error.phase === 'foreign_key' && error.object === `${fk.table}.${fk.name}`)) continue;
    try {
      await client.query(`ALTER TABLE ${s}.${quoteIdent(fk.table)} VALIDATE CONSTRAINT ${quoteIdent(fk.name)}`);
    } catch (error) {
      errors.push({ phase: 'validate', object: `${fk.table}.${fk.name}`, message: errorMessage(error) });
    }
  }
  return { conversion, rows, sequences, errors, durationMs: Date.now() - started };
}

function pgSelectExpression(column: ColumnPlan): string {
  const name = `t.${quoteIdent(column.name)}`;
  return column.pgType === 'bytea' ? `encode(${name}, 'hex')` : `${name}::text`;
}

async function compareTable(sqlite: DatabaseSync, client: PgClient, schema: string, table: TablePlan): Promise<TableVerification> {
  const columns = table.columns;
  const types = columns.map((column) => column.pgType);
  const byName = new Map(columns.map((column) => [column.name, column]));
  const order = table.orderBy.map((name) => byName.get(name)!);
  // Columns are qualified so that ORDER BY never resolves to an output alias.
  const sqliteSql = `SELECT ${columns.map((column, index) => `t.${column.source} AS c${index}`).join(', ')} FROM ${quoteIdent(table.name)} AS t `
    + `ORDER BY ${order.map((column) => `t.${column.source} COLLATE BINARY`).join(', ')}`;
  const pgSql = `SELECT ${columns.map((column, index) => `${pgSelectExpression(column)} AS c${index}`).join(', ')} FROM ${quoteIdent(schema)}.${quoteIdent(table.name)} AS t `
    + `ORDER BY ${order.map((column) => `t.${quoteIdent(column.name)}${column.pgType === 'text' ? ' COLLATE "C"' : ''} NULLS FIRST`).join(', ')}`;
  const statement = sqlite.prepare(sqliteSql);
  statement.setReadBigInts(true);
  const iterator = (statement.iterate() as IterableIterator<Record<string, unknown>>)[Symbol.iterator]();
  const sqliteHash = createHash('md5');
  const pgHash = createHash('md5');
  let sqliteRows = 0;
  let pgRows = 0;
  let mismatch: string | undefined;
  const keyOf = (row: (string | null)[]) => table.orderBy.map((name) => `${name}=${JSON.stringify(row[columns.findIndex((column) => column.name === name)])}`).join(', ');
  const nextSqlite = (): (string | null)[] | undefined => {
    const next = iterator.next();
    if (next.done) return undefined;
    sqliteRows += 1;
    const row = columns.map((_, index) => canonicalSqlite(next.value[`c${index}`], types[index]));
    sqliteHash.update(`${JSON.stringify(row)}\n`);
    return row;
  };
  await client.query(`DECLARE alpha_verify NO SCROLL CURSOR FOR ${pgSql}`);
  try {
    for (;;) {
      const batch = await client.query<unknown[]>({ text: 'FETCH FORWARD 2000 FROM alpha_verify', rowMode: 'array' });
      for (const raw of batch.rows) {
        pgRows += 1;
        const pgRow = (raw as (string | null)[]).map((value, index) => canonicalPg(value, types[index]));
        pgHash.update(`${JSON.stringify(pgRow)}\n`);
        const sqliteRow = nextSqlite();
        if (!mismatch && (!sqliteRow || JSON.stringify(sqliteRow) !== JSON.stringify(pgRow))) {
          if (!sqliteRow) mismatch = `ligne en trop dans PostgreSQL (${keyOf(pgRow)})`;
          else {
            const differing = columns.filter((_, index) => sqliteRow[index] !== pgRow[index]).map((column) => column.name);
            mismatch = `première différence à ${keyOf(sqliteRow)} (colonnes ${differing.join(', ')})`;
          }
        }
      }
      if (batch.rows.length < 2000) break;
    }
  } finally {
    await client.query('CLOSE alpha_verify').catch(() => undefined);
  }
  for (let extra = nextSqlite(); extra; extra = nextSqlite()) {
    if (!mismatch) mismatch = `ligne absente de PostgreSQL (${keyOf(extra)})`;
  }
  const sqliteChecksum = sqliteHash.digest('hex');
  const pgChecksum = pgHash.digest('hex');
  return { table: table.name, sqliteRows, pgRows, sqliteChecksum, pgChecksum, ok: sqliteRows === pgRows && sqliteChecksum === pgChecksum, mismatch };
}

export interface VerifyOptions {
  sqlite: DatabaseSync;
  client: PgClient;
  schema?: string;
  rowid?: boolean;
  /** Reuse the conversion of a previous export (same snapshot). */
  conversion?: ConversionResult;
}

export async function verifyExport(options: VerifyOptions): Promise<VerifyReport> {
  const started = Date.now();
  const schema = options.schema ?? options.conversion?.schema ?? DEFAULT_PG_SCHEMA;
  assertSchemaName(schema);
  const { sqlite, client } = options;
  const conversion = options.conversion ?? convertSqliteSchema(sqlite, { schema, rowid: options.rowid });
  const s = quoteIdent(schema);
  const errors: string[] = [];
  const report: VerifyReport = { ok: false, schema, tables: [], foreignKeys: [], objects: [], sequences: [], sourceForeignKeyViolations: 0, errors, durationMs: 0 };

  report.sourceForeignKeyViolations = (sqlite.prepare('SELECT count(*) AS n FROM pragma_foreign_key_check').get() as { n: number }).n;

  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query('SET LOCAL extra_float_digits = 3');
    const present = await client.query<{ relname: string; relkind: string }>(
      "SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'i')", [schema]);
    const relations = new Set(present.rows.map((row) => `${row.relkind}:${row.relname}`));
    const constraints = await client.query<{ relname: string; conname: string; contype: string; convalidated: boolean }>(
      `SELECT c.relname, con.conname, con.contype, con.convalidated FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1`, [schema]);
    const constraintMap = new Map(constraints.rows.map((row) => [`${row.relname}:${row.conname}`, row]));
    const triggerRows = await client.query<{ relname: string; tgname: string }>(
      `SELECT c.relname, t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND NOT t.tgisinternal`, [schema]);
    const triggerSet = new Set(triggerRows.rows.map((row) => `${row.relname}:${row.tgname}`));

    const objectCheck = (kind: VerifyReport['objects'][number]['kind'], names: string[], has: (name: string) => boolean) => {
      const missing = names.filter((name) => !has(name));
      report.objects.push({ kind, expected: names.length, present: names.length - missing.length, missing });
      missing.forEach((name) => errors.push(`${kind} manquant(e) dans PostgreSQL : ${name}`));
    };
    const missingTables = conversion.tables.filter((table) => !relations.has(`r:${table.name}`) && !relations.has(`p:${table.name}`)).map((table) => table.name);
    objectCheck('table', conversion.tables.map((table) => table.name), (name) => !missingTables.includes(name));
    objectCheck('check', conversion.tables.flatMap((table) => table.checks.map((check) => `${table.name}.${check.name}`)), (name) => {
      const [table, check] = [name.slice(0, name.indexOf('.')), name.slice(name.indexOf('.') + 1)];
      return constraintMap.get(`${table}:${check}`)?.contype === 'c';
    });
    objectCheck('index', conversion.indexes.map((index) => index.name), (name) => relations.has(`i:${name}`));
    objectCheck('trigger', conversion.triggers.flatMap((trigger) => trigger.triggerNames.map((name) => `${trigger.table}.${name}`)),
      (name) => triggerSet.has(`${name.slice(0, name.indexOf('.'))}:${name.slice(name.indexOf('.') + 1)}`));
    objectCheck('view', conversion.views.map((view) => view.name), (name) => relations.has(`v:${name}`));

    for (const fk of conversion.foreignKeys) {
      const row = constraintMap.get(`${fk.table}:${fk.name}`);
      if (row?.contype === 'f' && row.convalidated) {
        report.foreignKeys.push({ name: fk.name, table: fk.table, ok: true });
        continue;
      }
      let orphans: number | undefined;
      if (!missingTables.includes(fk.table) && !missingTables.includes(fk.refTable)) {
        const child = fk.columns.map((column) => `c.${quoteIdent(column)}`);
        const result = await client.query<{ n: string }>(`SELECT count(*) AS n FROM ${s}.${quoteIdent(fk.table)} c WHERE ${child.map((column) => `${column} IS NOT NULL`).join(' AND ')}
          AND NOT EXISTS (SELECT 1 FROM ${s}.${quoteIdent(fk.refTable)} p WHERE ${fk.refColumns.map((column, index) => `p.${quoteIdent(column)} = ${child[index]}`).join(' AND ')})`);
        orphans = Number(result.rows[0].n);
      }
      report.foreignKeys.push({ name: fk.name, table: fk.table, ok: false, orphans });
      errors.push(`clé étrangère ${fk.table}.${fk.name} ${row ? 'non validée' : 'absente'}${orphans !== undefined ? ` (${orphans} ligne(s) orpheline(s))` : ''}`);
    }

    for (const table of conversion.tables) {
      if (missingTables.includes(table.name)) continue;
      try {
        const result = await compareTable(sqlite, client, schema, table);
        report.tables.push(result);
        if (!result.ok) errors.push(`table ${table.name} : ${result.sqliteRows} ligne(s) SQLite / ${result.pgRows} PostgreSQL, ${result.mismatch ?? 'sommes de contrôle différentes'}`);
      } catch (error) {
        errors.push(`table ${table.name} : vérification impossible (${errorMessage(error)})`);
        await client.query('ROLLBACK');
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await client.query('SET LOCAL extra_float_digits = 3');
      }
    }

    for (const table of conversion.tables) {
      if (missingTables.includes(table.name)) continue;
      for (const column of table.columns.filter((item) => item.identity)) {
        const target = [`${s}.${quoteIdent(table.name)}`, column.name];
        const { seq } = (await client.query<{ seq: string | null }>('SELECT pg_get_serial_sequence($1, $2) AS seq', target)).rows[0];
        const { max } = (await client.query<{ max: string | null }>(`SELECT max(${quoteIdent(column.name)})::text AS max FROM ${s}.${quoteIdent(table.name)}`)).rows[0];
        let nextValue = '?';
        if (seq) {
          const state = (await client.query<{ last_value: string; is_called: boolean }>(`SELECT last_value::text AS last_value, is_called FROM ${seq}`)).rows[0];
          nextValue = state.is_called ? (BigInt(state.last_value) + 1n).toString() : state.last_value;
        }
        const ok = !!seq && (max === null || BigInt(nextValue) > BigInt(max));
        report.sequences.push({ table: table.name, column: column.name, max, next: nextValue, ok });
        if (!ok) errors.push(`séquence ${table.name}.${column.name} : prochaine valeur ${nextValue} ≤ max ${max}`);
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
  report.ok = errors.length === 0;
  report.durationMs = Date.now() - started;
  return report;
}

const pad = (value: string, width: number) => (value.length >= width ? value : value + ' '.repeat(width - value.length));
const count = (value: number) => value.toLocaleString('fr-FR');

export interface ReportContext {
  source: string;
  target?: string;
  exported?: ExportResult;
  verified?: VerifyReport;
  conversion?: ConversionResult;
}

/** Human-readable French report (never contains the connection password: pass a masked target). */
export function formatReport(context: ReportContext): string {
  const lines: string[] = [];
  const conversion = context.exported?.conversion ?? context.conversion;
  const schema = conversion?.schema ?? context.verified?.schema ?? DEFAULT_PG_SCHEMA;
  lines.push(`Export SQLite → PostgreSQL (schéma "${schema}")`);
  lines.push(`  Source : ${context.source}${conversion ? ` (SQLite ${conversion.sqliteVersion})` : ''}`);
  if (context.target) lines.push(`  Cible  : ${context.target}`);
  if (conversion) {
    lines.push(`  Schéma : ${conversion.tables.length} tables, ${conversion.tables.reduce((sum, table) => sum + table.checks.length, 0)} CHECK, `
      + `${conversion.indexes.length} index, ${conversion.foreignKeys.length} clés étrangères, ${conversion.triggers.length} déclencheurs, ${conversion.views.length} vues`);
  }
  if (context.exported) {
    const total = Object.values(context.exported.rows).reduce((sum, value) => sum + value, 0);
    lines.push(`  Copie  : ${count(total)} ligne(s) en ${(context.exported.durationMs / 1000).toFixed(1)} s, ${context.exported.sequences.length} séquence(s) repositionnée(s)`);
  }
  const verified = context.verified;
  if (verified) {
    lines.push('', `Vérification (${(verified.durationMs / 1000).toFixed(1)} s) :`);
    // Empty tables that match are summarised on one line to keep the report readable.
    const emptyOk = verified.tables.filter((table) => table.ok && table.sqliteRows === 0);
    const listed = verified.tables.filter((table) => !emptyOk.includes(table));
    const width = Math.max(10, ...listed.map((table) => table.table.length));
    for (const table of listed) {
      lines.push(`  ${table.ok ? '✔' : '✘'} ${pad(table.table, width)} ${pad(count(table.sqliteRows), 9)} ligne(s)  md5 ${table.ok ? table.pgChecksum.slice(0, 12)
        : `SQLite ${table.sqliteChecksum.slice(0, 12)} ≠ PG ${table.pgChecksum.slice(0, 12)} (${count(table.pgRows)} ligne(s))`}`);
      if (table.mismatch) lines.push(`      ${table.mismatch}`);
    }
    if (emptyOk.length) lines.push(`  ✔ ${emptyOk.length} table(s) vide(s) des deux côtés`);
    const validated = verified.foreignKeys.filter((fk) => fk.ok).length;
    lines.push(`  Clés étrangères validées : ${validated}/${verified.foreignKeys.length}`);
    const labels: Record<VerifyReport['objects'][number]['kind'], string> = { table: 'tables', check: 'CHECK', index: 'index', trigger: 'déclencheurs', view: 'vues' };
    lines.push(`  Objets présents : ${verified.objects.map((object) => `${labels[object.kind]} ${object.present}/${object.expected}`).join(', ')}`);
    for (const object of verified.objects.filter((item) => item.missing.length)) lines.push(`    ✘ ${labels[object.kind]} manquants : ${object.missing.join(', ')}`);
    const sequencesOk = verified.sequences.filter((sequence) => sequence.ok).length;
    lines.push(`  Séquences d’identité en avance sur max(id) : ${sequencesOk}/${verified.sequences.length}`);
    if (verified.sourceForeignKeyViolations) lines.push(`  ⚠ PRAGMA foreign_key_check signale ${verified.sourceForeignKeyViolations} violation(s) dans la base SQLite source`);
  }
  const exportErrors = context.exported?.errors ?? [];
  if (exportErrors.length) {
    lines.push('', `Erreurs d’export (${exportErrors.length}) :`);
    for (const error of exportErrors) lines.push(`  - [${error.phase}] ${error.object} : ${error.message}`);
  }
  if (verified?.errors.length) {
    lines.push('', `Écarts (${verified.errors.length}) :`);
    for (const error of verified.errors) lines.push(`  - ${error}`);
  }
  if (conversion?.warnings.length) {
    lines.push('', `Avertissements du convertisseur (${conversion.warnings.length}) :`);
    for (const warning of conversion.warnings) lines.push(`  - ${warning}`);
  }
  const ok = !exportErrors.length && (verified ? verified.ok : true);
  lines.push('', ok ? 'Résultat : OK — données identiques et contraintes valides.' : 'Résultat : ÉCHEC');
  return lines.join('\n');
}
