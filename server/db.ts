import './config.js';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { migrate } from './migrations.js';
import { log } from './platform/log.js';

const filename = process.env.DATABASE_PATH ?? './data/alpha.sqlite';
if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
export const db = new DatabaseSync(filename);
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
migrate(db);

export function all<T>(sql: string, ...params: SQLInputValue[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function one<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function run(sql: string, ...params: SQLInputValue[]) {
  return db.prepare(sql).run(...params);
}

let depth = 0;
type Deferred = () => void;
/** One queue per open transaction level; savepoint queues merge into their parent on RELEASE. */
const deferredStack: Deferred[][] = [];

/** True while a `transaction()` callback is executing. */
export function inTransaction(): boolean { return depth > 0; }

/**
 * Runs `work` once the outermost transaction COMMITs (immediately if none is open).
 * Discarded when the enclosing transaction or savepoint rolls back.
 */
export function onCommit(work: Deferred) {
  if (depth === 0) {
    try { work(); } catch (error) { log.error('on_commit.failed', { error }); }
  } else deferredStack[deferredStack.length - 1].push(work);
}

function assertSynchronous(result: unknown) {
  if (result && typeof (result as { then?: unknown }).then === 'function') {
    throw new Error('transaction() exige un traitement synchrone : effectuez les appels asynchrones avant ou apres la transaction.');
  }
}

/** Serializable write transaction. Nested calls use SAVEPOINTs so modules compose safely. */
export function transaction<T>(work: () => T): T {
  if (depth > 0) {
    const savepoint = `alpha_sp_${depth}`;
    db.exec(`SAVEPOINT ${savepoint}`);
    depth += 1;
    deferredStack.push([]);
    try {
      const result = work();
      assertSynchronous(result);
      db.exec(`RELEASE ${savepoint}`);
      const released = deferredStack.pop()!;
      deferredStack[deferredStack.length - 1].push(...released);
      return result;
    } catch (error) {
      deferredStack.pop();
      db.exec(`ROLLBACK TO ${savepoint}`);
      db.exec(`RELEASE ${savepoint}`);
      throw error;
    } finally {
      depth -= 1;
    }
  }
  db.exec('BEGIN IMMEDIATE');
  depth += 1;
  deferredStack.push([]);
  let committed: Deferred[] = [];
  try {
    const result = work();
    assertSynchronous(result);
    db.exec('COMMIT');
    committed = deferredStack.pop()!;
    return result;
  } catch (error) {
    deferredStack.pop();
    db.exec('ROLLBACK');
    throw error;
  } finally {
    depth -= 1;
    for (const callback of committed) {
      try { callback(); } catch (error) { log.error('on_commit.failed', { error }); }
    }
  }
}
