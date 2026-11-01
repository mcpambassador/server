/** ADR-023 (3c): migration 0006 replays over 0005 data, and its CHECKs/indexes/cascades hold. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const dir = fileURLToPath(new URL('../../../core/drizzle/', import.meta.url));
const files = fs
  .readdirSync(dir)
  .filter(f => /^\d{4}_.*\.sql$/.test(f))
  .sort();
const idx6 = files.findIndex(f => f.startsWith('0006_'));

const run = (db: Database.Database, f: string): void => {
  for (const stmt of fs.readFileSync(path.join(dir, f), 'utf8').split('--> statement-breakpoint'))
    if (stmt.trim()) db.exec(stmt);
};

/** Insert a row with only the NOT NULL columns that have no default. */
const minimal = (
  db: Database.Database,
  table: string,
  over: Record<string, string | number> = {}
): void => {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: unknown;
  }[];
  const need = cols.filter(c => (c.notnull && c.dflt_value === null) || c.name in over);
  const names = need.map(c => `"${c.name}"`).join(',');
  const vals = need.map(c => over[c.name] ?? (/INT/i.test(c.type) ? 1 : `x-${c.name}`));
  db.prepare(`INSERT INTO ${table} (${names}) VALUES (${need.map(() => '?').join(',')})`).run(
    ...vals
  );
};

describe('migration 0006 (approval gates)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
  });
  afterEach(() => db.close());

  it('is the last migration after 0005', () => {
    expect(idx6).toBe(files.findIndex(f => f.startsWith('0005_')) + 1);
  });

  it('replays over a populated 0005 database: old MCPs come up ungated, owner default', () => {
    db.pragma('foreign_keys = OFF');
    for (const f of files.slice(0, idx6)) run(db, f);
    minimal(db, 'mcp_catalog');
    run(db, files[idx6]!);
    expect(
      db
        .prepare('SELECT default_requires_approval AS r, default_approver AS a FROM mcp_catalog')
        .all()
    ).toEqual([{ r: 0, a: 'owner' }]);
    expect(db.prepare('SELECT count(*) AS n FROM tool_policies').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM approval_requests').get()).toEqual({ n: 0 });
  });

  describe('constraints', () => {
    const H = 'a'.repeat(64);
    const now = '2026-11-01T00:00:00.000Z';
    const req = (over: Record<string, string | number | null> = {}): void => {
      const row: Record<string, string | number | null> = {
        approval_id: `ar-${Math.random()}`,
        grant_id: 'g1',
        user_id: 'u1',
        mcp_id: 'm1',
        tool_name: 't',
        args_hash: H,
        required_approver: 'owner',
        created_at: now,
        expires_at: now,
        ...over,
      };
      const keys = Object.keys(row);
      db.prepare(
        `INSERT INTO approval_requests (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`
      ).run(...Object.values(row));
    };
    beforeEach(() => {
      db.pragma('foreign_keys = OFF');
      for (const f of files.slice(0, idx6 + 1)) run(db, f);
    });

    it('tool_policies: approver and requires_approval CHECKs, unique (mcp, tool)', () => {
      const ins = (a: string, r = 1, tool = 't'): unknown =>
        db
          .prepare(
            `INSERT INTO tool_policies (mcp_id,tool_name,requires_approval,approver,updated_by,updated_at) VALUES ('m1',?,?,?,'u','now')`
          )
          .run(tool, r, a);
      expect(() => ins('owner')).not.toThrow();
      expect(() => ins('admin', 1, 't2')).not.toThrow();
      expect(() => ins('root', 1, 't3')).toThrow(/CHECK/);
      expect(() => ins('owner', 2, 't4')).toThrow(/CHECK/);
      expect(() => ins('owner', 1, '')).toThrow(/CHECK/);
      expect(() => ins('owner', 1, 'x'.repeat(257))).toThrow(/CHECK/);
      expect(() => ins('admin')).toThrow(/UNIQUE|PRIMARY/);
    });

    it('tool_policies: approver has no default (an explicit choice is required)', () => {
      expect(() =>
        db
          .prepare(
            `INSERT INTO tool_policies (mcp_id,tool_name,requires_approval,updated_by,updated_at) VALUES ('m1','noapprover',1,'u','now')`
          )
          .run()
      ).toThrow(/NOT NULL/);
    });

    it('approval_requests: status, approver and hash-length CHECKs', () => {
      ['pending', 'approved', 'denied', 'expired', 'voided', 'consumed'].forEach((s, i) =>
        expect(() => req({ status: s, args_hash: String(i).repeat(64) })).not.toThrow()
      );
      expect(() => req({ status: 'rejected' })).toThrow(/CHECK/);
      expect(() => req({ required_approver: 'everyone' })).toThrow(/CHECK/);
      expect(() => req({ approver_role: 'root' })).toThrow(/CHECK/);
      expect(() => req({ args_hash: 'abc' })).toThrow(/CHECK/);
      expect(() => req({ self_approved: 2 })).toThrow(/CHECK/);
      expect(() => req({ disclosure_mode: 'x' })).toThrow(/CHECK/);
      expect(
        db.prepare('SELECT status, self_approved AS s FROM approval_requests').all()[0]
      ).toEqual({ status: 'pending', s: 0 });
    });

    it('preview: allowed only while open, capped at 8 KB bytes', () => {
      expect(() => req({ status: 'pending', preview: 'x'.repeat(8192) })).not.toThrow();
      expect(() => req({ status: 'pending', preview: 'x'.repeat(8193) })).toThrow(/CHECK/);
      // multi-byte: 4097 two-byte characters is 8194 bytes
      expect(() => req({ status: 'pending', preview: 'é'.repeat(4097) })).toThrow(/CHECK/);
      for (const s of ['denied', 'expired', 'voided', 'consumed'])
        expect(() => req({ status: s, preview: 'secret' })).toThrow(/CHECK/);
      expect(() => req({ status: 'denied', preview: null })).not.toThrow();
    });

    it('terminal transition must null the preview in the same UPDATE', () => {
      req({ approval_id: 'a1', preview: 'p' });
      expect(() => db.prepare(`UPDATE approval_requests SET status='denied'`).run()).toThrow(
        /CHECK/
      );
      expect(() =>
        db.prepare(`UPDATE approval_requests SET status='denied', preview=NULL`).run()
      ).not.toThrow();
    });

    it('at most one open request per identical call; closed ones do not block', () => {
      req({ status: 'pending' });
      expect(() => req({ status: 'pending' })).toThrow(/UNIQUE/);
      expect(() => req({ status: 'approved' })).toThrow(/UNIQUE/);
      expect(() => req({ status: 'pending', args_hash: 'b'.repeat(64) })).not.toThrow();
      expect(() => req({ status: 'pending', grant_id: 'g2' })).not.toThrow();
      db.prepare(
        `UPDATE approval_requests SET status='consumed', preview=NULL WHERE args_hash=? AND grant_id='g1'`
      ).run(H);
      expect(() => req({ status: 'pending' })).not.toThrow();
      expect(() => req({ status: 'denied' })).not.toThrow();
      expect(() => req({ status: 'denied' })).not.toThrow();
    });

    it('mcp_catalog defaults: CHECKs on the new columns', () => {
      minimal(db, 'mcp_catalog', { mcp_id: 'mx', name: 'mx' });
      expect(() =>
        db
          .prepare(`UPDATE mcp_catalog SET default_requires_approval=1, default_approver='admin'`)
          .run()
      ).not.toThrow();
      expect(() => db.prepare(`UPDATE mcp_catalog SET default_requires_approval=2`).run()).toThrow(
        /CHECK/
      );
      expect(() => db.prepare(`UPDATE mcp_catalog SET default_approver='all'`).run()).toThrow(
        /CHECK/
      );
    });

    it('indexes exist for the reaper, owner queue and cooldown', () => {
      const names = (
        db
          .prepare(
            `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='approval_requests'`
          )
          .all() as {
          name: string;
        }[]
      ).map(r => r.name);
      for (const n of [
        'idx_approval_requests_status_expires',
        'idx_approval_requests_user_status',
        'idx_approval_requests_grant_status',
        'idx_approval_requests_cooldown',
        'unique_open_approval_call',
      ])
        expect(names).toContain(n);
    });
  });

  it('cascades: deleting an MCP removes its policies and requests; deleting a bound client keeps the request', () => {
    for (const f of files.slice(0, idx6 + 1)) run(db, f);
    db.pragma('foreign_keys = ON');
    minimal(db, 'users', { user_id: 'u1' });
    minimal(db, 'mcp_catalog', { mcp_id: 'm1', name: 'm1' });
    minimal(db, 'clients', { client_id: 'c1', user_id: 'u1' });
    minimal(db, 'agent_grants', { grant_id: 'g1', user_id: 'u1' });
    db.prepare(
      `INSERT INTO tool_policies (mcp_id,tool_name,requires_approval,approver,updated_by,updated_at) VALUES ('m1','t',1,'admin','u','n')`
    ).run();
    db.prepare(
      `INSERT INTO approval_requests (approval_id,grant_id,bound_client_id,user_id,mcp_id,tool_name,args_hash,required_approver,created_at,expires_at) VALUES ('a1','g1','c1','u1','m1','t',?,'owner','n','n')`
    ).run('a'.repeat(64));
    db.prepare(`DELETE FROM clients WHERE client_id='c1'`).run();
    expect(db.prepare(`SELECT bound_client_id AS b FROM approval_requests`).get()).toEqual({
      b: null,
    });
    db.prepare(`DELETE FROM mcp_catalog WHERE mcp_id='m1'`).run();
    expect(db.prepare('SELECT count(*) AS n FROM tool_policies').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM approval_requests').get()).toEqual({ n: 0 });
  });
});
