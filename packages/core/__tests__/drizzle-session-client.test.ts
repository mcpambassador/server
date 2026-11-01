/**
 * TD-019: db/client.ts reaches the raw driver through `db.session.client` (an undocumented drizzle
 * internal) for health checks, migrations, close and the PRAGMA/transaction helpers. This pins that
 * the handle still resolves on the pinned drizzle-orm, for both SQLite and the Postgres driver.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import {
  initializeDatabase,
  runMigrations,
  checkDatabaseHealth,
  closeDatabase,
} from '../src/db/client.js';
import type { DatabaseClient } from '../src/db/client.js';

describe('drizzle session.client handle', () => {
  it('SQLite: session.client is the better-sqlite3 Database instance', () => {
    const raw = new Database(':memory:');
    const db = drizzle(raw);
    const client = (db as unknown as { session?: { client?: unknown } }).session?.client;
    expect(client).toBe(raw);
    expect(typeof (client as Database.Database).prepare).toBe('function');
    raw.close();
  });

  it('SQLite: initializeDatabase → migrate → health → data round trip → close', async () => {
    const db = await initializeDatabase({ type: 'sqlite', sqliteFilePath: ':memory:' });
    const client = (db as unknown as { session: { client: Database.Database } }).session.client;
    expect(client.open).toBe(true);
    await runMigrations(db);
    expect(await checkDatabaseHealth(db)).toBe(true);
    const rows = client.prepare('SELECT filename FROM schema_migrations').all();
    expect(rows.length).toBeGreaterThan(0);
    // drizzle query layer and raw handle see the same connection
    const viaDrizzle = (db as ReturnType<typeof drizzle>).all(sql`SELECT 1 AS one`);
    expect(viaDrizzle).toEqual([{ one: 1 }]);
    await closeDatabase(db);
    expect(client.open).toBe(false);
  });

  it('Postgres: session.client is the postgres-js sql handle (unsafe/end) without connecting', async () => {
    const pg = postgres('postgresql://u:p@127.0.0.1:1/none', { max: 1 });
    const db = drizzlePg(pg) as unknown as DatabaseClient;
    const client = (db as unknown as { session?: { client?: unknown } }).session?.client;
    expect(client).toBe(pg);
    expect(typeof (client as { unsafe: unknown }).unsafe).toBe('function');
    expect(typeof (client as { end: unknown }).end).toBe('function');
    await pg.end({ timeout: 0 });
  });
});
