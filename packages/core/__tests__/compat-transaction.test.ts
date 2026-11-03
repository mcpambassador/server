/**
 * TD-001/TD-003: compatTransaction commits on success and rolls back everything on throw (SQLite),
 * and compatExecute reports a missing driver handle instead of dereferencing null.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { compatExecute, compatTransaction } from '../src/db/compat.js';
import type { DatabaseClient } from '../src/db/client.js';

function makeDb(): { db: DatabaseClient; raw: Database.Database } {
  const raw = new Database(':memory:');
  raw.exec('CREATE TABLE t (v INTEGER NOT NULL)');
  return { db: drizzle(raw) as unknown as DatabaseClient, raw };
}

const count = (raw: Database.Database): number =>
  (raw.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number }).n;

describe('compatTransaction', () => {
  it('commits and returns the callback result', async () => {
    const { db, raw } = makeDb();
    const out = await compatTransaction(db, async () => {
      await compatExecute(db, 'INSERT INTO t VALUES (1)');
      await compatExecute(db, 'INSERT INTO t VALUES (2)');
      return 'done';
    });
    expect(out).toBe('done');
    expect(count(raw)).toBe(2);
    raw.close();
  });

  it('rolls back every write and rethrows when the callback throws', async () => {
    const { db, raw } = makeDb();
    await expect(
      compatTransaction(db, async () => {
        await compatExecute(db, 'INSERT INTO t VALUES (1)');
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(count(raw)).toBe(0);
    raw.close();
  });

  it('throws a clear error when no SQLite handle is reachable', async () => {
    await expect(compatExecute({} as DatabaseClient, 'SELECT 1')).rejects.toThrow(
      'SQLite prepare() method not available'
    );
  });
});
