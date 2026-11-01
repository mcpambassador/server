/**
 * ADR-020 P3: agent endpoint migration + repository tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  initializeDatabase,
  runMigrations,
  closeDatabase,
  type DatabaseClient,
} from '../src/db/client.js';
import * as repo from '../src/db/repositories/agent-oauth.js';

const raw = (db: DatabaseClient): Database.Database => (db as any).session.client;
const future = (s: number): string => new Date(Date.now() + s * 1000).toISOString();
const past = (s: number): string => new Date(Date.now() - s * 1000).toISOString();

let dir: string;
let db: DatabaseClient;

function addClient(id: string, userId: string): void {
  const ts = new Date().toISOString();
  raw(db)
    .prepare(
      `INSERT INTO clients (client_id, client_name, key_prefix, key_hash, user_id, status, created_at) VALUES (?,?,?,?,?,?,?)`
    )
    .run(id, id, 'p', 'h', userId, 'active', ts);
}

function addUser(id: string): void {
  const ts = new Date().toISOString();
  raw(db)
    .prepare(
      `INSERT INTO users (user_id, username, display_name, created_at, updated_at) VALUES (?,?,?,?,?)`
    )
    .run(id, id, id, ts, ts);
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amb-p3-'));
  db = await initializeDatabase({ type: 'sqlite', sqliteFilePath: path.join(dir, 'a.db') });
  await runMigrations(db);
  addUser('u1');
  addUser('u2');
  addClient('k1', 'u1');
  addClient('k2', 'u2');
});
afterEach(async () => {
  await closeDatabase(db);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('migration 0002', () => {
  it('creates all five tables and is idempotent', async () => {
    await runMigrations(db);
    const names = (
      raw(db).prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as {
        name: string;
      }[]
    ).map(r => r.name);
    for (const t of [
      'oauth_clients',
      'oauth_pending_requests',
      'oauth_auth_codes',
      'agent_grants',
      'agent_tokens',
    ]) {
      expect(names).toContain(t);
    }
  });

  it('applies on a pre-existing DB (only 0000+0001) without touching data', async () => {
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'amb-p3-old-'));
    try {
      const file = path.join(d2, 'old.db');
      const mig = path.resolve(__dirname, '../drizzle');
      const old = new Database(file);
      for (const f of ['0000_initial_schema.sql', '0001_adr014_oauth.sql']) {
        old.exec(fs.readFileSync(path.join(mig, f), 'utf-8'));
      }
      const ts = new Date().toISOString();
      old
        .prepare(
          `INSERT INTO users (user_id, username, display_name, created_at, updated_at) VALUES ('x','x','x',?,?)`
        )
        .run(ts, ts);
      old.close();

      const db2 = await initializeDatabase({ type: 'sqlite', sqliteFilePath: file });
      await runMigrations(db2);
      expect((raw(db2).prepare(`SELECT COUNT(*) c FROM users`).get() as { c: number }).c).toBe(1);
      expect(
        raw(db2).prepare(`SELECT name FROM sqlite_master WHERE name='agent_tokens'`).get()
      ).toBeTruthy();
      await closeDatabase(db2);
    } finally {
      fs.rmSync(d2, { recursive: true, force: true });
    }
  });
});

async function mkClient(id = 'c1'): Promise<void> {
  await repo.createOAuthClient(db, {
    client_id: id,
    client_name: 'Test',
    redirect_uris: ['https://a.example/cb'],
    registered_via: 'admin',
    disabled: false,
  });
}

describe('oauth_clients', () => {
  it('create/get/list/count/disable', async () => {
    await mkClient();
    await mkClient('c2');
    expect(await repo.countOAuthClients(db)).toBe(2);
    const c = await repo.getOAuthClient(db, 'c1');
    expect(c?.redirect_uris).toEqual(['https://a.example/cb']);
    expect(c?.disabled).toBe(false);
    await repo.setOAuthClientDisabled(db, 'c1', true);
    expect((await repo.getOAuthClient(db, 'c1'))?.disabled).toBe(true);
    expect(await repo.getOAuthClient(db, 'nope')).toBeNull();
    expect((await repo.listOAuthClients(db)).map(x => x.client_id)).toEqual(['c1', 'c2']);
  });
});

describe('pending auth requests', () => {
  const base = {
    user_id: null,
    client_id: 'c1',
    redirect_uri: 'https://a.example/cb',
    code_challenge: 'ch',
    requested_scopes: ['mcp:*'],
    resource: 'https://h/mcp',
    state: 's',
    used_at: null,
  };
  it('binds to first user only, consumes once', async () => {
    await mkClient();
    await repo.createPendingAuthRequest(db, { ...base, request_id: 'r1', expires_at: future(60) });
    expect(await repo.bindPendingAuthRequest(db, 'r1', 'u1')).toBe(true);
    expect(await repo.bindPendingAuthRequest(db, 'r1', 'u1')).toBe(true);
    expect(await repo.bindPendingAuthRequest(db, 'r1', 'u2')).toBe(false);
    const got = await repo.consumePendingAuthRequest(db, 'r1');
    expect(got?.user_id).toBe('u1');
    expect(got?.requested_scopes).toEqual(['mcp:*']);
    expect(await repo.consumePendingAuthRequest(db, 'r1')).toBeNull();
    expect(await repo.bindPendingAuthRequest(db, 'r1', 'u1')).toBe(false);
  });
  it('rejects expired', async () => {
    await mkClient();
    await repo.createPendingAuthRequest(db, { ...base, request_id: 'r2', expires_at: past(1) });
    expect(await repo.bindPendingAuthRequest(db, 'r2', 'u1')).toBe(false);
    expect(await repo.consumePendingAuthRequest(db, 'r2')).toBeNull();
  });
});

describe('auth codes', () => {
  const code = (hash: string, exp: string): repo.AuthCodeRecord => ({
    code_hash: hash,
    user_id: 'u1',
    client_id: 'c1',
    redirect_uri: 'https://a.example/cb',
    code_challenge: 'ch',
    scopes: ['mcp:a'],
    tool_allowlist: ['a.x'],
    resource: 'https://h/mcp',
    bound_client_id: 'k1',
    label: 'L',
    ttl_seconds: 3600,
    expires_at: exp,
    used_at: null,
  });
  it('is single-use and honours expiry', async () => {
    await mkClient();
    await repo.createAuthCode(db, code('h1', future(60)));
    await repo.createAuthCode(db, code('h2', past(1)));
    const c = await repo.consumeAuthCode(db, 'h1');
    expect(c?.tool_allowlist).toEqual(['a.x']);
    expect(await repo.consumeAuthCode(db, 'h1')).toBeNull();
    expect(await repo.consumeAuthCode(db, 'h2')).toBeNull();
    expect(await repo.consumeAuthCode(db, 'missing')).toBeNull();
  });
});

describe('grants and tokens', () => {
  async function grant(id: string, user = 'u1', exp = future(3600)): Promise<void> {
    await repo.createAgentGrant(db, {
      grant_id: id,
      user_id: user,
      client_id: null,
      bound_client_id: user === 'u2' ? 'k2' : 'k1',
      label: id,
      scopes: ['mcp:*'],
      tool_allowlist: null,
      resource: 'https://h/mcp',
      expires_at: exp,
    });
  }
  const tok = (h: string, g: string, kind: 'access' | 'refresh', fam: string | null = null) =>
    repo.insertAgentToken(db, {
      token_hash: h,
      kind,
      grant_id: g,
      family_id: fam,
      expires_at: future(600),
    });

  it('revokeAgentGrant revokes grant + all tokens, records actor', async () => {
    await grant('g1');
    await tok('a1', 'g1', 'access');
    await tok('r1', 'g1', 'refresh', 'f1');
    await repo.revokeAgentGrant(db, 'g1', 'u1');
    const g = await repo.getAgentGrant(db, 'g1');
    expect(g?.revoked_at).toBeTruthy();
    expect(g?.revoked_by).toBe('u1');
    expect((await repo.getAgentTokenByHash(db, 'a1'))?.revoked_at).toBeTruthy();
    expect((await repo.getAgentTokenByHash(db, 'r1'))?.revoked_at).toBeTruthy();
  });

  it('revokeAll only touches that user and returns count', async () => {
    await grant('g1');
    await grant('g2');
    await grant('g3', 'u2');
    expect(await repo.revokeAllAgentGrantsForUser(db, 'u1', 'admin')).toBe(2);
    expect(await repo.revokeAllAgentGrantsForUser(db, 'u1', 'admin')).toBe(0);
    expect((await repo.getAgentGrant(db, 'g3'))?.revoked_at).toBeNull();
    expect((await repo.listAgentGrantsForUser(db, 'u1')).length).toBe(2);
  });

  it('refresh reuse detection: second markRefreshTokenUsed is false; family revoke', async () => {
    await grant('g1');
    await tok('r1', 'g1', 'refresh', 'f1');
    await tok('r2', 'g1', 'refresh', 'f1');
    expect(await repo.markRefreshTokenUsed(db, 'r1')).toBe(true);
    expect(await repo.markRefreshTokenUsed(db, 'r1')).toBe(false);
    expect(await repo.markRefreshTokenUsed(db, 'a-none')).toBe(false);
    await repo.revokeTokenFamily(db, 'f1');
    expect((await repo.getAgentTokenByHash(db, 'r2'))?.revoked_at).toBeTruthy();
    expect(await repo.markRefreshTokenUsed(db, 'r2')).toBe(false);
  });

  it('binds to an Ambassador client and cascades when that client is deleted', async () => {
    await grant('g1');
    await tok('a1', 'g1', 'access');
    expect((await repo.getAgentGrant(db, 'g1'))?.bound_client_id).toBe('k1');
    raw(db).prepare(`DELETE FROM clients WHERE client_id='k1'`).run();
    expect(await repo.getAgentGrant(db, 'g1')).toBeNull();
    expect(await repo.getAgentTokenByHash(db, 'a1')).toBeNull();
  });

  it('touch + deleteAgentToken + user delete cascades', async () => {
    await grant('g1');
    await tok('a1', 'g1', 'access');
    await repo.touchAgentGrant(db, 'g1');
    expect((await repo.getAgentGrant(db, 'g1'))?.last_used_at).toBeTruthy();
    await repo.deleteAgentToken(db, 'a1');
    expect(await repo.getAgentTokenByHash(db, 'a1')).toBeNull();
    await tok('a2', 'g1', 'access');
    raw(db).prepare(`DELETE FROM users WHERE user_id='u1'`).run();
    expect(await repo.getAgentGrant(db, 'g1')).toBeNull();
    expect(await repo.getAgentTokenByHash(db, 'a2')).toBeNull();
  });

  it('sweep removes expired records, keeps live ones and recently-expired grants', async () => {
    await mkClient();
    await repo.createAuthCode(db, {
      code_hash: 'old',
      user_id: 'u1',
      client_id: 'c1',
      redirect_uri: 'x',
      code_challenge: 'c',
      scopes: [],
      tool_allowlist: null,
      resource: 'r',
      bound_client_id: 'k1',
      label: null,
      ttl_seconds: null,
      expires_at: past(10),
      used_at: null,
    });
    await grant('live');
    await grant('recent', 'u1', past(60));
    await grant('ancient', 'u1', past(30 * 86400));
    await repo.insertAgentToken(db, {
      token_hash: 'exp',
      kind: 'access',
      grant_id: 'live',
      family_id: null,
      expires_at: past(5),
    });
    await tok('keep', 'live', 'access');
    await tok('ancient-t', 'ancient', 'access');
    const n = await repo.sweepExpiredAgentRecords(db, new Date());
    expect(n).toBe(3);
    expect(await repo.getAgentGrant(db, 'live')).not.toBeNull();
    expect(await repo.getAgentGrant(db, 'recent')).not.toBeNull();
    expect(await repo.getAgentGrant(db, 'ancient')).toBeNull();
    expect(await repo.getAgentTokenByHash(db, 'exp')).toBeNull();
    expect(await repo.getAgentTokenByHash(db, 'keep')).not.toBeNull();
    expect(await repo.consumeAuthCode(db, 'old')).toBeNull();
  });
});
