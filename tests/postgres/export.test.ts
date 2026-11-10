import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import { migrate } from '../../server/migrations.js';
import { convertSqliteSchema } from '../../server/pg/convert.js';
import { exportToPostgres, openSqliteReadOnly, verifyExport, withSqliteSnapshot } from '../../server/pg/copy.js';

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const BIG = 9007199254740993n; // 2^53 + 1: lost if any layer goes through a JS number.
const suffix = randomBytes(4).toString('hex');
const workDir = join('data', `pg-test-${suffix}`);
const externalUrl = process.env.ALPHA_PG_URL;
const dockerAvailable = !externalUrl && spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 20_000 }).status === 0;
const skip = externalUrl || dockerAvailable ? false : 'PostgreSQL indisponible : définir ALPHA_PG_URL ou démarrer Docker';

let connectionString = '';
let password = '';
let container: string | undefined;
const clients: pg.Client[] = [];
const createdSchemas = new Set<string>();

function docker(...args: string[]): string {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 300_000 });
  if (result.status !== 0) throw new Error(`docker ${args[0]} : ${result.stderr || result.error?.message}`);
  return result.stdout.trim();
}

async function connect(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString, application_name: 'alpha-export-test' });
  await client.connect();
  clients.push(client);
  return client;
}

function schemaName(base: string): string {
  const name = `${base}_${suffix}`;
  createdSchemas.add(name);
  return name;
}

async function startPostgres(): Promise<void> {
  if (externalUrl) {
    connectionString = externalUrl;
    password = (() => { try { return decodeURIComponent(new URL(externalUrl).password); } catch { return ''; } })();
    return;
  }
  password = randomBytes(16).toString('hex');
  container = docker('run', '-d', '--rm', '--name', `alpha-pgtest-${suffix}`, '-e', `POSTGRES_PASSWORD=${password}`,
    '-p', '127.0.0.1::5432', '--tmpfs', '/var/lib/postgresql/data', 'postgres:16-alpine');
  const port = docker('port', container, '5432/tcp').split('\n').find((line) => line.startsWith('127.0.0.1:'))!.split(':').pop();
  connectionString = `postgres://postgres:${password}@127.0.0.1:${port}/postgres`;
  const deadline = Date.now() + 90_000;
  for (;;) {
    const client = new pg.Client({ connectionString });
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      return;
    } catch (error) {
      await client.end().catch(() => undefined);
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

/** Alpha database built by the real demo seed (through the application modules) plus direct inserts covering every risky type. */
function buildAlphaDatabase(file: string): { seeded: boolean } {
  const environment: NodeJS.ProcessEnv = { ...process.env, DATABASE_PATH: file };
  delete environment.DEMO_PASSWORD;
  const seed = spawnSync(process.execPath, ['--import', 'tsx', 'server/seed.ts'], { env: environment, encoding: 'utf8', timeout: 120_000 });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  if (seed.status !== 0) {
    // The seed belongs to another module: its failure must not hide export regressions.
    db.exec(readFileSync('server/schema.sql', 'utf8'));
    migrate(db);
  }
  const run = (sql: string, ...params: (string | number | bigint | null | Uint8Array)[]) => db.prepare(sql).run(...params);
  db.exec('BEGIN');
  // Identifiers whose byte order differs from linguistic order (checksums are computed in PK order on both sides).
  const users = ['A-user', 'a-user', 'Z-user', '_user', 'é-user'];
  users.forEach((id, index) => run(`INSERT INTO users (id, name, email, password_hash, title, bio, skills, role) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id, index === 0 ? `Zoé "Ζήτα" O'Brien 🚀` : `Utilisateur ${index}`, `${id.replace(/[^a-z]/gi, '') || 'x'}${index}@export.test`, 'scrypt$hash',
    'Ingénieure\tQA', index === 0 ? 'ligne 1\nligne 2\r\n\\ fin — « guillemets » ' : '', '["sql","postgres"]', index === 1 ? 'admin' : 'member'));
  run(`INSERT INTO projects (id, owner_id, title, summary, category, tags) VALUES ('pg-project', 'A-user', 'Projet export', 'Résumé', 'Outils', '["pg"]')`);
  run(`INSERT INTO campaigns (id, project_id, owner_id, title, description, reward_cents, slots, deadline, payment_mode)
    VALUES ('pg-campaign', 'pg-project', 'A-user', 'Campagne', 'Tester l’export', 1500, 3, '2030-01-01', 'sandbox')`);
  run(`INSERT INTO applications (id, campaign_id, tester_id, motivation, status) VALUES ('pg-application', 'pg-campaign', 'a-user', 'Motivé', 'accepted')`);
  run(`INSERT INTO missions (id, campaign_id, tester_id, application_id, status) VALUES ('pg-mission', 'pg-campaign', 'a-user', 'pg-application', 'paid')`);
  run(`INSERT INTO transactions (id, user_id, campaign_id, mission_id, kind, amount_cents) VALUES ('pg-payout', 'a-user', 'pg-campaign', 'pg-mission', 'payout', 1500)`);
  run(`INSERT INTO conversations (id, subject, created_by) VALUES ('pg-conversation', 'Sujet ✉', 'A-user')`);
  run(`INSERT INTO conversation_members (conversation_id, user_id) VALUES ('pg-conversation', 'A-user'), ('pg-conversation', 'a-user')`);
  run(`INSERT INTO messages (id, conversation_id, sender_id, body) VALUES ('pg-message-1', 'pg-conversation', 'A-user', ?)`, `Bonjour 👋\n'quote' "double" \\ %_ <b>`);
  run(`INSERT INTO messages (id, conversation_id, sender_id, body, created_at) VALUES ('pg-message-2', 'pg-conversation', 'a-user', '', '2024-02-29T23:59:59.999Z')`);
  run(`INSERT INTO notifications (id, user_id, kind, title) VALUES ('pg-notification', 'a-user', 'message', 'Nouveau message')`);
  run(`INSERT INTO sessions (token_hash, user_id, expires_at, public_id, created_at) VALUES ('pg-token', 'A-user', '2030-01-01T00:00:00.000Z', NULL, NULL)`);
  run(`INSERT INTO platform_settings (key, value, secret, updated_by) VALUES ('payments.mode', '{"mode":"sandbox","rates":[1,2.5,-3e-2],"ok":true}', NULL, 'a-user')`);
  run(`INSERT INTO payment_intents (id, user_id, purpose, ref_type, ref_id, mode, provider, amount_base_minor, base_currency, amount_minor, currency, fx_rate,
    idempotency_key, expires_at, status) VALUES (?, 'A-user', 'campaign_funding', 'campaign', 'pg-campaign', 'sandbox', 'sandbox', 1000, 'EUR', ?, 'XAF', ?, ?, '2030-01-01T00:00:00.000Z', 'succeeded')`,
  'pg-intent-1', 655957, 655.957, 'intent-key-0001');
  run(`INSERT INTO payment_intents (id, user_id, purpose, ref_type, ref_id, mode, provider, amount_base_minor, base_currency, amount_minor, currency, fx_rate,
    idempotency_key, expires_at) VALUES (?, 'A-user', 'campaign_funding', 'campaign', 'pg-campaign', 'sandbox', 'sandbox', 10, 'EUR', 1, 'USD', ?, ?, '2030-01-01T00:00:00.000Z')`,
  'pg-intent-2', 0.1, 'intent-key-0002');
  run(`INSERT INTO ledger_journals (id, idempotency_key, kind, mode, currency, ref_type, ref_id, memo, created_by)
    VALUES ('pg-journal', 'journal-key-0001', 'payment', 'sandbox', 'XAF', 'payment_intent', 'pg-intent-1', 'Écriture ✓', 'A-user')`);
  run(`INSERT INTO ledger_entries (id, journal_id, account, amount_minor, currency, mode) VALUES ('pg-entry-1', 'pg-journal', 'cash', ?, 'XAF', 'sandbox')`, BIG);
  run(`INSERT INTO ledger_entries (id, journal_id, account, amount_minor, currency, mode) VALUES ('pg-entry-2', 'pg-journal', 'payable', ?, 'XAF', 'sandbox')`, -BIG);
  run(`INSERT INTO invoice_counters (series, year, last_number) VALUES ('sandbox', 2026, 1)`);
  run(`INSERT INTO invoices (id, number, series, year, sequence, user_id, kind, journal_id, ref_type, ref_id, currency, amount_net_minor, amount_tax_minor,
    amount_gross_minor, tax_rate_bps, description, lines, issuer_snapshot, customer_snapshot, issued_at)
    VALUES ('pg-invoice', 'SBX-2026-000001', 'sandbox', 2026, 1, 'A-user', 'receipt', 'pg-journal', 'payment_intent', 'pg-intent-1', 'XAF', 1000, 192, 1192, 1925,
    'Reçu', '[{"label":"Test","amount":1000}]', '{"name":"Alpha"}', '{"name":"Zoé"}', '2026-01-02T03:04:05.678Z')`);
  run(`INSERT INTO consent_events (id, user_id, purpose, granted, policy_version, source) VALUES ('pg-consent', 'a-user', 'analytics', 1, '2026-01', 'settings')`);
  run(`INSERT INTO files (id, owner_id, purpose, original_name, mime_type, size_bytes, sha256, storage_key)
    VALUES ('pg-file', 'A-user', 'attachment', 'été 2026.png', 'image/png', 12, ?, 'objects/pg-file')`, 'ab'.repeat(32));
  run(`INSERT INTO sandbox_runs (id, requester_id, campaign_id, profile_id, image, command, limits, status, exit_code, started_at, finished_at, duration_ms, container_name)
    VALUES ('pg-run', 'A-user', 'pg-campaign', 'node', 'node:22-alpine', '["node","-e","1"]', '{"cpus":1,"memoryMb":256}', 'succeeded', 0,
    '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.200Z', 1200, 'alpha-sbx-pg-run')`);
  run(`INSERT INTO sanctions (id, user_id, kind, capabilities, public_reason, created_by) VALUES ('pg-sanction', 'a-user', 'restriction', '["post"]', 'Raison publique détaillée', 'A-user')`);
  run(`INSERT INTO appeals (id, sanction_id, user_id, statement, status, reviewer_id, decision_note, decided_at)
    VALUES ('pg-appeal-1', 'pg-sanction', 'a-user', ?, 'rejected', 'A-user', 'Rejeté', '2026-01-03T00:00:00.000Z')`, 'Je conteste cette décision pour les raisons suivantes.');
  db.exec('COMMIT');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  db.close();
  return { seeded: seed.status === 0 };
}

function buildKitchenSink(file: string): void {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE parent (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      ratio REAL,
      data BLOB,
      flag INTEGER NOT NULL DEFAULT 0 CHECK(flag IN (0,1)),
      meta TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(meta)),
      score INTEGER CHECK(score BETWEEN 0 AND 100),
      total INTEGER GENERATED ALWAYS AS (flag + coalesce(score, 0)) STORED,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      upd TEXT
    );
    CREATE TABLE child (
      parent_id INTEGER NOT NULL REFERENCES parent(id) ON DELETE CASCADE,
      pos INTEGER NOT NULL,
      label TEXT,
      amount NUMERIC,
      PRIMARY KEY(parent_id, pos)
    ) WITHOUT ROWID;
    CREATE TABLE log (body TEXT NOT NULL, at TEXT);
    CREATE TABLE blobs (k BLOB PRIMARY KEY, v BLOB);
    CREATE INDEX parent_lower_code ON parent(lower(code));
    CREATE UNIQUE INDEX one_flagged_score ON parent(score) WHERE flag = 1;
    CREATE INDEX log_body_nocase ON log(body COLLATE NOCASE);
    CREATE TRIGGER parent_touch AFTER UPDATE OF score ON parent
      BEGIN UPDATE parent SET upd = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id; END;
    CREATE TRIGGER parent_audit AFTER INSERT ON parent BEGIN INSERT INTO log(body, at) VALUES ('new ' || NEW.code, NEW.created_at); END;
    CREATE TRIGGER log_append_only BEFORE UPDATE ON log BEGIN SELECT RAISE(ABORT, 'log is append-only'); END;
    CREATE TRIGGER child_limit BEFORE INSERT ON child WHEN (SELECT COUNT(*) FROM child WHERE parent_id = NEW.parent_id) >= 3
      BEGIN SELECT RAISE(ABORT, 'too many children'); END;
    CREATE VIEW parent_summary AS
      SELECT p.id, p.code, COUNT(c.pos) AS children, SUM(c.amount) AS amount FROM parent p LEFT JOIN child c ON c.parent_id = p.id GROUP BY p.id;
  `);
  const insert = db.prepare('INSERT INTO parent (code, ratio, data, flag, meta, score) VALUES (?, ?, ?, ?, ?, ?)');
  insert.run('Ab', 0.1, new Uint8Array([0, 255, 16]), 1, '{"a":[1,2]}', 10);
  insert.run('ab', 1e300, new Uint8Array([]), 0, '[]', null);
  insert.run('é', -2.5, null, 1, '"x"', 20);
  insert.run('to-delete', null, null, 0, '{}', null);
  db.exec("DELETE FROM parent WHERE code = 'to-delete'"); // sqlite_sequence (4) > max(id) (3)
  const child = db.prepare('INSERT INTO child (parent_id, pos, label, amount) VALUES (?, ?, ?, ?)');
  child.run(1, 1, 'un', 12.5);
  child.run(1, 2, null, 3);
  child.run(1, 3, 'trois\n', null);
  child.run(3, 1, '', '0012.50');
  db.prepare('INSERT INTO log (body, at) VALUES (?, NULL)').run('tab\there "quoted" \\ back');
  const blob = db.prepare('INSERT INTO blobs (k, v) VALUES (?, ?)');
  blob.run(new Uint8Array([1]), new Uint8Array([1, 2, 3]));
  blob.run(new Uint8Array([0, 1]), null);
  blob.run(new Uint8Array([255]), new Uint8Array(70_000).fill(7));
  db.close();
}

async function expectPgError(client: pg.Client, sql: string, code: string, message?: RegExp): Promise<void> {
  await client.query('SAVEPOINT probe');
  let failure: (Error & { code?: string }) | undefined;
  try {
    await client.query(sql);
  } catch (error) {
    failure = error as Error & { code?: string };
  }
  await client.query('ROLLBACK TO SAVEPOINT probe');
  assert.ok(failure, `erreur ${code} attendue : ${sql}`);
  assert.equal(failure.code, code, `${sql} -> ${failure.message}`);
  if (message) assert.match(failure.message, message);
}

async function runExport(file: string, schema: string, options: { rowid?: boolean; drop?: boolean } = {}) {
  const client = await connect();
  const sqlite = openSqliteReadOnly(file);
  try {
    return await withSqliteSnapshot(sqlite, async () => {
      const exported = await exportToPostgres({ sqlite, client, schema, drop: options.drop, rowid: options.rowid, batchSize: 7 });
      const verified = await verifyExport({ sqlite, client, schema, rowid: options.rowid, conversion: exported.conversion });
      return { exported, verified };
    });
  } finally {
    sqlite.close();
  }
}

/** Random container password: any occurrence is a leak. CI passwords (e.g. "alpha") are only searched in their URL form. */
function leaks(text: string): boolean {
  return externalUrl ? text.includes(`:${encodeURIComponent(password)}@`) || text.includes(`password=${password}`) : text.includes(password);
}

function convertOnce(file: string, schema: string) {
  const sqlite = openSqliteReadOnly(file);
  try {
    return convertSqliteSchema(sqlite, { schema });
  } finally {
    sqlite.close();
  }
}

function cli(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'scripts/export-postgres.ts', ...args], {
    env: { ...process.env, ...env }, encoding: 'utf8', timeout: 180_000,
  });
}

describe('SQLite -> PostgreSQL export (postgres:16)', { skip }, () => {
  const alphaFile = join(workDir, 'alpha.sqlite');
  const kitFile = join(workDir, 'kitchen-sink.sqlite');
  let seeded = false;

  before(async () => {
    mkdirSync(workDir, { recursive: true });
    ({ seeded } = buildAlphaDatabase(alphaFile));
    buildKitchenSink(kitFile);
    await startPostgres();
  });

  after(async () => {
    if (externalUrl && clients.length) {
      for (const schema of createdSchemas) await clients[0].query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    }
    await Promise.all(clients.map((client) => client.end().catch(() => undefined)));
    if (container) spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore', timeout: 60_000 });
    rmSync(workDir, { recursive: true, force: true });
  });

  test('Alpha database: export, checksums, FK validation, sequences', async (t) => {
    if (!seeded) t.diagnostic('server/seed.ts a échoué : base construite par schema.sql + migrations uniquement');
    const schema = schemaName('alpha_it');
    const { exported, verified } = await runExport(alphaFile, schema);
    assert.deepEqual(exported.errors, []);
    assert.deepEqual(exported.conversion.warnings, []);
    assert.deepEqual(exported.conversion.unsupported, []);
    assert.deepEqual(verified.errors, []);
    assert.deepEqual(verified.tables.filter((table) => !table.ok), []);
    assert.deepEqual(verified.foreignKeys.filter((fk) => !fk.ok), []);
    assert.deepEqual(verified.objects.filter((item) => item.missing.length), []);
    assert.deepEqual(verified.sequences.filter((item) => !item.ok), []);
    assert.equal(verified.sourceForeignKeyViolations, 0);
    assert.equal(verified.ok, true);
    assert.equal(verified.tables.length, exported.conversion.tables.length);
    assert.ok(verified.foreignKeys.length > 100);
    assert.ok(exported.rows.users >= 5 && exported.rows.ledger_entries === 2 && exported.rows.messages >= 2);
    if (seeded) assert.ok(exported.rows.orders >= 1 && exported.rows.order_events >= 1 && exported.rows.projects >= 2);
    const triggers = verified.objects.find((item) => item.kind === 'trigger')!;
    assert.ok(triggers.expected >= 9, 'immutability, sandbox and appeal triggers exported');
  });

  test('Alpha database: values and constraints behave in PostgreSQL', async () => {
    const client = await connect();
    const schema = [...createdSchemas].find((name) => name.startsWith('alpha_it_'))!;
    await client.query('BEGIN');
    try {
      await client.query(`SET LOCAL search_path TO "${schema}"`);
      const one = async (sql: string) => (await client.query(sql)).rows[0];
      // Values.
      assert.equal((await one(`SELECT amount_minor::text AS v FROM ledger_entries WHERE id = 'pg-entry-1'`)).v, BIG.toString());
      assert.equal((await one(`SELECT sum(amount_minor)::text AS v FROM ledger_entries`)).v, '0');
      assert.equal((await one(`SELECT name FROM users WHERE id = 'A-user'`)).name, `Zoé "Ζήτα" O'Brien 🚀`);
      assert.equal((await one(`SELECT bio FROM users WHERE id = 'A-user'`)).bio, 'ligne 1\nligne 2\r\n\\ fin — « guillemets » ');
      assert.equal((await one(`SELECT fx_rate FROM payment_intents WHERE id = 'pg-intent-2'`)).fx_rate, 0.1);
      assert.equal((await one(`SELECT fx_rate FROM payment_intents WHERE id = 'pg-intent-1'`)).fx_rate, 655.957);
      assert.equal((await one(`SELECT (value::jsonb -> 'rates' ->> 2) AS v FROM platform_settings WHERE key = 'payments.mode'`)).v, '-0.03');
      assert.equal((await one(`SELECT body FROM messages WHERE id = 'pg-message-2'`)).body, '');
      assert.equal((await one(`SELECT created_at FROM sessions WHERE token_hash = 'pg-token'`)).created_at, null);
      const ids = (await client.query(`SELECT id FROM users WHERE id IN ('A-user','a-user','Z-user','_user','é-user') ORDER BY id`)).rows.map((row) => row.id);
      assert.deepEqual(ids, ['A-user', 'Z-user', '_user', 'a-user', 'é-user'], 'text columns keep the SQLite BINARY (C) collation');

      // CHECK, NOT NULL, UNIQUE, partial UNIQUE, FK.
      await expectPgError(client, `INSERT INTO users (id, name, email, password_hash, role) VALUES ('x', 'x', 'x@x.test', 'h', 'superuser')`, '23514');
      await expectPgError(client, `INSERT INTO users (id, name, email, password_hash) VALUES ('y', 'y', 'Auser0@export.test', 'h')`, '23505');
      await expectPgError(client, `INSERT INTO users (id, email, password_hash) VALUES ('y', 'y@x.test', 'h')`, '23502');
      await expectPgError(client, `INSERT INTO messages (id, conversation_id, sender_id, body) VALUES ('m-x', 'no-such-conversation', 'A-user', 'x')`, '23503');
      await expectPgError(client, `UPDATE platform_settings SET value = '{not json' WHERE key = 'payments.mode'`, '23514');
      await expectPgError(client, `UPDATE sandbox_runs SET command = '{"cmd":"node"}' WHERE id = 'pg-run'`, '23514');
      await expectPgError(client, `UPDATE sandbox_runs SET container_name = 'other-name' WHERE id = 'pg-run'`, '23514');
      await expectPgError(client, `UPDATE sanctions SET capabilities = '[]' WHERE id = 'pg-sanction'`, '23514');
      await expectPgError(client, `UPDATE ledger_journals SET currency = 'EURO' WHERE id = 'pg-journal'`, '23000', /ledger journals are immutable/);
      await expectPgError(client, `INSERT INTO transactions (id, user_id, mission_id, kind, amount_cents) VALUES ('pg-payout-2', 'a-user', 'pg-mission', 'payout', 10)`, '23505');
      await client.query(`INSERT INTO transactions (id, user_id, mission_id, kind, amount_cents) VALUES ('pg-funding-2', 'a-user', 'pg-mission', 'funding', 10)`);

      // Append-only / immutability triggers, including TRUNCATE.
      await expectPgError(client, `UPDATE ledger_entries SET account = 'other' WHERE id = 'pg-entry-1'`, '23000', /ledger entries are immutable/);
      await expectPgError(client, `DELETE FROM ledger_entries WHERE id = 'pg-entry-1'`, '23000', /ledger entries are immutable/);
      await expectPgError(client, `TRUNCATE ledger_entries`, '23000', /ledger entries are immutable/);
      await expectPgError(client, `DELETE FROM invoices`, '23000', /invoices are immutable/);
      await expectPgError(client, `UPDATE consent_events SET granted = 0`, '23000', /consent history is immutable/);
      await client.query(`INSERT INTO ledger_entries (id, journal_id, account, amount_minor, currency, mode) VALUES ('pg-entry-3', 'pg-journal', 'fees', 1, 'XAF', 'sandbox')`);

      // Conditional triggers.
      await client.query(`UPDATE sandbox_runs SET logs = 'ok' WHERE id = 'pg-run'`);
      await expectPgError(client, `UPDATE sandbox_runs SET status = 'running' WHERE id = 'pg-run'`, '23000', /sandbox run already finished/);
      const statement = `'${'Je conteste cette décision, motifs détaillés.'}'`;
      await client.query(`INSERT INTO appeals (id, sanction_id, user_id, statement) VALUES ('pg-appeal-2', 'pg-sanction', 'a-user', ${statement})`);
      await expectPgError(client, `INSERT INTO appeals (id, sanction_id, user_id, statement) VALUES ('pg-appeal-3', 'pg-sanction', 'a-user', ${statement})`, '23000', /appeal limit reached/);

      // Defaults and identity columns.
      const consent = await one(`INSERT INTO consent_events (id, user_id, purpose, granted, policy_version) VALUES ('pg-consent-2', 'A-user', 'marketing_email', 0, 'v2')
        RETURNING created_at, source`);
      assert.match(consent.created_at, ISO_UTC);
      assert.equal(consent.source, 'settings');
      const before = await one(`SELECT max(rowid)::text AS v FROM messages`);
      const message = await one(`INSERT INTO messages (id, conversation_id, sender_id, body) VALUES ('pg-message-3', 'pg-conversation', 'A-user', 'x') RETURNING rowid::text AS v`);
      assert.ok(BigInt(message.v) > BigInt(before.v));
      const columns = (await client.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'messages' ORDER BY ordinal_position`, [schema])).rows;
      assert.equal(columns.at(-1)?.column_name, 'rowid', 'implicit SQLite rowid materialised as the last column');
    } finally {
      await client.query('ROLLBACK');
    }
  });

  test('verification detects tampering, and an existing schema is never overwritten without --drop', async () => {
    const client = await connect();
    const schema = [...createdSchemas].find((name) => name.startsWith('alpha_it_'))!;
    await client.query(`UPDATE "${schema}".users SET bio = 'modifié' WHERE id = 'a-user'`);
    await client.query(`DELETE FROM "${schema}".notifications WHERE id = 'pg-notification'`);
    const sqlite = openSqliteReadOnly(alphaFile);
    try {
      const report = await withSqliteSnapshot(sqlite, () => verifyExport({ sqlite, client, schema }));
      assert.equal(report.ok, false);
      const users = report.tables.find((table) => table.table === 'users')!;
      assert.equal(users.ok, false);
      assert.equal(users.sqliteRows, users.pgRows);
      assert.match(users.mismatch ?? '', /id="a-user".*bio/);
      const notifications = report.tables.find((table) => table.table === 'notifications')!;
      assert.equal(notifications.pgRows, notifications.sqliteRows - 1);
      assert.equal(report.tables.filter((table) => !table.ok).length, 2);
      await assert.rejects(withSqliteSnapshot(sqlite, () => exportToPostgres({ sqlite, client, schema })), /existe déjà et n’est pas vide/);
    } finally {
      sqlite.close();
    }
    const { exported, verified } = await runExport(alphaFile, schema, { drop: true });
    assert.deepEqual(exported.errors, []);
    assert.equal(verified.ok, true);
  });

  test('kitchen-sink schema: BLOB, REAL, NUMERIC, AUTOINCREMENT, generated column, WITHOUT ROWID, view and triggers', async () => {
    const schema = schemaName('kit');
    const { exported, verified } = await runExport(kitFile, schema);
    assert.deepEqual(exported.errors, []);
    assert.equal(verified.ok, true, JSON.stringify(verified.tables.filter((table) => !table.ok)));
    assert.deepEqual(exported.conversion.unsupported, []);
    assert.deepEqual(exported.conversion.warnings.map((line) => line.split(' : ')[0]).sort(), ['déclencheur parent_audit', 'index log_body_nocase']);
    assert.deepEqual(exported.sequences.find((item) => item.table === 'parent'), { table: 'parent', column: 'id', next: '5' });

    const client = await connect();
    await client.query('BEGIN');
    try {
      await client.query(`SET LOCAL search_path TO "${schema}"`);
      const one = async (sql: string) => (await client.query(sql)).rows[0];
      assert.equal((await one(`SELECT encode(data, 'hex') AS v FROM parent WHERE id = 1`)).v, '00ff10');
      assert.equal((await one(`SELECT octet_length(data) AS v FROM parent WHERE id = 2`)).v, 0);
      assert.equal((await one(`SELECT ratio FROM parent WHERE id = 2`)).ratio, 1e300);
      assert.equal((await one(`SELECT total::int AS v FROM parent WHERE id = 3`)).v, 21);
      assert.equal((await one(`SELECT octet_length(v) AS v FROM blobs WHERE k = '\\xff'::bytea`)).v, 70_000);
      assert.equal((await one(`SELECT amount::text AS v FROM child WHERE parent_id = 3`)).v, '12.5');
      assert.deepEqual((await client.query(`SELECT id::int, children::int, amount::text FROM parent_summary ORDER BY id`)).rows,
        [{ id: 1, children: 3, amount: '15.5' }, { id: 2, children: 0, amount: null }, { id: 3, children: 1, amount: '12.5' }]);

      const inserted = await one(`INSERT INTO parent (code, flag, score) VALUES ('new', 1, 50) RETURNING id::int, total::int, created_at`);
      assert.deepEqual([inserted.id, inserted.total], [5, 51], 'identity continues after sqlite_sequence, generated column computed');
      assert.match(inserted.created_at, ISO_UTC);
      assert.equal((await one(`SELECT count(*)::int AS v FROM log WHERE body = 'new new'`)).v, 1, 'AFTER INSERT trigger copied to log');
      assert.equal((await one(`UPDATE parent SET score = 11 WHERE id = 1 RETURNING upd`)).upd.length, 24);
      assert.equal((await one(`UPDATE parent SET ratio = 2 WHERE id = 2 RETURNING upd`)).upd, null, 'touch trigger limited to UPDATE OF score');
      await expectPgError(client, `UPDATE log SET at = 'x'`, '23000', /log is append-only/);
      await expectPgError(client, `INSERT INTO child (parent_id, pos) VALUES (1, 4)`, '23000', /too many children/);
      await client.query(`INSERT INTO child (parent_id, pos) VALUES (2, 1)`);
      await expectPgError(client, `INSERT INTO parent (code, flag, score) VALUES ('dup', 1, 20)`, '23505');
      await expectPgError(client, `INSERT INTO parent (code, meta) VALUES ('bad', 'nope')`, '23514');
      await expectPgError(client, `INSERT INTO child (parent_id, pos) VALUES (99, 1)`, '23503');
      await client.query('DELETE FROM parent WHERE id = 1');
      assert.equal((await one('SELECT count(*)::int AS v FROM child WHERE parent_id = 1')).v, 0, 'ON DELETE CASCADE');
    } finally {
      await client.query('ROLLBACK');
    }

    const plain = await runExport(kitFile, schemaName('kit_norowid'), { rowid: false });
    assert.equal(plain.verified.ok, true);
    assert.ok(!plain.exported.conversion.tables.find((table) => table.name === 'log')!.columns.some((column) => column.rowid));
  });

  test('CLI: export + report, verify-only, standalone DDL file, password never printed', async () => {
    const schema = schemaName('cli');
    const report = join(workDir, 'report.json');
    const exported = cli(['--sqlite', alphaFile, '--schema', schema, '--batch', '50', '--report', report], { ALPHA_PG_URL: connectionString });
    const output = `${exported.stdout}\n${exported.stderr}`;
    assert.equal(exported.status, 0, output);
    assert.match(exported.stdout, /Résultat : OK/);
    if (password) assert.ok(!leaks(output), 'password leaked');
    if (password) assert.match(output, /\*\*\*\*/);
    const json = JSON.parse(readFileSync(report, 'utf8'));
    assert.equal(json.ok, true);
    assert.deepEqual(json.warnings, []);
    if (password) assert.ok(!leaks(JSON.stringify(json)));

    const verifyOnly = cli(['--sqlite', alphaFile, '--schema', schema, '--verify-only'], { ALPHA_PG_URL: connectionString });
    assert.equal(verifyOnly.status, 0, verifyOnly.stderr);
    const again = cli(['--sqlite', alphaFile, '--schema', schema], { ALPHA_PG_URL: connectionString });
    assert.equal(again.status, 2);
    assert.match(again.stderr, /--drop/);
    assert.equal(cli(['--sqlite', alphaFile, '--schema', 'public', '--ddl-only', '-']).status, 2);
    assert.equal(cli(['--sqlite', join(workDir, 'missing.sqlite'), '--ddl-only', '-']).status, 2);

    // The standalone DDL script applies as-is (psql -f equivalent), on an empty schema.
    const ddlSchema = schemaName('ddl');
    const ddl = cli(['--sqlite', alphaFile, '--schema', ddlSchema, '--ddl-only', '-'], { ALPHA_PG_URL: '' });
    assert.equal(ddl.status, 0, ddl.stderr);
    const conversion = convertOnce(alphaFile, ddlSchema);
    assert.equal(ddl.stdout, conversion.ddl);
    const client = await connect();
    await client.query(ddl.stdout);
    const counts = (await client.query(`SELECT
      (SELECT count(*)::int FROM pg_tables WHERE schemaname = $1) AS tables,
      (SELECT count(*)::int FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND NOT g.tgisinternal) AS triggers,
      (SELECT count(*)::int FROM pg_constraint k JOIN pg_namespace n ON n.oid = k.connamespace WHERE n.nspname = $1 AND k.contype = 'f') AS fks`, [ddlSchema])).rows[0];
    assert.equal(counts.tables, conversion.tables.length);
    assert.equal(counts.fks, conversion.foreignKeys.length);
    assert.equal(counts.triggers, conversion.triggers.reduce((total, trigger) => total + trigger.triggerNames.length, 0));
  });
});
