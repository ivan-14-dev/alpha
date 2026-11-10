import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { latestSchemaVersion, migrate, migrations } from '../server/migrations.js';

const schema = readFileSync(new URL('../server/schema.sql', import.meta.url), 'utf8');

function legacyDatabase(path = ':memory:') {
  const database = new DatabaseSync(path);
  database.exec('PRAGMA foreign_keys=ON');
  database.exec(schema);
  database.exec(`
    INSERT INTO users(id,name,email,password_hash) VALUES
      ('owner','Owner','owner@example.test','test-fixture-not-a-login-hash'),
      ('tester','Tester','tester@example.test','test-fixture-not-a-login-hash');
    INSERT INTO sessions(token_hash,user_id,expires_at) VALUES ('preserved-session','owner','2099-01-01T00:00:00.000Z');
    INSERT INTO organizations(id,owner_id,name) VALUES ('org','owner','Legacy team');
    INSERT INTO organization_members(organization_id,user_id,role) VALUES ('org','owner','owner'),('org','tester','member');
    INSERT INTO projects(id,owner_id,organization_id,title,summary,description,category,visibility)
      VALUES ('project','owner','org','Existing private project','Existing summary','Private project content','saas','private');
    INSERT INTO campaigns(id,project_id,owner_id,title,description,reward_cents,slots,deadline)
      VALUES ('campaign','project','owner','Existing campaign','Existing instructions',2500,1,'2099-01-01T00:00:00.000Z');
    INSERT INTO applications(id,campaign_id,tester_id,motivation,status)
      VALUES ('application','campaign','tester','Existing application','accepted');
    INSERT INTO missions(id,campaign_id,tester_id,application_id,status)
      VALUES ('mission','campaign','tester','application','paid');
    INSERT INTO test_reports(id,mission_id,summary,steps,expected,observed)
      VALUES ('report','mission','Existing report','Existing steps','Expected result','Observed result');
    INSERT INTO transactions(id,user_id,campaign_id,mission_id,kind,amount_cents)
      VALUES ('payout','tester','campaign','mission','payout',2500);
    INSERT INTO reviews(id,author_id,subject_id,mission_id,rating,body)
      VALUES ('review','owner','tester','mission',4,'An existing collaboration review.');
    INSERT INTO posts(id,author_id,body) VALUES ('post','owner','An existing public discussion.');
    INSERT INTO comments(id,post_id,author_id,body) VALUES ('comment','post','tester','An existing comment.');
    INSERT INTO post_likes(post_id,user_id) VALUES ('post','tester');
    INSERT INTO conversations(id,subject,created_by) VALUES ('conversation','Existing private conversation','owner');
    INSERT INTO conversation_members(conversation_id,user_id) VALUES ('conversation','owner'),('conversation','tester');
    INSERT INTO messages(id,conversation_id,sender_id,body) VALUES ('message','conversation','owner','Existing private message.');
  `);
  return database;
}

const retainedTables = ['users', 'sessions', 'organizations', 'organization_members', 'projects', 'campaigns', 'applications', 'missions', 'test_reports', 'transactions', 'comments', 'post_likes', 'conversations', 'conversation_members', 'messages'];
// Columns added by later additive migrations; their backfilled values are asserted explicitly below.
const additiveColumns: Record<string, string[]> = { users: ['email_verified_at'], campaigns: ['payment_mode'] };
function snapshot(database: DatabaseSync) {
  return Object.fromEntries(retainedTables.map((table) => [table, database.prepare(`SELECT ${table === 'sessions' ? 'token_hash,user_id,expires_at' : '*'} FROM ${table} ORDER BY rowid`).all()
    .map((row) => Object.fromEntries(Object.entries(row).filter(([column]) => !additiveColumns[table]?.includes(column))))]));
}
function columns(database: DatabaseSync, table: 'posts' | 'reviews') {
  return database.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
}

test('V1 data upgrades atomically without fabricating ratings or changing identities', () => {
  const database = legacyDatabase();
  try {
    const before = snapshot(database);
    const originalReview = database.prepare('SELECT * FROM reviews').get()!;
    const originalPost = database.prepare('SELECT * FROM posts').get()!;
    migrate(database);
    assert.deepEqual(snapshot(database), before);
    assert.deepEqual({ ...database.prepare('SELECT * FROM reviews').get() }, { ...originalReview, communication_rating: null, quality_rating: null });
    assert.deepEqual({ ...database.prepare('SELECT * FROM posts').get() }, { ...originalPost, project_id: null });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM users WHERE email_verified_at IS NOT created_at').get()!.count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM campaigns WHERE payment_mode <> 'demo'").get()!.count, 0);
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()!.count, migrations.length);
    for (const table of ['user_follows', 'project_follows', 'organization_invitations', 'project_tasks']) {
      assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count, 0);
    }
    migrate(database);
    assert.deepEqual(snapshot(database), before);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()!.count, migrations.length);
  } finally { database.close(); }
});

test('a failed migration rolls back every added column and leaves legacy records intact', () => {
  const database = legacyDatabase();
  try {
    const before = snapshot(database);
    database.exec('CREATE TABLE user_follows (incompatible_column TEXT)');
    assert.throws(() => migrate(database), /already exists/);
    assert.ok(!columns(database, 'posts').includes('project_id'));
    assert.ok(!columns(database, 'reviews').includes('communication_rating'));
    assert.deepEqual(snapshot(database), before);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()!.count, 0);
    database.exec('DROP TABLE user_follows');
    migrate(database);
    assert.ok(columns(database, 'posts').includes('project_id'));
  } finally { database.close(); }
});

test('unknown database versions and edited migration checksums fail explicitly', () => {
  const database = legacyDatabase();
  try {
    migrate(database);
    const before = snapshot(database);
    database.exec("UPDATE schema_migrations SET checksum='changed'");
    assert.throws(() => migrate(database), /modifiee apres son application/);
    assert.deepEqual(snapshot(database), before);
    database.exec("INSERT INTO schema_migrations(version,name,checksum) VALUES (99,'future','future')");
    assert.throws(() => migrate(database), /Version de base inconnue/);
    assert.deepEqual(snapshot(database), before);
  } finally { database.close(); }
});

test('V2 tables enforce relationship and rating invariants', () => {
  const database = legacyDatabase();
  try {
    migrate(database);
    assert.throws(() => database.exec("INSERT INTO user_follows(follower_id,following_id) VALUES ('owner','owner')"), /CHECK constraint/);
    assert.throws(() => database.exec("INSERT INTO project_follows(user_id,project_id) VALUES ('tester','missing')"), /FOREIGN KEY constraint/);
    assert.throws(() => database.exec("UPDATE reviews SET communication_rating=0"), /CHECK constraint/);
    assert.throws(() => database.exec("UPDATE reviews SET quality_rating=6"), /CHECK constraint/);
    assert.throws(() => database.exec("INSERT INTO project_tasks(id,project_id,creator_id,title,status) VALUES ('task','project','owner','A task','unknown')"), /CHECK constraint/);
    database.exec("INSERT INTO user_follows(follower_id,following_id) VALUES ('tester','owner')");
    assert.throws(() => database.exec("INSERT INTO user_follows(follower_id,following_id) VALUES ('tester','owner')"), /UNIQUE constraint/);
  } finally { database.close(); }
});

test('migration and legacy records survive a database restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'alpha-v2-migration-'));
  const path = join(directory, 'alpha.sqlite');
  try {
    const original = legacyDatabase(path);
    const before = snapshot(original);
    migrate(original);
    original.close();
    const restarted = new DatabaseSync(path);
    try {
      restarted.exec(schema);
      migrate(restarted);
      assert.deepEqual(snapshot(restarted), before);
      assert.equal(restarted.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()!.count, migrations.length);
    } finally { restarted.close(); }
  } finally {
    for (const name of readdirSync(directory)) unlinkSync(join(directory, name));
    rmdirSync(directory);
  }
});

function v2Database() {
  const database = legacyDatabase();
  const sql = readFileSync(new URL('../server/migrations/002-network.sql', import.meta.url), 'utf8');
  database.exec(sql);
  database.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`);
  database.prepare('INSERT INTO schema_migrations(version,name,checksum) VALUES (2,?,?)').run('network', createHash('sha256').update(sql).digest('hex'));
  database.exec(`INSERT INTO listings(id,seller_id,title,description,kind,price_cents,license,deliverables)
    VALUES ('listing','owner','Original terms','Original description','software',1200,'Nonexclusive license','Original deliverables');
    INSERT INTO orders(id,listing_id,buyer_id,seller_id,price_cents,status,delivery_text) VALUES
    ('paid-order','listing','tester','owner',1200,'paid',''),
    ('delivered-order','listing','tester','owner',1200,'delivered','Original private delivery'),
    ('completed-order','listing','tester','owner',1200,'completed','Previously accepted delivery'),
    ('disputed-order','listing','tester','owner',1200,'disputed','Delivery currently disputed');`);
  return database;
}

test('V2 upgrades preserve order terms, deliveries and sessions without inventing historical dates', () => {
  const database = v2Database();
  try {
    const before = snapshot(database);
    const orders = database.prepare('SELECT * FROM orders ORDER BY id').all();
    const oldMigration = database.prepare('SELECT * FROM schema_migrations WHERE version=2').get();
    migrate(database);
    assert.deepEqual(snapshot(database), before);
    assert.deepEqual(database.prepare('SELECT id,listing_id,buyer_id,seller_id,price_cents,status,delivery_text,created_at FROM orders ORDER BY id').all(), orders);
    assert.deepEqual(database.prepare('SELECT * FROM schema_migrations WHERE version=2').get(), oldMigration);
    const session = database.prepare('SELECT public_id,created_at FROM sessions').get()!;
    assert.match(String(session.public_id), /^[a-f0-9]{32}$/);
    assert.equal(session.created_at, null);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM orders WHERE version=1 AND revision_requested=0').get()!.count, 4);
    const history = database.prepare('SELECT * FROM order_events ORDER BY order_id').all();
    assert.equal(history.length, 3);
    for (const event of history) {
      assert.equal(event.created_at, null);
      assert.equal(event.kind, 'legacy_delivery');
      assert.equal(event.order_version, 1);
      assert.equal(event.body, orders.find((order) => order.id === event.order_id)!.delivery_text);
    }
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    assert.throws(() => database.exec("INSERT INTO bookmarks(user_id,target_type,target_id) VALUES ('owner','session','x')"), /CHECK constraint/);
    assert.throws(() => database.exec('UPDATE orders SET version=0'), /CHECK constraint/);
    migrate(database);
    assert.deepEqual(database.prepare('SELECT * FROM order_events ORDER BY order_id').all(), history);
    assert.equal(database.prepare('SELECT public_id FROM sessions').get()!.public_id, session.public_id);
  } finally { database.close(); }
});

test('failed V3 migration retains V2 schema, checksums and data atomically', () => {
  const database = v2Database();
  try {
    const before = snapshot(database);
    const applied = database.prepare('SELECT * FROM schema_migrations').all();
    database.exec('CREATE TABLE order_events(conflicting_column TEXT)');
    assert.throws(() => migrate(database), /already exists/);
    assert.deepEqual(snapshot(database), before);
    assert.deepEqual(database.prepare('SELECT * FROM schema_migrations').all(), applied);
    assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE name='bookmarks'").get(), undefined);
    assert.ok(!database.prepare('PRAGMA table_info(orders)').all().some((column) => column.name === 'version'));
    database.exec('DROP TABLE order_events');
    migrate(database);
    assert.equal(database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()!.version, latestSchemaVersion);
  } finally { database.close(); }
});
