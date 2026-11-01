/** ADR-020 migration 0002: upgrade from a populated pre-0002 DB, idempotency, no raw secrets. */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const dir = path.join(__dirname, '..', 'drizzle');
const sql = (f: string) => fs.readFileSync(path.join(dir, f), 'utf-8');
const NEW_TABLES = [
  'oauth_clients',
  'oauth_pending_requests',
  'oauth_auth_codes',
  'agent_grants',
  'agent_tokens',
];

function seedAllTables(db: Database.Database): void {
  db.pragma('foreign_keys = OFF');
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  for (const { name } of tables) {
    const cols = db.prepare(`PRAGMA table_info(\`${name}\`)`).all() as {
      name: string;
      type: string;
      notnull: number;
      dflt_value: unknown;
    }[];
    const vals = cols.map(c => (/int|real|num/i.test(c.type) ? 1 : `seed-${name}-${c.name}`));
    db.prepare(
      `INSERT OR IGNORE INTO \`${name}\` (${cols.map(c => `\`${c.name}\``).join(',')}) VALUES (${cols.map(() => '?').join(',')})`
    ).run(...vals);
  }
}

function snapshot(db: Database.Database, tables: string[]): Record<string, unknown[]> {
  return Object.fromEntries(
    tables.map(t => [t, db.prepare(`SELECT * FROM \`${t}\` ORDER BY rowid`).all()])
  );
}

describe('migration 0002 (agent endpoint)', () => {
  const old = () => {
    const db = new Database(':memory:');
    db.exec(sql('0000_initial_schema.sql'));
    db.exec(sql('0001_adr014_oauth.sql'));
    seedAllTables(db);
    return db;
  };
  const oldTables = (db: Database.Database) =>
    (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[]
    )
      .map(r => r.name)
      .filter(n => !NEW_TABLES.includes(n));

  it('applies on populated pre-0002 DB without touching existing rows', () => {
    const db = old();
    const names = oldTables(db);
    const before = snapshot(db, names);
    expect(Object.values(before).some(r => r.length > 0)).toBe(true);
    db.exec(sql('0002_adr020_agent_endpoint.sql'));
    expect(snapshot(db, names)).toEqual(before);
    for (const t of NEW_TABLES)
      expect(db.prepare(`SELECT 1 FROM \`${t}\` LIMIT 1`).all()).toBeDefined();
  });

  it('is idempotent: whole chain twice (as runMigrations does every startup)', () => {
    const db = old();
    db.exec(sql('0002_adr020_agent_endpoint.sql'));
    db.prepare(
      "INSERT INTO oauth_clients (client_id,client_name,redirect_uris,registered_via,created_at) VALUES ('c','n','[]','admin','t')"
    ).run();
    const names = [...oldTables(db), ...NEW_TABLES];
    const before = snapshot(db, names);
    for (const f of [
      '0000_initial_schema.sql',
      '0001_adr014_oauth.sql',
      '0002_adr020_agent_endpoint.sql',
    ]) {
      db.exec(sql(f));
    }
    expect(snapshot(db, names)).toEqual(before);
  });

  it('new tables have no raw token / code / secret columns (hashes only)', () => {
    const db = old();
    db.exec(sql('0002_adr020_agent_endpoint.sql'));
    for (const t of NEW_TABLES) {
      const cols = (db.prepare(`PRAGMA table_info(\`${t}\`)`).all() as { name: string }[]).map(
        c => c.name
      );
      for (const c of cols) {
        expect(c, `${t}.${c}`).not.toMatch(
          /^(access_token|refresh_token|token|code|secret|client_secret|bearer)$/i
        );
      }
    }
    const tok = (db.prepare('PRAGMA table_info(agent_tokens)').all() as { name: string }[]).map(
      c => c.name
    );
    expect(tok).toContain('token_hash');
    const codes = (
      db.prepare('PRAGMA table_info(oauth_auth_codes)').all() as { name: string }[]
    ).map(c => c.name);
    expect(codes).toContain('code_hash');
  });

  it('foreign keys cascade: deleting a user removes grants and tokens', () => {
    const db = old();
    db.exec(sql('0002_adr020_agent_endpoint.sql'));
    db.pragma('foreign_keys = ON');
    const uid = (db.prepare('SELECT user_id FROM users LIMIT 1').get() as { user_id: string })
      .user_id;
    db.prepare(
      "INSERT INTO agent_grants (grant_id,user_id,label,scopes,resource,created_at,expires_at) VALUES ('g',?,'l','[]','r','t','t')"
    ).run(uid);
    db.prepare(
      "INSERT INTO agent_tokens (token_hash,kind,grant_id,expires_at,created_at) VALUES ('h','access','g','t','t')"
    ).run();
    db.prepare('DELETE FROM users WHERE user_id=?').run(uid);
    expect(db.prepare('SELECT count(*) c FROM agent_grants').get()).toEqual({ c: 0 });
    expect(db.prepare('SELECT count(*) c FROM agent_tokens').get()).toEqual({ c: 0 });
  });
});
