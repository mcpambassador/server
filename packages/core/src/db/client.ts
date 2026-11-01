/**
 * Database Client Setup
 *
 * Initializes Drizzle ORM with SQLite (Community) or PostgreSQL (Pro/Enterprise).
 * Handles connection pooling, file permissions, and database initialization.
 *
 * @see Architecture §6 Configuration & Secrets Management
 * @see dev-plan.md M1 Database Schema Design
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any */

import { drizzle as drizzleSqlite, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { logger } from '../utils/logger.js';
import { drizzle as drizzlePostgres, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import Database from 'better-sqlite3';
import postgres from 'postgres';
import * as schema from '../schema/index.js';
import { seedDatabase } from '../schema/seed.js';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export type DatabaseClient =
  | BetterSQLite3Database<typeof schema>
  | PostgresJsDatabase<typeof schema>;

export interface DatabaseConfig {
  type: 'sqlite' | 'postgres';

  // SQLite config
  sqliteFilePath?: string; // e.g., /data/ambassador.db

  // PostgreSQL config
  postgresUrl?: string; // e.g., postgresql://user:pass@host:5432/dbname
  postgresPoolSize?: number;

  // Common config
  enableWAL?: boolean; // SQLite Write-Ahead Logging (better concurrency)
  seedOnInit?: boolean; // Insert default profiles on first run
}

/**
 * Initialize database connection and schema
 *
 * @param config Database configuration
 * @returns Drizzle database client
 */
export async function initializeDatabase(config: DatabaseConfig): Promise<DatabaseClient> {
  if (config.type === 'sqlite') {
    return initializeSQLite(config);
  } else {
    return initializePostgres(config);
  }
}

/**
 * Initialize SQLite database (Community tier)
 */
function initializeSQLite(config: DatabaseConfig): BetterSQLite3Database<typeof schema> {
  const filePath = config.sqliteFilePath || './data/ambassador.db';

  // Ensure directory exists
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); // drwx------ (owner only)
  }

  // Create SQLite connection
  const sqlite = new Database(filePath);

  // Set file permissions to 0600 (owner read/write only) - Security requirement F-021
  try {
    fs.chmodSync(filePath, 0o600);
    logger.info({ file_path: filePath }, '[db] SQLite file permissions set to 0600');
  } catch (err) {
    logger.warn({ file_path: filePath, err }, '[db] Could not set file permissions');
  }

  // Enable WAL mode for better concurrency
  if (config.enableWAL !== false) {
    sqlite.pragma('journal_mode = WAL');
    logger.info('[db] SQLite WAL mode enabled');
  }

  // Enable foreign keys (SQLite default is OFF)
  sqlite.pragma('foreign_keys = ON');

  // Performance tuning for write-heavy workload
  sqlite.pragma('busy_timeout = 5000'); // Wait 5s on SQLITE_BUSY
  sqlite.pragma('synchronous = NORMAL'); // WAL mode allows NORMAL (faster writes)
  sqlite.pragma('cache_size = -64000'); // 64MB cache (default ~2MB)
  sqlite.pragma('temp_store = MEMORY'); // Temp tables in RAM

  // Create Drizzle client
  const db = drizzleSqlite(sqlite, { schema });

  logger.info({ file_path: filePath }, '[db] SQLite initialized');

  return db;
}

/**
 * Initialize PostgreSQL database (Pro/Enterprise tier)
 */
async function initializePostgres(
  config: DatabaseConfig
): Promise<PostgresJsDatabase<typeof schema>> {
  if (!config.postgresUrl) {
    throw new Error('[db] PostgreSQL URL is required for postgres database type');
  }

  // Create PostgreSQL connection pool
  const sql = postgres(config.postgresUrl, {
    max: config.postgresPoolSize || 10,
    idle_timeout: 20,
    connect_timeout: 10,
  });

  // Test connection
  try {
    await sql`SELECT 1`;
    logger.info('[db] PostgreSQL connection successful');
  } catch (err) {
    logger.error({ err }, '[db] PostgreSQL connection failed');
    throw err;
  }

  // Create Drizzle client
  const db = drizzlePostgres(sql, { schema });

  logger.info('[db] PostgreSQL initialized');

  return db;
}

/** Thrown when a recorded migration file no longer matches the hash stored when it was applied. */
export class MigrationIntegrityError extends Error {
  constructor(
    public readonly file: string,
    public readonly recordedSha256: string,
    public readonly currentSha256: string
  ) {
    super(
      `[db] Migration ${file} was modified after it was applied (recorded sha256 ${recordedSha256.slice(0, 12)}, ` +
        `current ${currentSha256.slice(0, 12)}). Refusing to start. Never edit an applied migration; add a new one.`
    );
    this.name = 'MigrationIntegrityError';
  }
}

/**
 * Last migration that predates tracking (TD-032). Databases without a schema_migrations table are
 * bootstrapped by running 0000..this file with the legacy idempotent behaviour (they were re-run at
 * every start, so ADD COLUMN tolerates "duplicate column name"), then recording them. Files after
 * this one are applied exactly once with NO tolerance.
 */
export const MIGRATION_BOOTSTRAP_LAST = '0003_agent_grant_kind.sql';

export interface RunMigrationsOptions {
  /** Override the migrations directory (tests). */
  migrationsDir?: string;
}

interface SqlRunner {
  /** Run `fn` in one transaction: commit on success, roll back on throw. */
  transaction(fn: (tx: SqlExec) => Promise<void>): Promise<void>;
  exec: SqlExec['exec'];
  all: SqlExec['all'];
}
interface SqlExec {
  exec(statement: string, params?: unknown[]): Promise<void>;
  all(statement: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
}

function makeRunner(db: DatabaseClient): SqlRunner {
  const client = (db as any).session?.client;
  if (client?.exec && client?.prepare) {
    // SQLite (better-sqlite3): DDL is transactional.
    const exec: SqlExec = {
      exec: (st, params) => {
        if (params && params.length > 0) client.prepare(st).run(...params);
        else client.exec(st);
        return Promise.resolve();
      },
      all: (st, params = []) =>
        Promise.resolve(client.prepare(st).all(...params) as Record<string, unknown>[]),
    };
    return {
      ...exec,
      transaction: async fn => {
        client.exec('BEGIN');
        try {
          await fn(exec);
          client.exec('COMMIT');
        } catch (err) {
          if (client.inTransaction) client.exec('ROLLBACK');
          throw err;
        }
      },
    };
  }
  if (client?.unsafe) {
    // PostgreSQL (postgres.js)
    const wrap = (c: any): SqlExec => ({
      exec: async (st, params) => {
        await c.unsafe(st, (params ?? []) as never[]);
      },
      all: async (st, params = []) =>
        (await c.unsafe(st, params as never[])) as Record<string, unknown>[],
    });
    return {
      ...wrap(client),
      transaction: async fn => {
        await client.begin(async (tx: any) => {
          await fn(wrap(tx));
        });
      },
    };
  }
  throw new Error('[db] Unsupported database client for migrations');
}

const sha256 = (text: string): string =>
  // Normalise line endings so a CRLF checkout (autocrlf) does not look like an edit.
  crypto.createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');

function splitStatements(sqlContent: string): string[] {
  return sqlContent
    .split(/-->\s*statement-breakpoint/)
    .map((st: string) => st.trim())
    .filter((st: string) => st.length > 0);
}

async function runStatements(tx: SqlExec, sqlContent: string, tolerant: boolean): Promise<void> {
  for (const statement of splitStatements(sqlContent)) {
    try {
      await tx.exec(statement);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        tolerant &&
        /duplicate column name|already exists/i.test(msg) &&
        /ADD COLUMN/i.test(statement)
      ) {
        continue;
      }
      throw err;
    }
  }
}

/**
 * Run database migrations (TD-032: tracked).
 *
 * - `schema_migrations(filename PK, sha256, applied_at)` records every applied file.
 * - No table yet (fresh DB or a pre-tracking DB): bootstrap 0000..MIGRATION_BOOTSTRAP_LAST the legacy
 *   idempotent way, create the table and record them, all in ONE transaction (a crash leaves no table).
 * - Afterwards only unrecorded files are applied, each in its own transaction together with its record.
 *   No "already exists" tolerance for those.
 * - A recorded file whose hash changed refuses startup (MigrationIntegrityError).
 *
 * @param db Database client
 */
export async function runMigrations(
  db: DatabaseClient,
  options: RunMigrationsOptions = {}
): Promise<void> {
  logger.info('[db] Running migrations...');

  // ES module compatibility: __dirname replacement
  const currentFileUrl = new URL(import.meta.url);
  const currentDir = path.dirname(currentFileUrl.pathname);
  const migrationsDir = options.migrationsDir ?? path.join(currentDir, '../../drizzle');

  if (!fs.existsSync(migrationsDir)) {
    logger.warn({ migrations_dir: migrationsDir }, '[db] Migrations directory not found');
    return;
  }

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f: string) => f.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    logger.info('[db] No migration files found');
    return;
  }

  const read = (file: string): { content: string; hash: string } => {
    const content = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    return { content, hash: sha256(content) };
  };
  const now = (): string => new Date().toISOString();
  const runner = makeRunner(db);
  const isSqlite = Boolean((db as any).session?.client?.prepare);
  const tableExistsSql = isSqlite
    ? "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'"
    : "SELECT to_regclass('schema_migrations') AS name";
  const createTableSql =
    'CREATE TABLE schema_migrations (filename TEXT PRIMARY KEY NOT NULL, sha256 TEXT NOT NULL, applied_at TEXT NOT NULL)';
  const insertSql = isSqlite
    ? 'INSERT INTO schema_migrations (filename, sha256, applied_at) VALUES (?, ?, ?)'
    : 'INSERT INTO schema_migrations (filename, sha256, applied_at) VALUES ($1, $2, $3)';

  const tableRows = await runner.all(tableExistsSql);
  const tracked = tableRows.length > 0 && tableRows[0] && tableRows[0]['name'] != null;

  if (!tracked) {
    const bootstrapFiles = files.filter(f => f <= MIGRATION_BOOTSTRAP_LAST);
    logger.info({ files: bootstrapFiles.length }, '[db] Bootstrapping migration tracking');
    await runner.transaction(async tx => {
      for (const file of bootstrapFiles) {
        const { content } = read(file);
        logger.info({ file }, '[db] Running migration (bootstrap)');
        try {
          await runStatements(tx, content, true);
        } catch (err) {
          logger.error({ file, err }, '[db] Migration failed');
          throw err;
        }
      }
      await tx.exec(createTableSql);
      for (const file of bootstrapFiles) {
        await tx.exec(insertSql, [file, read(file).hash, now()]);
      }
    });
  }

  const recorded = new Map<string, string>(
    (await runner.all('SELECT filename, sha256 FROM schema_migrations')).map(r => [
      String(r['filename']),
      String(r['sha256']),
    ])
  );

  // Integrity first, so an edited migration stops the server before anything new is applied.
  for (const [file, recordedHash] of recorded) {
    if (!files.includes(file)) {
      logger.warn({ file }, '[db] Recorded migration file is missing on disk');
      continue;
    }
    const { hash } = read(file);
    if (hash !== recordedHash) {
      logger.error({ file }, '[db] Applied migration file was modified');
      throw new MigrationIntegrityError(file, recordedHash, hash);
    }
  }

  let applied = 0;
  for (const file of files) {
    if (recorded.has(file)) continue;
    const { content, hash } = read(file);
    logger.info({ file }, '[db] Running migration');
    try {
      await runner.transaction(async tx => {
        await runStatements(tx, content, false);
        await tx.exec(insertSql, [file, hash, now()]);
      });
    } catch (err) {
      logger.error({ file, err }, '[db] Migration failed');
      throw err;
    }
    applied++;
  }

  logger.info({ file_count: files.length, applied }, '[db] All migrations complete');
}

/**
 * Seed database with default data
 *
 * @param db Database client
 */
export async function seedDatabaseIfNeeded(
  db: DatabaseClient,
  config: DatabaseConfig
): Promise<void> {
  if (config.seedOnInit !== false) {
    await seedDatabase(db as any);
  }
}

/**
 * Close database connection
 *
 * @param db Database client
 */
export async function closeDatabase(db: DatabaseClient): Promise<void> {
  // Drizzle doesn't expose close() directly - access underlying connection
  // SQLite: db.$client.close()
  // PostgreSQL: await db.$client.end()

  try {
    if ((db as any).session?.client?.close) {
      (db as any).session.client.close();
      logger.info('[db] SQLite connection closed');
    } else if ((db as any).session?.client?.end) {
      await (db as any).session.client.end();
      logger.info('[db] PostgreSQL connection closed');
    }
  } catch (err) {
    logger.warn({ err }, '[db] Error closing database connection');
  }
}

/**
 * Health check - verify database connectivity
 *
 * @param db Database client
 * @returns true if healthy, false otherwise
 */
export async function checkDatabaseHealth(db: DatabaseClient): Promise<boolean> {
  try {
    // Simple query to verify connection - handle both database types
    const client = (db as any).session?.client;
    if (client?.prepare) {
      // SQLite: use prepare().run() via session.client
      client.prepare('SELECT 1').run();
    } else if (client?.unsafe) {
      // PostgreSQL: use unsafe() via session.client
      await client.unsafe('SELECT 1');
    } else {
      // Fallback
      await (db as any).execute('SELECT 1' as any);
    }
    return true;
  } catch (err) {
    logger.error({ err }, '[db] Health check failed');
    return false;
  }
}
