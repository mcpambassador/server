/** PR #120 verifier tests: file-backed DB shaped like the live untracked one, booted repeatedly. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runMigrations, MigrationIntegrityError } from '../src/db/client.js';
import type { DatabaseClient } from '../src/db/client.js';

const realDir = path.join(__dirname, '..', 'drizzle');
let tmp: string;
let dbFile: string;

const sqlFiles = (dir: string): string[] =>
  fs
    .readdirSync(dir)
    .filter(f => f.endsWith('.sql'))
    .sort();
const sha = (file: string, dir = realDir): string =>
  crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.join(dir, file), 'utf-8').replace(/\r\n/g, '\n'), 'utf8')
    .digest('hex');
const split = (s: string): string[] =>
  s
    .split(/-->\s*statement-breakpoint/)
    .map(x => x.trim())
    .filter(Boolean);

/** One "boot": open the file DB, run migrations, close. Returns the raw handle for inspection. */
async function boot(dir = realDir): Promise<void> {
  const sqlite = new Database(dbFile);
  try {
    await runMigrations(drizzle(sqlite) as unknown as DatabaseClient, { migrationsDir: dir });
  } finally {
    sqlite.close();
  }
}
function peek<T = Record<string, unknown>>(sql: string): T[] {
  const sqlite = new Database(dbFile, { readonly: true });
  try {
    return sqlite.prepare(sql).all() as T[];
  } finally {
    sqlite.close();
  }
}
function legacyApply(dir = realDir): void {
  // The pre-TD-032 runner: every file, statement by statement, tolerant of duplicate columns, no table.
  const sqlite = new Database(dbFile);
  for (const f of sqlFiles(dir)) {
    for (const st of split(fs.readFileSync(path.join(dir, f), 'utf-8'))) {
      try {
        sqlite.exec(st);
      } catch (e) {
        if (!/duplicate column name|already exists/i.test(String(e))) throw e;
      }
    }
  }
  sqlite.close();
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'amb-v120-'));
  dbFile = path.join(tmp, 'a.db');
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('live-shaped untracked DB (copy of a 0000-0003 DB with data)', () => {
  it('first boot records 0000-0003 with independently computed hashes; second boot changes nothing', async () => {
    legacyApply();
    const s = new Database(dbFile);
    const ts = '2026-01-01T00:00:00.000Z';
    s.prepare(
      'INSERT INTO users (user_id, username, display_name, created_at, updated_at) VALUES (?,?,?,?,?)'
    ).run('u1', 'live-user', 'Live', ts, ts);
    s.prepare(
      'INSERT INTO oauth_clients (client_id, client_name, redirect_uris, registered_via, created_at) VALUES (?,?,?,?,?)'
    ).run('c1', 'n', '[]', 'admin', ts);
    s.close();
    expect(peek("SELECT name FROM sqlite_master WHERE name='schema_migrations'")).toHaveLength(0);

    // work on a COPY, as the lead's deploy plan does
    const copy = path.join(tmp, 'copy.db');
    fs.copyFileSync(dbFile, copy);
    dbFile = copy;

    await boot();
    const first = peek<{ filename: string; sha256: string; applied_at: string }>(
      'SELECT * FROM schema_migrations ORDER BY filename'
    );
    expect(first.map(r => r.filename)).toEqual(sqlFiles(realDir));
    for (const r of first) expect(r.sha256).toBe(sha(r.filename));
    const dataBefore = peek('SELECT user_id, username FROM users');
    expect(dataBefore).toEqual([{ user_id: 'u1', username: 'live-user' }]);

    await boot();
    await boot();
    expect(peek('SELECT * FROM schema_migrations ORDER BY filename')).toEqual(first); // same applied_at
    expect(peek('SELECT user_id, username FROM users')).toEqual(dataBefore);
    expect(peek('SELECT client_id FROM oauth_clients')).toEqual([{ client_id: 'c1' }]);
    const cols = peek<{ name: string }>('PRAGMA table_info(agent_grants)');
    expect(cols.filter(c => c.name === 'kind')).toHaveLength(1);
  });

  it('bootstrap of a pre-0003 untracked DB (0000-0002 only) applies 0003 and records all four', async () => {
    const dir = path.join(tmp, 'old');
    fs.mkdirSync(dir);
    for (const f of sqlFiles(realDir).filter(f => f < '0003')) {
      fs.copyFileSync(path.join(realDir, f), path.join(dir, f));
    }
    legacyApply(dir);
    expect(
      peek<{ name: string }>('PRAGMA table_info(agent_grants)').some(c => c.name === 'kind')
    ).toBe(false);
    await boot();
    expect(
      peek<{ name: string }>('PRAGMA table_info(agent_grants)').some(c => c.name === 'kind')
    ).toBe(true);
    expect(peek<{ filename: string }>('SELECT filename FROM schema_migrations').length).toBe(
      sqlFiles(realDir).length
    );
  });
});

describe('failure and integrity semantics', () => {
  it('a failing bootstrap leaves no schema_migrations table and no half-applied schema', async () => {
    const dir = path.join(tmp, 'bad');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, '0000_a.sql'), 'CREATE TABLE a_t (x integer);\n');
    fs.writeFileSync(
      path.join(dir, '0001_b.sql'),
      'CREATE TABLE b_t (x integer);\n--> statement-breakpoint\nNOT VALID SQL;\n'
    );
    await expect(boot(dir)).rejects.toThrow();
    expect(
      peek("SELECT name FROM sqlite_master WHERE name IN ('schema_migrations','a_t','b_t')")
    ).toEqual([]);
  });

  it('an edited applied file stops startup BEFORE any new migration is applied', async () => {
    const dir = path.join(tmp, 'm');
    fs.mkdirSync(dir);
    for (const f of sqlFiles(realDir)) fs.copyFileSync(path.join(realDir, f), path.join(dir, f));
    await boot(dir);
    fs.appendFileSync(path.join(dir, '0002_adr020_agent_endpoint.sql'), '\n-- edit\n');
    fs.writeFileSync(path.join(dir, '0004_new.sql'), 'CREATE TABLE new_t (x integer);\n');
    await expect(boot(dir)).rejects.toBeInstanceOf(MigrationIntegrityError);
    expect(peek("SELECT name FROM sqlite_master WHERE name='new_t'")).toEqual([]);
    expect(
      peek('SELECT filename FROM schema_migrations').map((r: any) => r.filename)
    ).not.toContain('0004_new.sql');
  });

  it('a recorded hash tampered in the table is refused too', async () => {
    await boot();
    const s = new Database(dbFile);
    s.prepare(
      "UPDATE schema_migrations SET sha256='00' WHERE filename='0001_adr014_oauth.sql'"
    ).run();
    s.close();
    await expect(boot()).rejects.toBeInstanceOf(MigrationIntegrityError);
  });

  it('a recorded file that disappeared from disk does not block startup', async () => {
    const dir = path.join(tmp, 'm2');
    fs.mkdirSync(dir);
    for (const f of sqlFiles(realDir)) fs.copyFileSync(path.join(realDir, f), path.join(dir, f));
    await boot(dir);
    fs.rmSync(path.join(dir, '0003_agent_grant_kind.sql'));
    await expect(boot(dir)).resolves.toBeUndefined();
  });

  it('a data migration runs once across many boots; a later failing one rolls back with no record', async () => {
    const dir = path.join(tmp, 'm3');
    fs.mkdirSync(dir);
    for (const f of sqlFiles(realDir)) fs.copyFileSync(path.join(realDir, f), path.join(dir, f));
    await boot(dir);
    fs.writeFileSync(
      path.join(dir, '0004_data.sql'),
      'CREATE TABLE ctr (n integer);\n--> statement-breakpoint\nINSERT INTO ctr VALUES (1);\n--> statement-breakpoint\nUPDATE ctr SET n = n + 10;\n'
    );
    for (let i = 0; i < 4; i++) await boot(dir);
    expect(peek('SELECT n FROM ctr')).toEqual([{ n: 11 }]);

    fs.writeFileSync(
      path.join(dir, '0005_fail.sql'),
      'INSERT INTO ctr VALUES (99);\n--> statement-breakpoint\nINSERT INTO no_such_table VALUES (1);\n'
    );
    await expect(boot(dir)).rejects.toThrow();
    expect(peek('SELECT n FROM ctr')).toEqual([{ n: 11 }]);
    expect(
      peek<{ filename: string }>('SELECT filename FROM schema_migrations').map(r => r.filename)
    ).not.toContain('0005_fail.sql');
  });
});
