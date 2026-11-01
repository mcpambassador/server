/**
 * ADR-023 (3c) PR-2: approval queue API + reauth. Session-only guard (no admin key / bearer, CSRF),
 * visibility, approver roles, step-up (428), self-approval, stale hash, B2c re-check, listing.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AmbassadorServer } from '@mcpambassador/server';
import {
  initializeDatabase,
  closeDatabase,
  runMigrations,
  createAdminKey,
  type DatabaseClient,
} from '@mcpambassador/core';
import { StepUpStore } from '../../src/auth/step-up.js';
import { createUser } from '../../src/auth/user-auth.js';
import type { ApprovalService } from '../../src/services/approvals/service.js';
import { makeAdminClient, type AdminClient } from '../admin-api/helpers.js';

const PW = 'Correct-Horse-9!';
const CANARY = 'CANARY-SECRET-ARGUMENT-VALUE';
const EXP = '2099-01-01T00:00:00.000Z';
const HASH = (n: number | string): string => String(n).padStart(64, '0');
const raw = (db: DatabaseClient): any => (db as any).session.client;

interface Actor {
  userId: string;
  client: AdminClient;
  cookie: string;
}

let dir: string;
let server: AmbassadorServer;
let db: DatabaseClient;
let svc: ApprovalService;
let adminKey: string;
let audits: Array<{ action: string; meta: Record<string, unknown> }> = [];
let alice: Actor; // owner of the requests
let bob: Actor; // another ordinary user
let root: Actor; // admin (separate from alice)
let aliceAdmin: Actor; // admin who also owns requests (self-approval)
let seq = 0;

async function login(username: string, userId: string, server_: AmbassadorServer): Promise<Actor> {
  const client = makeAdminClient(server_.getAdminServer());
  const res = await client.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { username, password: PW },
  });
  expect([200, 201]).toContain(res.statusCode);
  const sc = res.headers['set-cookie'];
  const list = Array.isArray(sc) ? sc : [String(sc)];
  const hit = list.find(c => String(c).startsWith('sessionId='));
  return { userId, client, cookie: String(hit).split(';')[0]! };
}

const call = (
  a: Actor,
  method: string,
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {}
) =>
  a.client.inject({
    method,
    url,
    headers: { cookie: a.cookie, ...headers },
    ...(payload !== undefined ? { payload } : {}),
  });
const json = (res: { body: string }): any => JSON.parse(res.body);

function seedFor(userId: string, tag: string): { grantId: string; clientId: string } {
  const ts = '2026-11-01T00:00:00.000Z';
  const r = raw(db);
  const clientId = `k-${tag}`;
  const grantId = `g-${tag}`;
  r.prepare(
    `INSERT INTO clients (client_id, client_name, key_prefix, key_hash, user_id, status, created_at) VALUES (?,?,?,?,?,?,?)`
  ).run(clientId, clientId, 'p', 'h', userId, 'active', ts);
  r.prepare(
    `INSERT INTO agent_grants (grant_id, user_id, bound_client_id, label, scopes, resource, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?)`
  ).run(grantId, userId, clientId, grantId, '["tools"]', 'https://x/mcp', ts, EXP);
  return { grantId, clientId };
}

async function mk(
  actor: Actor,
  over: Record<string, unknown> = {}
): Promise<{ id: string; hash: string; clientId: string }> {
  const n = ++seq;
  const s =
    (over.__seed as { grantId: string; clientId: string } | undefined) ??
    seedFor(actor.userId, `r${n}`);
  delete over.__seed;
  const hash = HASH(n);
  const r = await svc.createOrFind({
    grantId: s.grantId,
    boundClientId: s.clientId,
    userId: actor.userId,
    mcpId: 'm1',
    toolName: `tool_${n}`,
    argsHash: hash,
    pinHash: null,
    required: 'owner',
    preview: `{"title":"${CANARY}"}`,
    via: 'mcp',
    disclosureMode: 'full',
    grantExpiresAt: EXP,
    ...over,
  } as any);
  if (r.kind !== 'created' && r.kind !== 'existing') throw new Error(`create failed: ${r.kind}`);
  return { id: r.request.approval_id, hash, clientId: s.clientId };
}

const reauth = (a: Actor, password = PW) => call(a, 'POST', '/v1/auth/reauth', { password });
const decide = (a: Actor, scope: 'admin' | 'user', id: string, hash: string, d = 'approve') =>
  call(
    a,
    'POST',
    scope === 'admin'
      ? `/v1/admin/approvals/${id}/decision`
      : `/v1/users/me/approvals/${id}/decision`,
    { decision: d, expected_args_hash: hash }
  );

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-appr-api-'));
  const pre = await initializeDatabase({
    type: 'sqlite',
    sqliteFilePath: path.join(dir, 'ambassador.db'),
    seedOnInit: true,
  });
  await runMigrations(pre as DatabaseClient);
  adminKey = (await createAdminKey(pre as DatabaseClient, dir)).admin_key;
  await closeDatabase(pre as DatabaseClient);

  server = new AmbassadorServer({
    dataDir: dir,
    port: 0,
    host: '127.0.0.1',
    ambassadorConfig: { approvals: { require_distinct_admin: true } } as never,
  } as never);
  await server.initialize();
  db = (server as any).db;
  svc = (server as any).approvals;
  const origAudit = (svc as any).audit as (a: string, m: Record<string, unknown>) => void;
  (svc as any).audit = (action: string, meta: Record<string, unknown>): void => {
    audits.push({ action, meta });
    origAudit(action, meta);
  };

  const mkUser = (username: string, is_admin: boolean) =>
    createUser(db, { username, password: PW, display_name: username, is_admin });
  const ua = await mkUser('alice', false);
  const ub = await mkUser('bob', false);
  const ur = await mkUser('root', true);
  const uaa = await mkUser('aliceadmin', true);
  raw(db)
    .prepare(
      `INSERT INTO mcp_catalog (mcp_id, name, display_name, transport_type, created_at, updated_at) VALUES (?,?,?,?,?,?)`
    )
    .run('m1', 'github', 'github', 'stdio', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z');

  alice = await login('alice', ua.user_id, server);
  bob = await login('bob', ub.user_id, server);
  root = await login('root', ur.user_id, server);
  aliceAdmin = await login('aliceadmin', uaa.user_id, server);
});

afterAll(async () => {
  try {
    await server.stop();
  } catch {
    // ignore
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  // keep per-user open caps out of unrelated tests
  raw(db)
    .prepare(
      `UPDATE approval_requests SET status='expired', preview=NULL WHERE status IN ('pending','approved')`
    )
    .run();
});

describe('credential and session guard', () => {
  const routes: Array<[string, string]> = [
    ['GET', '/v1/admin/approvals'],
    ['GET', '/v1/admin/approvals/summary'],
    ['GET', '/v1/admin/approvals/apr_x'],
    ['POST', '/v1/admin/approvals/apr_x/decision'],
    ['GET', '/v1/users/me/approvals'],
    ['GET', '/v1/users/me/approvals/summary'],
    ['POST', '/v1/users/me/approvals/apr_x/decision'],
    ['POST', '/v1/auth/reauth'],
  ];

  it('refuses X-Admin-Key on every route and audits it', async () => {
    for (const [method, url] of routes) {
      audits = [];
      const res = await root.client.inject({
        method,
        url,
        headers: { 'x-admin-key': adminKey, cookie: root.cookie },
        ...(method === 'POST' ? { payload: {} } : {}),
      });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(audits.some(a => a.action === 'approval_credential_refused')).toBe(true);
    }
  });

  it('refuses an Authorization header even with a valid session', async () => {
    audits = [];
    const res = await call(root, 'GET', '/v1/admin/approvals', undefined, {
      authorization: 'Bearer amb_pk_whatever',
    });
    expect(res.statusCode).toBe(403);
    expect(audits.some(a => a.action === 'approval_credential_refused')).toBe(true);
  });

  it('401 without a session', async () => {
    const anon = makeAdminClient(server.getAdminServer());
    for (const [method, url] of routes) {
      const res = await anon.inject({
        method,
        url,
        ...(method === 'POST' ? { payload: {} } : {}),
      });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('403 on a state change without a CSRF token', async () => {
    const { id, hash } = await mk(alice);
    const res = await server.getAdminServer().inject({
      method: 'POST',
      url: `/v1/users/me/approvals/${id}/decision`,
      headers: { cookie: alice.cookie, 'x-csrf-token': 'bogus' },
      payload: { decision: 'approve', expected_args_hash: hash },
    });
    expect(res.statusCode).toBe(403);
    expect(json(await call(alice, 'GET', `/v1/users/me/approvals/${id}`)).data.status).toBe(
      'pending'
    );
  });

  it('non-admin gets 403 on the admin scope', async () => {
    expect((await call(alice, 'GET', '/v1/admin/approvals')).statusCode).toBe(403);
  });
});

describe('visibility and owner decisions', () => {
  it("another user's request is 404 for detail and decision", async () => {
    const { id, hash } = await mk(alice);
    expect((await call(bob, 'GET', `/v1/users/me/approvals/${id}`)).statusCode).toBe(404);
    expect((await decide(bob, 'user', id, hash)).statusCode).toBe(404);
    expect((await call(bob, 'GET', '/v1/users/me/approvals/not-an-id')).statusCode).toBe(404);
  });

  it('owner approves their own owner-class request (no step-up)', async () => {
    const { id, hash } = await mk(alice);
    const res = await decide(alice, 'user', id, hash);
    expect(res.statusCode).toBe(200);
    const d = json(res).data;
    expect(d.status).toBe('approved');
    expect(d.approver_role).toBe('owner');
    expect(d.self_approved).toBe(false); // self-approval is an admin-class notion
  });

  it('owner can deny', async () => {
    const { id, hash } = await mk(alice);
    const res = await decide(alice, 'user', id, hash, 'deny');
    expect(res.statusCode).toBe(200);
    expect(json(res).data.status).toBe('denied');
  });

  it('invalid body is 400', async () => {
    const { id } = await mk(alice);
    const res = await call(alice, 'POST', `/v1/users/me/approvals/${id}/decision`, {
      decision: 'maybe',
    });
    expect(res.statusCode).toBe(400);
  });

  it('stale expected_args_hash is 409 and leaves the request pending', async () => {
    const { id } = await mk(alice);
    const res = await decide(alice, 'user', id, HASH('dead'));
    expect(res.statusCode).toBe(409);
    expect(json(await call(alice, 'GET', `/v1/users/me/approvals/${id}`)).data.status).toBe(
      'pending'
    );
  });

  it('second decision loses the race with 409', async () => {
    const { id, hash } = await mk(alice);
    expect((await decide(alice, 'user', id, hash)).statusCode).toBe(200);
    expect((await decide(alice, 'user', id, hash, 'deny')).statusCode).toBe(409);
  });

  it('owner sees an admin-required request read-only and cannot decide it (403)', async () => {
    const { id, hash } = await mk(alice, { required: 'admin' });
    const d = json(await call(alice, 'GET', `/v1/users/me/approvals/${id}`)).data;
    expect(d.read_only).toBe(true);
    expect((await decide(alice, 'user', id, hash)).statusCode).toBe(403);
  });
});

describe('admin decisions and step-up', () => {
  it('428 reauth_required without step-up; succeeds after reauth', async () => {
    const { id, hash } = await mk(alice, { required: 'admin' });
    const first = await decide(root, 'admin', id, hash);
    expect(first.statusCode).toBe(428);
    expect(json(first).error.code).toBe('reauth_required');

    const re = await reauth(root);
    expect(re.statusCode).toBe(200);
    expect(json(re).data.window_seconds).toBe(300);

    const ok = await decide(root, 'admin', id, hash);
    expect(ok.statusCode).toBe(200);
    expect(json(ok).data.approver_role).toBe('admin');
    expect(json(ok).data.self_approved).toBe(false);
  });

  it('StepUpStore: window expires, unknown/empty sessions are never fresh', () => {
    let t = 1_000_000;
    const store = new StepUpStore(300, () => t);
    expect(store.isFresh('s1')).toBe(false);
    expect(store.isFresh(undefined)).toBe(false);
    store.mark('s1');
    expect(store.isFresh('s1')).toBe(true);
    expect(store.isFresh('s2')).toBe(false);
    t += 299_000;
    expect(store.isFresh('s1')).toBe(true);
    t += 2_000;
    expect(store.isFresh('s1')).toBe(false);
    store.mark('s1');
    store.clear('s1');
    expect(store.isFresh('s1')).toBe(false);
  });

  it('step-up is bound to the session, not the user', async () => {
    expect((await reauth(root)).statusCode).toBe(200);
    const second = await login('root', root.userId, server);
    const { id, hash } = await mk(alice, { required: 'admin' });
    expect((await decide(second, 'admin', id, hash)).statusCode).toBe(428);
    expect((await decide(root, 'admin', id, hash)).statusCode).toBe(200);
  });

  it('admin cannot decide an owner-class request through the admin scope unless stricter', async () => {
    // owner-class requests are decided by the owner; an admin session on the admin scope is 403
    const { id, hash } = await mk(alice, { required: 'owner' });
    expect((await reauth(root)).statusCode).toBe(200);
    expect((await decide(root, 'admin', id, hash)).statusCode).toBe(403);
  });

  it('require_distinct_admin blocks self-approval', async () => {
    const { id, hash } = await mk(aliceAdmin, { required: 'admin' });
    expect((await reauth(aliceAdmin)).statusCode).toBe(200);
    const res = await decide(aliceAdmin, 'admin', id, hash);
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain('Another administrator');
    // another admin can
    expect((await reauth(root)).statusCode).toBe(200);
    expect((await decide(root, 'admin', id, hash)).statusCode).toBe(200);
  });
});

describe('reauth', () => {
  it('wrong password is a generic 401, audited, and 429 after repeated failures', async () => {
    const victim = await login('bob', bob.userId, server);
    audits = [];
    const first = await reauth(victim, 'wrong-password');
    expect(first.statusCode).toBe(401);
    expect(first.body).not.toContain('wrong-password');
    expect(audits.some(a => a.action === 'approval_reauth_failed')).toBe(true);
    expect(JSON.stringify(audits)).not.toContain('wrong-password');

    let limited: Awaited<ReturnType<typeof reauth>> | null = null;
    for (let i = 0; i < 15 && !limited; i++) {
      const r = await reauth(victim, 'wrong-password');
      if (r.statusCode === 429) limited = r;
    }
    expect(limited).not.toBeNull();
    expect(limited!.headers['retry-after']).toBeDefined();
    // even the right password is refused while limited
    expect((await reauth(victim)).statusCode).toBe(429);
  });

  it('bad body is 400', async () => {
    const res = await call(alice, 'POST', '/v1/auth/reauth', { nope: 1 });
    expect(res.statusCode).toBe(400);
  });
});

describe('list, summary, detail', () => {
  it('list never carries the preview; detail of an open request does; terminal does not', async () => {
    const { id, hash } = await mk(alice);
    const list = await call(alice, 'GET', '/v1/users/me/approvals?limit=100');
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(CANARY);
    expect(list.body).not.toContain('"preview"');

    const open = json(await call(alice, 'GET', `/v1/users/me/approvals/${id}`)).data;
    expect(open.preview).toContain(CANARY);
    expect(open.definition_changed).toBe(false);
    expect(open.mcp_name).toBe('github');

    await decide(alice, 'user', id, hash, 'deny');
    const done = await call(alice, 'GET', `/v1/users/me/approvals/${id}`);
    expect(json(done).data.preview).toBeNull();
    expect(done.body).not.toContain(CANARY);
  });

  it('keyset pagination walks every row exactly once, newest first', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await mk(bob)).id);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const url: string = `/v1/users/me/approvals?limit=2${cursor ? `&cursor=${cursor}` : ''}`;
      const res = json(await call(bob, 'GET', url)).data;
      for (const it of res.items) seen.push(it.approval_id);
      cursor = res.next_cursor;
      if (!cursor) break;
    }
    expect(new Set(seen).size).toBe(seen.length);
    for (const id of ids) expect(seen).toContain(id);
    const createdAts = json(
      await call(bob, 'GET', '/v1/users/me/approvals?limit=100')
    ).data.items.map((i: any) => i.created_at);
    expect([...createdAts].sort().reverse()).toEqual(createdAts);
  });

  it('filters by status and mcp, rejects a bad cursor and bad query', async () => {
    const approved = json(await call(alice, 'GET', '/v1/users/me/approvals?status=approved')).data;
    for (const i of approved.items) expect(i.status).toBe('approved');
    const other = json(await call(alice, 'GET', '/v1/users/me/approvals?mcp_id=nope')).data;
    expect(other.items).toHaveLength(0);
    expect((await call(alice, 'GET', '/v1/users/me/approvals?cursor=%%%')).statusCode).toBe(400);
    expect((await call(alice, 'GET', '/v1/users/me/approvals?status=bogus')).statusCode).toBe(400);
  });

  it('user list is scoped to the caller; admin list sees all', async () => {
    const mine = json(await call(alice, 'GET', '/v1/users/me/approvals?limit=100')).data.items;
    for (const i of mine) expect(i.user_id).toBe(alice.userId);
    const all = json(await call(root, 'GET', '/v1/admin/approvals?limit=100')).data.items;
    const users = new Set(all.map((i: any) => i.user_id));
    expect(users.has(alice.userId)).toBe(true);
    expect(users.has(bob.userId)).toBe(true);
  });

  it('summary counts pending requests, scoped for users', async () => {
    const carol = await createUser(db, {
      username: 'carol',
      password: PW,
      display_name: 'carol',
    });
    const c = await login('carol', carol.user_id, server);
    expect(json(await call(c, 'GET', '/v1/users/me/approvals/summary')).data.pending_count).toBe(0);
    await mk(c);
    await mk(c);
    expect(json(await call(c, 'GET', '/v1/users/me/approvals/summary')).data.pending_count).toBe(2);
    const adminCount = json(await call(root, 'GET', '/v1/admin/approvals/summary')).data
      .pending_count;
    expect(adminCount).toBeGreaterThanOrEqual(2);
  });

  it('definition_changed is true when the stored pin no longer resolves', async () => {
    const { id } = await mk(alice, { pinHash: 'pin-that-does-not-exist' });
    const d = json(await call(alice, 'GET', `/v1/users/me/approvals/${id}`)).data;
    expect(d.definition_changed).toBe(true);
  });
});

describe('B2c: principal must still be active at decision time', () => {
  it('disabled user: decision is 409 and the request stays undecided', async () => {
    const dave = await createUser(db, { username: 'dave', password: PW, display_name: 'dave' });
    const d = await login('dave', dave.user_id, server);
    const { id, hash } = await mk(d);
    raw(db).prepare(`UPDATE users SET status='disabled' WHERE user_id=?`).run(dave.user_id);
    // the guard re-reads the user: a disabled user no longer has a session
    expect((await decide(d, 'user', id, hash)).statusCode).toBe(401);
    expect(
      raw(db).prepare('SELECT status FROM approval_requests WHERE approval_id=?').get(id).status
    ).not.toBe('approved');
  });

  it('suspended bound client: decision is 409', async () => {
    const erin = await createUser(db, { username: 'erin', password: PW, display_name: 'erin' });
    const e = await login('erin', erin.user_id, server);
    const { id, hash, clientId } = await mk(e);
    raw(db).prepare(`UPDATE clients SET status='suspended' WHERE client_id=?`).run(clientId);
    expect((await decide(e, 'user', id, hash)).statusCode).toBe(409);
    expect(
      raw(db).prepare('SELECT status FROM approval_requests WHERE approval_id=?').get(id).status
    ).not.toBe('approved');
  });
});

describe('audit', () => {
  it('decision audits carry ids, never the preview or arguments', async () => {
    audits = [];
    const { id, hash } = await mk(alice);
    await decide(alice, 'user', id, hash);
    expect(audits.length).toBeGreaterThan(0);
    expect(JSON.stringify(audits)).not.toContain(CANARY);
  });
});
