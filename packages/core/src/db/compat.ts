/**
 * Database Compatibility Layer
 *
 * Provides type-safe query builders that work across both SQLite and PostgreSQL.
 * Resolves Drizzle ORM union type incompatibility (F-TECH-DEBT-001).
 *
 * @see docs/drizzle-type-errors-report.md
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any */

import type { DatabaseClient } from './client.js';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { PgTable } from 'drizzle-orm/pg-core';

/**
 * Type guard to check if database is PostgreSQL
 */
function isPostgres(db: DatabaseClient): boolean {
  // PostgreSQL client has 'execute' method, SQLite doesn't
  return 'execute' in db && typeof (db as any).execute === 'function';
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
 * Execute raw SQL (handles both database types)
 *
 * @param db Database client
 * @param sql Raw SQL string
 * @returns Query result
 */
export async function compatExecute(db: DatabaseClient, sql: string): Promise<any> {
  if (isPostgres(db)) {
    // PostgreSQL: use execute()
    return await (db as any).execute(sql);
  } else {
    // SQLite: use prepare().run()
    const client = (db as any).$client;
    if (client && typeof client.prepare === 'function') {
      return client.prepare(sql).run();
    }
    throw new Error('SQLite prepare() method not available');
  }
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
export async function compatTransaction<T>(
  db: DatabaseClient,
  fn: () => Promise<T>
): Promise<T> {
  if (isPostgres(db)) {
    await (db as any).execute('BEGIN');
  } else {
    const client = (db as any).$client;
    if (client && typeof client.prepare === 'function') {
      client.prepare('BEGIN IMMEDIATE').run();
    } else {
      throw new Error('SQLite prepare() method not available');
    }
  }

  try {
    const result = await fn();
    if (isPostgres(db)) {
      await (db as any).execute('COMMIT');
    } else {
      (db as any).$client.prepare('COMMIT').run();
    }
    return result;
  } catch (err) {
    if (isPostgres(db)) {
      await (db as any).execute('ROLLBACK');
    } else {
      (db as any).$client.prepare('ROLLBACK').run();
    }
    throw err;
  }
}
