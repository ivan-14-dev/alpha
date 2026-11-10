import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { migrate } from '../../server/migrations.js';
import { assertSchemaName, convertSqliteSchema } from '../../server/pg/convert.js';
import { maskConnectionString } from '../../server/pg/copy.js';
import { referencedRelations, tokenize } from '../../server/pg/sql.js';
import { globToRegex, mapDeclaredType, strftimeToPg } from '../../server/pg/translate.js';

const ISO_NOW = `to_char((statement_timestamp() AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

function memory(sql: string): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(sql);
  return db;
}

function alphaDatabase(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(readFileSync('server/schema.sql', 'utf8'));
  migrate(db);
  return db;
}

test('declared types follow SQLite affinity rules', () => {
  const cases: [string, string][] = [
    ['INTEGER', 'bigint'], ['BIGINT', 'bigint'], ['TEXT', 'text'], ['VARCHAR(20)', 'text'], ['CLOB', 'text'], ['REAL', 'double precision'],
    ['DOUBLE PRECISION', 'double precision'], ['FLOAT', 'double precision'], ['BLOB', 'bytea'], ['NUMERIC', 'numeric'], ['DECIMAL(10,2)', 'numeric'],
    ['BOOLEAN', 'bigint'], ['DATETIME', 'text'], ['JSON', 'text'],
  ];
  for (const [declared, expected] of cases) {
    const mapped = mapDeclaredType(declared);
    assert.equal(mapped.type, expected, declared);
    assert.equal(mapped.warning, undefined, declared);
  }
  assert.match(mapDeclaredType('').warning ?? '', /sans type/);
  assert.match(mapDeclaredType('FOO').warning ?? '', /affinité NUMERIC/);
});

test('GLOB patterns, strftime formats and connection strings are translated safely', () => {
  assert.equal(globToRegex('alpha-sbx-*'), '^alpha-sbx-.*$');
  assert.equal(globToRegex('[0-9][0-9][0-9][0-9]-??-*'), '^[0-9][0-9][0-9][0-9]-..-.*$');
  assert.equal(globToRegex('a[^x]b.c'), '^a[^x]b\\.c$');
  assert.equal(strftimeToPg('%Y-%m-%dT%H:%M:%fZ'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  assert.equal(strftimeToPg('%Y-%m-%d %H:%M:%S'), 'YYYY-MM-DD HH24:MI:SS');
  assert.equal(strftimeToPg('%s'), undefined);

  for (const connection of [
    'postgres://alpha:s3cr3t-pw@db.example:5432/alpha?sslmode=require',
    'postgresql://alpha:s3cr3t-pw@db.example/alpha',
    'postgres://alpha@db.example/alpha?password=s3cr3t-pw',
    'host=db.example user=alpha password=s3cr3t-pw dbname=alpha',
    "host=db.example password='s3cr3t-pw' dbname=alpha",
  ]) {
    const masked = maskConnectionString(connection);
    assert.ok(!masked.includes('s3cr3t-pw'), masked);
    assert.ok(masked.includes('****'), masked);
    assert.ok(masked.includes('db.example'), masked);
  }
  assert.equal(maskConnectionString('postgres://alpha@localhost/alpha'), 'postgres://alpha@localhost/alpha');
});

test('schema names are validated', () => {
  for (const bad of ['public', 'pg_alpha', 'information_schema', 'Alpha', 'a-b', '1alpha', '', 'x'.repeat(64), 'alpha"; DROP SCHEMA x; --']) {
    assert.throws(() => assertSchemaName(bad), /schéma PostgreSQL invalide/, bad);
  }
  for (const good of ['alpha', 'alpha_v4', '_replica', 'analytics2']) assertSchemaName(good);
});

test('relations referenced by trigger bodies and views are collected', () => {
  const names = referencedRelations(tokenize(`WITH recent AS (SELECT id FROM orders) SELECT * FROM users u JOIN recent r ON r.id = u.id,
    projects p LEFT JOIN campaigns c ON c.project_id = p.id WHERE u.id IN (SELECT user_id FROM sessions)`));
  assert.deepEqual([...new Set(names.map((name) => name.toLowerCase()))].sort(), ['campaigns', 'orders', 'projects', 'sessions', 'users']);
  assert.deepEqual(referencedRelations(tokenize("INSERT INTO audit(body) VALUES ('x')")), ['audit']);
  assert.deepEqual(referencedRelations(tokenize("UPDATE t SET a = (SELECT b FROM u)")).sort(), ['t', 'u']);
});

test('kitchen-sink schema: types, defaults, checks, indexes, foreign keys, triggers and views', () => {
  const db = memory(`
    CREATE TABLE parent (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL COLLATE NOCASE UNIQUE,
      ratio REAL DEFAULT 1.5,
      data BLOB,
      flag INTEGER NOT NULL DEFAULT 0 CHECK(flag IN (0,1)),
      meta TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(meta)),
      tags TEXT CHECK(json_type(tags) = 'array' AND json_array_length(tags) <= 5),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      day TEXT DEFAULT CURRENT_DATE,
      ts TEXT DEFAULT CURRENT_TIMESTAMP,
      version TEXT DEFAULT 1,
      neg INTEGER DEFAULT -3,
      slug TEXT CHECK(slug GLOB '[a-z]*' AND slug NOT LIKE '%--%'),
      url TEXT CHECK(url IS NULL OR url LIKE 'http%'),
      score INTEGER CHECK(score BETWEEN 0 AND 100 AND score != 50),
      total INTEGER GENERATED ALWAYS AS (flag + coalesce(score, 0)) STORED,
      upd TEXT
    );
    CREATE TABLE child (
      parent_id INTEGER NOT NULL REFERENCES parent(id) ON DELETE CASCADE ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      pos INTEGER NOT NULL,
      label TEXT CHECK(length(label) > 0 AND substr(label, 1, 1) NOT IN ('/', '\\') AND upper(label) != 'X'),
      PRIMARY KEY(parent_id, pos)
    ) WITHOUT ROWID;
    CREATE TABLE log (body TEXT NOT NULL, active INTEGER CHECK(active), owner TEXT REFERENCES parent(code) ON DELETE SET NULL);
    CREATE TABLE strange (x TEXT CHECK(printf('%d', x) != ''), h TEXT CHECK(hex(h) != '' AND instr(h, 'a') > 0), n INTEGER DEFAULT 'abc');
    CREATE UNIQUE INDEX one_active ON log(body) WHERE active = 1;
    CREATE INDEX lower_code ON parent(lower(code), created_at DESC);
    CREATE INDEX nocase_code ON parent(code COLLATE NOCASE);
    CREATE TRIGGER log_no_update BEFORE UPDATE ON log BEGIN SELECT RAISE(ABORT, 'log is append-only'); END;
    CREATE TRIGGER log_no_delete BEFORE DELETE ON log BEGIN SELECT RAISE(ABORT, 'log is append-only'); END;
    CREATE TRIGGER parent_touch AFTER UPDATE ON parent BEGIN UPDATE parent SET upd = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id; END;
    CREATE TRIGGER parent_audit AFTER INSERT ON parent BEGIN INSERT OR IGNORE INTO log(body) VALUES ('new ' || NEW.code); END;
    CREATE TRIGGER child_guard BEFORE INSERT ON child WHEN (SELECT COUNT(*) FROM child WHERE parent_id = NEW.parent_id) >= 3
      BEGIN SELECT RAISE(ABORT, 'too many'); END;
    CREATE TRIGGER parent_final BEFORE UPDATE OF flag ON parent WHEN OLD.flag = 1 AND NEW.flag != OLD.flag
      BEGIN SELECT RAISE(ABORT, 'flag is final'); END;
    CREATE TRIGGER missing_target AFTER INSERT ON log BEGIN INSERT INTO nowhere(x) VALUES (1); END;
    CREATE VIEW parent_summary AS SELECT p.id, p.code, COUNT(c.pos) AS children FROM parent p LEFT JOIN child c ON c.parent_id = p.id GROUP BY p.id;
    CREATE VIRTUAL TABLE docs USING fts5(body);
  `);
  db.exec('CREATE TABLE extra (k TEXT PRIMARY KEY)');
  const result = convertSqliteSchema(db, { schema: 'kit' });
  const ddl = result.ddl;
  const table = (name: string) => result.tables.find((item) => item.name === name)!;

  // Tables: FTS shadow tables are skipped, the virtual table is reported, parents come before children.
  assert.deepEqual(result.tables.map((item) => item.name).sort(), ['child', 'extra', 'log', 'parent', 'strange']);
  assert.ok(result.tables.findIndex((item) => item.name === 'parent') < result.tables.findIndex((item) => item.name === 'child'));
  assert.ok(result.unsupported.some((item) => item.kind === 'table' && item.name === 'docs'));

  // Types, identity, rowid.
  assert.match(ddl, /"id" bigint GENERATED BY DEFAULT AS IDENTITY,/);
  assert.match(ddl, /"ratio" double precision DEFAULT 1\.5,/);
  assert.match(ddl, /"data" bytea,/);
  assert.match(ddl, /"code" text COLLATE "C" NOT NULL,/);
  assert.equal(table('parent').autoincrement, true);
  assert.deepEqual(table('child').primaryKey, ['parent_id', 'pos']);
  assert.equal(table('child').withoutRowid, true);
  assert.ok(!table('child').columns.some((column) => column.rowid));
  assert.deepEqual(table('log').columns.filter((column) => column.rowid).map((column) => column.name), ['rowid']);
  assert.match(ddl, /"rowid" bigint GENERATED BY DEFAULT AS IDENTITY,\n {2}CONSTRAINT "log_rowid_key" UNIQUE \("rowid"\)/);
  assert.ok(!convertSqliteSchema(db, { schema: 'kit', rowid: false }).tables.find((item) => item.name === 'log')!.columns.some((column) => column.rowid));

  // Defaults.
  assert.ok(ddl.includes(`"created_at" text COLLATE "C" NOT NULL DEFAULT ${ISO_NOW}`));
  assert.ok(ddl.includes(`"day" text COLLATE "C" DEFAULT to_char((statement_timestamp() AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`));
  assert.ok(ddl.includes(`"ts" text COLLATE "C" DEFAULT to_char((statement_timestamp() AT TIME ZONE 'UTC'), 'YYYY-MM-DD HH24:MI:SS')`));
  assert.match(ddl, /"version" text COLLATE "C" DEFAULT '1',/);
  assert.match(ddl, /"neg" bigint DEFAULT -3,/);
  assert.match(ddl, /"total" bigint GENERATED ALWAYS AS \("flag" \+ coalesce\("score", 0\)\) STORED,/);

  // CHECK constraints.
  assert.ok(ddl.includes('CONSTRAINT "parent_flag_check" CHECK ("flag" IN (0, 1))'));
  assert.ok(ddl.includes('CONSTRAINT "parent_meta_check" CHECK ("kit".sqlite_json_valid("meta"))'));
  assert.ok(ddl.includes(`CHECK ("kit".sqlite_json_type("tags") = 'array' AND "kit".sqlite_json_array_length("tags") <= 5)`));
  assert.ok(ddl.includes(`CHECK ("slug" ~ '^[a-z].*$' AND "slug" NOT ILIKE '%--%')`));
  assert.ok(ddl.includes(`CHECK ("url" IS NULL OR "url" ILIKE 'http%')`));
  assert.ok(ddl.includes('CHECK ("score" BETWEEN 0 AND 100 AND "score" <> 50)'));
  assert.ok(ddl.includes(`CHECK (length("label") > 0 AND substr("label", 1, 1) NOT IN ('/', '\\') AND upper("label") <> 'X')`));
  assert.ok(ddl.includes('CONSTRAINT "log_active_check" CHECK (("active") <> 0)'));
  assert.deepEqual(result.helpers.map((helper) => helper.name).sort(), ['sqlite_json_array_length', 'sqlite_json_type', 'sqlite_json_valid']);

  // Untranslatable objects are skipped and reported with their original SQL.
  assert.ok(result.unsupported.some((item) => item.kind === 'check' && item.name.startsWith('strange.') && /printf\(\)/.test(item.reason)));
  assert.ok(result.unsupported.some((item) => item.kind === 'default' && item.name === 'strange.n'));
  assert.ok(result.unsupported.some((item) => item.kind === 'trigger' && item.name === 'missing_target'));
  assert.ok(!/printf\(/.test(ddl.split('COMMIT;')[0]));
  assert.ok(ddl.includes(`CHECK (upper(encode(convert_to(("h")::text, 'UTF8'), 'hex')) <> '' AND strpos("h", 'a') > 0)`));
  assert.match(ddl.split('COMMIT;')[1], /-- CHECK \(printf\('%d', x\) != ''\)/);

  // Indexes: UNIQUE constraints, partial, expression, NOCASE.
  assert.ok(ddl.includes('CONSTRAINT "parent_code_key" UNIQUE ("code")'));
  assert.ok(ddl.includes(`CREATE UNIQUE INDEX "one_active" ON "kit"."log" ("body") WHERE "active" = 1;`));
  assert.ok(ddl.includes(`CREATE INDEX "lower_code" ON "kit"."parent" ((lower("code")), "created_at" DESC);`));
  assert.ok(ddl.includes(`CREATE INDEX "nocase_code" ON "kit"."parent" ((lower("code")));`));
  assert.equal(result.indexes.find((index) => index.name === 'one_active')?.partial, true);

  // Foreign keys are added after every table, deferrable, with their actions.
  assert.ok(ddl.indexOf('-- Clés étrangères') > ddl.lastIndexOf('CREATE TABLE'));
  assert.ok(ddl.includes(`ALTER TABLE "kit"."child" ADD CONSTRAINT "child_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "kit"."parent" ("id") ON UPDATE RESTRICT ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;`));
  assert.ok(ddl.includes(`ALTER TABLE "kit"."log" ADD CONSTRAINT "log_owner_fkey" FOREIGN KEY ("owner") REFERENCES "kit"."parent" ("code") ON DELETE SET NULL DEFERRABLE INITIALLY IMMEDIATE;`));

  // Triggers.
  const trigger = (name: string) => result.triggers.find((item) => item.name === name)!;
  assert.equal(trigger('log_no_update').pattern, 'guard');
  assert.match(trigger('log_no_update').functionSql, /RAISE EXCEPTION USING ERRCODE = '23000', MESSAGE = 'log is append-only';/);
  assert.deepEqual(trigger('log_no_delete').triggerNames, ['log_no_delete', 'log_no_delete_truncate']);
  assert.match(trigger('log_no_delete').sql[1], /BEFORE TRUNCATE ON "kit"\."log" FOR EACH STATEMENT/);
  assert.equal(trigger('parent_touch').pattern, 'touch');
  assert.match(trigger('parent_touch').sql[0], /BEFORE UPDATE ON "kit"\."parent"/);
  assert.ok(trigger('parent_touch').functionSql.includes(`NEW."upd" := ${ISO_NOW};`));
  assert.equal(trigger('parent_audit').pattern, 'generic');
  assert.match(trigger('parent_audit').functionSql, /INSERT INTO "log" \("body"\) VALUES \('new ' \|\| NEW\."code"\) ON CONFLICT DO NOTHING;/);
  assert.equal(trigger('child_guard').pattern, 'guard');
  assert.match(trigger('child_guard').functionSql, /IF NOT coalesce\(\(\(SELECT count\(\*\) FROM "child" WHERE "parent_id" = NEW\."parent_id"\) >= 3\), false\) THEN/);
  assert.ok(!/ WHEN \(/.test(trigger('child_guard').sql[0]), 'subquery WHEN moved into the function body');
  assert.ok(trigger('parent_final').sql[0].includes(`BEFORE UPDATE OF "flag" ON "kit"."parent" FOR EACH ROW WHEN (OLD."flag" = 1 AND NEW."flag" <> OLD."flag")`));
  assert.match(trigger('parent_final').functionSql, /SET search_path = pg_catalog, "kit"/);

  // Views get an explicit column list.
  assert.ok(ddl.includes(`CREATE VIEW "kit"."parent_summary" ("id", "code", "children") AS SELECT p."id", p."code", count(c."pos") AS "children" FROM "parent" p LEFT JOIN "child" c ON c."parent_id" = p."id" GROUP BY p."id"`));

  // Every semantic difference is reported once.
  assert.ok(result.warnings.some((line) => line.startsWith('table parent.code') && line.includes('NOCASE')));
  assert.ok(result.warnings.some((line) => line.startsWith('index nocase_code')));
  assert.ok(result.warnings.some((line) => line.startsWith('déclencheur parent_audit') && line.includes('générique')));
  assert.equal(new Set(result.warnings).size, result.warnings.length);
  db.close();
});

test('the full Alpha schema (schema.sql + every migration) converts without any warning', () => {
  const db = alphaDatabase();
  const result = convertSqliteSchema(db);
  const count = (sql: string) => Number((db.prepare(sql).get() as { n: number }).n);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.unsupported, []);
  assert.equal(result.tables.length, count("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'"));
  assert.equal(result.indexes.length, count("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL"));
  assert.equal(result.triggers.length, count("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger'"));
  assert.equal(result.views.length, count("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'view'"));
  assert.equal(result.foreignKeys.length, count(`SELECT COUNT(*) AS n FROM (SELECT DISTINCT m.name, f.id FROM sqlite_master m, pragma_foreign_key_list(m.name) f
    WHERE m.type = 'table')`));
  const checkSources = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL").all() as { sql: string }[])
    .reduce((total, row) => total + tokenize(row.sql).filter((token) => token.kind === 'word' && token.value.toUpperCase() === 'CHECK').length, 0);
  assert.equal(result.tables.reduce((total, table) => total + table.checks.length, 0), checkSources);
  assert.ok(result.tables.every((table) => table.primaryKey.length > 0 || table.columns.some((column) => column.rowid)));

  const body = result.ddl.split('\nCOMMIT;')[0];
  for (const sqliteOnly of [/strftime\(/i, /\bGLOB\b/, /!=/, /(?<!sqlite_)json_valid\(/, /(?<!sqlite_)json_type\(/, /\bRAISE\s*\(/, /AUTOINCREMENT/i, /WITHOUT ROWID/i]) {
    assert.doesNotMatch(body, sqliteOnly);
  }
  assert.ok(body.includes(`"container_name" ~ '^alpha-sbx-.*$'`));
  assert.ok(body.includes(`CREATE UNIQUE INDEX "unique_mission_payout" ON "alpha"."transactions" ("mission_id") WHERE "kind" = 'payout';`));
  assert.ok(body.includes(`"created_at" text COLLATE "C" NOT NULL DEFAULT ${ISO_NOW}`));
  const triggers = new Map(result.triggers.map((trigger) => [trigger.name, trigger]));
  for (const name of ['ledger_entries_immutable_update', 'ledger_entries_immutable_delete', 'ledger_journals_immutable_update', 'ledger_journals_immutable_delete']) {
    assert.equal(triggers.get(name)?.pattern, 'guard', name);
    assert.match(triggers.get(name)!.functionSql, /immutable/);
  }
  assert.ok(result.triggers.every((trigger) => trigger.pattern !== 'generic'), 'no trigger relies on the generic translation');
  db.close();
});
