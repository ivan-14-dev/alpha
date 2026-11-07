import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

test('fresh V3 demo data is coherent and cannot overwrite an existing installation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'alpha-seed-'));
  const filename = join(directory, 'demo.sqlite');
  const environment: NodeJS.ProcessEnv = { ...process.env, DATABASE_PATH: filename };
  delete environment.DEMO_PASSWORD;
  const seed = () => spawnSync(process.execPath, ['--import', 'tsx', 'server/seed.ts'], {
    env: environment,
    encoding: 'utf8', timeout: 30000,
  });
  let database: DatabaseSync | undefined;
  try {
    const result = seed();
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    database = new DatabaseSync(filename);
    const count = (sql: string) => Number(database!.prepare(sql).get()!.count);
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(count('SELECT COUNT(*) AS count FROM users'), 6);
    assert.equal(count('SELECT COUNT(*) AS count FROM schema_migrations WHERE version=2'), 1);
    assert.equal(count('SELECT COUNT(*) AS count FROM schema_migrations WHERE version=3'), 1);
    assert.equal(count('SELECT COUNT(*) AS count FROM bookmarks'), 3);
    assert.equal(count("SELECT COUNT(*) AS count FROM orders WHERE version=3 AND revision_requested=1 AND status='paid'"), 1);
    assert.equal(count('SELECT COUNT(*) AS count FROM order_events'), 3);
    assert.equal(count("SELECT COUNT(*) AS count FROM transactions WHERE kind='sale'"), 0);
    assert.equal(count('SELECT COUNT(*) AS count FROM user_follows'), 3);
    assert.equal(count('SELECT COUNT(*) AS count FROM project_follows'), 2);
    assert.equal(count('SELECT COUNT(*) AS count FROM posts WHERE project_id IS NOT NULL'), 1);
    assert.equal(count('SELECT COUNT(*) AS count FROM project_tasks'), 3);
    assert.equal(count('SELECT COUNT(DISTINCT status) AS count FROM project_tasks'), 3);
    assert.equal(count(`SELECT COUNT(*) AS count FROM project_tasks t JOIN projects p ON p.id=t.project_id
      WHERE t.assignee_id != p.owner_id AND NOT EXISTS (
        SELECT 1 FROM organization_members m WHERE m.organization_id=p.organization_id AND m.user_id=t.assignee_id
      )`), 0);
    assert.equal(count("SELECT COUNT(*) AS count FROM organization_invitations WHERE status='pending'"), 1);
    assert.equal(count(`SELECT COUNT(*) AS count FROM organization_invitations i JOIN organization_members m
      ON m.organization_id=i.organization_id AND m.user_id=i.invitee_id`), 0);
    assert.equal(count('SELECT COUNT(*) AS count FROM reviews WHERE communication_rating=5 AND quality_rating=4'), 1);
    assert.equal(count("SELECT COUNT(*) AS count FROM transactions WHERE mode != 'demo'"), 0);
    const originalUsers = database.prepare('SELECT * FROM users ORDER BY id').all();
    const retry = seed();
    assert.notEqual(retry.status, 0);
    assert.match(retry.stderr, /base contient deja des comptes/);
    assert.deepEqual(database.prepare('SELECT * FROM users ORDER BY id').all(), originalUsers);
    assert.equal(count('SELECT COUNT(*) AS count FROM project_tasks'), 3);
  } finally {
    database?.close();
    for (const file of readdirSync(directory)) unlinkSync(join(directory, file));
    rmdirSync(directory);
  }
});
