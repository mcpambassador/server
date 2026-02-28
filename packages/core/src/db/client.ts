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
/* eslint-disable no-console */

import { drizzle as drizzleSqlite, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { drizzle as drizzlePostgres, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import Database from 'better-sqlite3';
import postgres from 'postgres';
import * as schema from '../schema/index.js';
import { seedDatabase } from '../schema/seed.js';
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
    console.log(`[db] SQLite file permissions set to 0600: ${filePath}`);
  } catch (err) {
    console.warn(`[db] Could not set file permissions on ${filePath}:`, err);
  }

  // Enable WAL mode for better concurrency
  if (config.enableWAL !== false) {
    sqlite.pragma('journal_mode = WAL');
    console.log('[db] SQLite WAL mode enabled');
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

  console.log(`[db] SQLite initialized: ${filePath}`);

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
    console.log('[db] PostgreSQL connection successful');
  } catch (err) {
    console.error('[db] PostgreSQL connection failed:', err);
    throw err;
  }

  // Create Drizzle client
  const db = drizzlePostgres(sql, { schema });

  console.log('[db] PostgreSQL initialized');

  return db;
}

/**
 * Run database migrations
 *
 * Applies all pending migrations from packages/core/drizzle/
 * Executes .sql files in lexicographic order.
 *
 * @param db Database client
 */
export async function runMigrations(db: DatabaseClient): Promise<void> {
  console.log('[db] Running migrations...');

  // ES module compatibility: __dirname replacement
  const currentFileUrl = new URL(import.meta.url);
  const currentDir = path.dirname(currentFileUrl.pathname);
  const migrationsDir = path.join(currentDir, '../../drizzle');

  // Check if migrations directory exists
  if (!fs.existsSync(migrationsDir)) {
    console.warn(`[db] Migrations directory not found: ${migrationsDir}`);
    return;
  }

  // Read migration files (*.sql) in sorted order
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f: string) => f.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    console.log('[db] No migration files found');
    return;
  }

  // Execute each migration file
  for (const file of files) {
    const filePath = path.join(migrationsDir, file);
    const sqlContent = fs.readFileSync(filePath, 'utf-8');

    console.log(`[db] Running migration: ${file}`);

    try {
      // Execute raw SQL content (migrations contain full DDL statements)
      // Note: For production, consider using drizzle-kit migrate() instead
      if ((db as any).session?.client?.exec) {
        // SQLite: use underlying better-sqlite3 exec() via session.client
        (db as any).session.client.exec(sqlContent);
      } else if ((db as any).session?.client?.unsafe) {
        // PostgreSQL: use postgres.js unsafe() for raw SQL
        await (db as any).session.client.unsafe(sqlContent);
      } else {
        // Fallback
        await (db as any).execute(sqlContent);
      }
      console.log(`[db] ✓ Migration complete: ${file}`);
    } catch (err) {
      console.error(`[db] ✗ Migration failed: ${file}`, err);
      throw err;
    }
  }

  console.log(`[db] All migrations complete (${files.length} files)`);
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
      console.log('[db] SQLite connection closed');
    } else if ((db as any).session?.client?.end) {
      await (db as any).session.client.end();
      console.log('[db] PostgreSQL connection closed');
    }
  } catch (err) {
    console.warn('[db] Error closing database connection:', err);
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
    console.error('[db] Health check failed:', err);
    return false;
  }
}
