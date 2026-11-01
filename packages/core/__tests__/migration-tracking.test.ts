/** TD-032: tracked migrations: fresh DB, bootstrap of an untracked DB, edit refusal, run-once data migration. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  runMigrations,
  MigrationIntegrityError,
  MIGRATION_BOOTSTRAP_LAST,
} from '../src/db/client.js';
import type { DatabaseClient } from '../src/db/client.js';

const realDir = path.join(__dirname, '..', 'drizzle');
let tmp: string;
let sqlite: Database.Database;
let db: DatabaseClient;

const rows = (sql: string): Record<string, unknown>[] =>
  sqlite.prepare(sql).all() as Record<string, unknown>[];
const recorded = (): string[] =>
  rows('SELECT filename FROM schema_migrations ORDER BY filename').map(r => String(r['filename']));

/** Copy the real migrations into a temp dir so tests can add/edit files. */
function copyMigrations(): string {
  const dir = path.join(tmp, 'drizzle');
  fs.mkdirSync(dir);
  for (const f of fs.readdirSync(realDir).filter(f => f.endsWith('.sql'))) {
    fs.copyFileSync(path.join(realDir, f), path.join(dir, f));
  }
  return dir;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'amb-mig-'));
  sqlite = new Database(':memory:');
  db = drizzle(sqlite) as unknown as DatabaseClient;
});
afterEach(() => {
  sqlite.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('migration tracking (TD-032)', () => {
  it('fresh DB: applies everything, records every file with a sha256, and is a no-op on re-run', async () => {
    const dir = copyMigrations();
    await runMigrations(db, { migrationsDir: dir });
    const files = fs
      .readdirSync(dir)
      .filter(f => f.endsWith('.sql'))
      .sort();
    expect(recorded()).toEqual(files);
    for (const r of rows('SELECT sha256, applied_at FROM schema_migrations')) {
      expect(String(r['sha256'])).toMatch(/^[0-9a-f]{64}$/);
      expect(r['applied_at']).toBeTruthy();
    }
    const before = rows('SELECT * FROM schema_migrations ORDER BY filename');
    await runMigrations(db, { migrationsDir: dir });
    expect(rows('SELECT * FROM schema_migrations ORDER BY filename')).toEqual(before);
  });

  it('existing untracked DB (already at 0003 with data): bootstraps and records 0000..0003 without touching data', async () => {
    const dir = copyMigrations();
    // Simulate the pre-TD-032 world: every file applied by the old runner, no tracking table, real data.
    for (const f of fs
      .readdirSync(dir)
      .filter(f => f.endsWith('.sql'))
      .sort()) {
      for (const st of fs
        .readFileSync(path.join(dir, f), 'utf-8')
        .split(/-->\s*statement-breakpoint/)) {
        if (st.trim()) sqlite.exec(st);
      }
    }
    sqlite.exec(
      "INSERT INTO oauth_clients (client_id, client_name, redirect_uris, registered_via, created_at) VALUES ('keep-me','n','[]','admin','t')"
    );
    expect(rows("SELECT name FROM sqlite_master WHERE name='schema_migrations'")).toHaveLength(0);

    await runMigrations(db, { migrationsDir: dir });
    expect(recorded()).toContain(MIGRATION_BOOTSTRAP_LAST);
    expect(rows("SELECT client_id FROM oauth_clients WHERE client_id='keep-me'")).toHaveLength(1);
  });

  it('refuses to start when an applied migration file was edited', async () => {
    const dir = copyMigrations();
    await runMigrations(db, { migrationsDir: dir });
    fs.appendFileSync(path.join(dir, '0001_adr014_oauth.sql'), '\n-- sneaky edit\n');
    await expect(runMigrations(db, { migrationsDir: dir })).rejects.toBeInstanceOf(
      MigrationIntegrityError
    );
    await expect(runMigrations(db, { migrationsDir: dir })).rejects.toThrow(
      /0001_adr014_oauth\.sql was modified after it was applied/
    );
  });

  it('a data migration after 0003 runs exactly once, atomically, with no already-exists tolerance', async () => {
    const dir = copyMigrations();
    await runMigrations(db, { migrationsDir: dir });
    fs.writeFileSync(
      path.join(dir, '0004_test_data.sql'),
      'CREATE TABLE tmp_counter (n integer NOT NULL);\n--> statement-breakpoint\nINSERT INTO tmp_counter (n) VALUES (1);\n'
    );
    await runMigrations(db, { migrationsDir: dir });
    await runMigrations(db, { migrationsDir: dir });
    await runMigrations(db, { migrationsDir: dir });
    expect(rows('SELECT n FROM tmp_counter')).toHaveLength(1);
    expect(recorded()).toContain('0004_test_data.sql');

    // A failing later migration rolls back fully and is not recorded; re-running fails again (no tolerance).
    fs.writeFileSync(
      path.join(dir, '0005_bad.sql'),
      'CREATE TABLE half_done (x integer);\n--> statement-breakpoint\nALTER TABLE tmp_counter ADD COLUMN n integer;\n'
    );
    await expect(runMigrations(db, { migrationsDir: dir })).rejects.toThrow();
    expect(recorded()).not.toContain('0005_bad.sql');
    expect(rows("SELECT name FROM sqlite_master WHERE name='half_done'")).toHaveLength(0);
    await expect(runMigrations(db, { migrationsDir: dir })).rejects.toThrow();
  });
});
