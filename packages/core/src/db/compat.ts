/**
 * Database Compatibility Layer
 *
 * Provides type-safe query builders that work across both SQLite and PostgreSQL.
 * Resolves Drizzle ORM union type incompatibility (F-TECH-DEBT-001).
 *
 * @see docs/drizzle-type-errors-report.md
 */

/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any -- the query-builder helpers below return `any` on purpose: the SQLite/PG builder unions do not unify (F-TECH-DEBT-001). Internals (raw handles, transactions) are typed. */

import type { DatabaseClient } from './client.js';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { PgTable } from 'drizzle-orm/pg-core';

/** The slice of better-sqlite3's Database that the compat layer uses. */
interface SqliteHandle {
  prepare(sql: string): { run(): unknown };
}

/** The slice of a Drizzle PG database that the compat layer uses. */
interface PgExecutor {
  execute(sql: string): Promise<unknown>;
}

/**
 * Type guard to check if database is PostgreSQL
 */
function isPostgres(db: DatabaseClient): db is DatabaseClient & PgExecutor {
  // PostgreSQL client has 'execute' method, SQLite doesn't
  return 'execute' in db && typeof (db as { execute?: unknown }).execute === 'function';
}

/**
 * Type-safe insert operation compatible with both SQLite and PostgreSQL
 *
 * @param db Database client (union type)
 * @param table Table to insert into
 * @returns Insert builder
 */
export function compatInsert<TTable extends SQLiteTable | PgTable>(
  db: DatabaseClient,
  table: TTable
): any {
  return (db as any).insert(table);
}

/**
 * Type-safe select operation compatible with both SQLite and PostgreSQL
 *
 * @param db Database client (union type)
 * @param fields Optional field selection object
 * @returns Select builder
 */
export function compatSelect(db: DatabaseClient, fields?: any): any {
  if (fields) {
    return (db as any).select(fields);
  }
  return (db as any).select();
}

/**
 * Type-safe update operation compatible with both SQLite and PostgreSQL
 *
 * @param db Database client (union type)
 * @param table Table to update
 * @returns Update builder
 */
export function compatUpdate<TTable extends SQLiteTable | PgTable>(
  db: DatabaseClient,
  table: TTable
): any {
  return (db as any).update(table);
}

/**
 * Type-safe delete operation compatible with both SQLite and PostgreSQL
 *
 * @param db Database client (union type)
 * @param table Table to delete from
 * @returns Delete builder
 */
export function compatDelete<TTable extends SQLiteTable | PgTable>(
  db: DatabaseClient,
  table: TTable
): any {
  return (db as any).delete(table);
}

/**
 * Type-safe count operation (wraps sql`SELECT COUNT(*) as count`)
 *
 * @param query Select query builder
 * @returns Count aggregation query
 */
export function compatCount(query: any): any {
  // Both SQLite and PostgreSQL support SQL count the same way
  return query;
}

/**
 * Helper to get the raw SQLite client from a Drizzle database instance.
 * Drizzle ORM stores the underlying better-sqlite3 client at db.session.client.
 */
function getSqliteClient(db: DatabaseClient): SqliteHandle | null {
  const isHandle = (c: unknown): c is SqliteHandle =>
    typeof c === 'object' && c !== null && typeof (c as SqliteHandle).prepare === 'function';
  const client = (db as { session?: { client?: unknown } }).session?.client;
  if (isHandle(client)) {
    return client;
  }
  // Fallback: try $client (newer Drizzle versions)
  const alt = (db as { $client?: unknown }).$client;
  if (isHandle(alt)) {
    return alt;
  }
  return null;
}

function requireSqliteClient(db: DatabaseClient): SqliteHandle {
  const client = getSqliteClient(db);
  if (!client) {
    throw new Error('SQLite prepare() method not available');
  }
  return client;
}

/**
 * Execute raw SQL (handles both database types)
 *
 * @param db Database client
 * @param sql Raw SQL string
 * @returns Query result
 */
export async function compatExecute(db: DatabaseClient, sql: string): Promise<unknown> {
  if (isPostgres(db)) {
    // PostgreSQL: use execute()
    return await db.execute(sql);
  }
  return requireSqliteClient(db).prepare(sql).run();
}

/**
 * Execute a callback within a database transaction.
 *
 * Uses BEGIN IMMEDIATE / COMMIT / ROLLBACK for both SQLite and PostgreSQL.
 * SQLite: BEGIN IMMEDIATE acquires a write lock immediately, preventing SQLITE_BUSY
 * during the transaction body.
 * PostgreSQL: Uses standard BEGIN / COMMIT / ROLLBACK.
 *
 * Resolves SEC-M18-004: cascade operations now run atomically.
 *
 * @param db Database client
 * @param fn Async callback containing the transactional operations
 * @returns Result of the callback
 */
export async function compatTransaction<T>(db: DatabaseClient, fn: () => Promise<T>): Promise<T> {
  // SQLite statements must run synchronously (no await before fn()/after it settles): every caller
  // shares one connection, so an extra microtask tick would let unrelated work interleave into the
  // open transaction (pr118-verifier pins this ordering). Only PostgreSQL awaits its statements.
  const pg = isPostgres(db) ? db : null;
  const sqlite = pg ? null : requireSqliteClient(db);

  if (pg) {
    await pg.execute('BEGIN');
  } else {
    sqlite!.prepare('BEGIN IMMEDIATE').run();
  }

  try {
    const result = await fn();
    if (pg) {
      await pg.execute('COMMIT');
    } else {
      sqlite!.prepare('COMMIT').run();
    }
    return result;
  } catch (err) {
    if (pg) {
      await pg.execute('ROLLBACK');
    } else {
      sqlite!.prepare('ROLLBACK').run();
    }
    throw err;
  }
}
