/**
 * ADR-023 (3c) PR-2 black-box (verifier-owned): credential refusal on every approval route,
 * the 401/403(CSRF)/404/403(role)/428/409 check order, the step-up window (fake clock), reauth
 * hygiene and demotion/disable at decision time. Independent of approval-api.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
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
import { createUser } from '../../src/auth/user-auth.js';
import { makeAdminClient, type AdminClient } from '../admin-api/helpers.js';
import type { ApprovalService } from '../../src/services/approvals/service.js';

const PW = 'Bb-Correct-Horse-42!';
const WRONG_PW = 'WRONG-PASSWORD-CANARY-9f3a';
const CANARY = 'CANARY-ARG-api-51cc-do-not-leak';
const FAR = '2099-01-01T00:00:00.000Z';
const HASH = (n: number): string => String(n).padStart(64, '0');
const T0 = new Date('2026-11-01T12:00:00.000Z');

interface Actor {
  userId: string;
  username: string;
  client: AdminClient;
  cookie: string;
}

let tmp: string;
let server: AmbassadorServer;
let db: DatabaseClient;
let svc: ApprovalService;
let adminKey: string;
let owner: Actor;
let other: Actor;
let adm: Actor;
let adm2: Actor;
let seq = 0;
const raw = (): any => (db as any).session.client;
const row = (id: string): any =>
  raw().prepare('SELECT * FROM approval_requests WHERE approval_id=?').get(id);
const json = (res: { body: string }): any => JSON.parse(res.body);

async function login(username: string, userId: string): Promise<Actor> {
  const client = makeAdminClient(server.getAdminServer());
  const res = await client.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { username, password: PW },
  });
  expect(res.statusCode).toBe(200);
  const sc = res.headers['set-cookie'];
  const list = (Array.isArray(sc) ? sc : [String(sc)]).map(String);
  const hit = list.find(c => c.startsWith('sessionId='));
  return { userId, username, client, cookie: String(hit).split(';')[0]! };
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
const reauth = (a: Actor, password = PW) => call(a, 'POST', '/v1/auth/reauth', { password });
const decideUrl = (scope: 'admin' | 'user', id: string): string =>
  scope === 'admin'
    ? `/v1/admin/approvals/${id}/decision`
    : `/v1/users/me/approvals/${id}/decision`;
const decide = (a: Actor, scope: 'admin' | 'user', id: string, hash: string, d = 'approve') =>
  call(a, 'POST', decideUrl(scope, id), { decision: d, expected_args_hash: hash });

async function mk(
  who: Actor,
  required: 'owner' | 'admin'
): Promise<{ id: string; hash: string; clientId: string; grantId: string }> {
  const n = ++seq;
  const clientId = crypto.randomUUID();
  const grantId = crypto.randomUUID();
  const ts = new Date().toISOString();
  const r = raw();
  r.prepare(
    `INSERT INTO clients (client_id, client_name, key_prefix, key_hash, user_id, status, created_at) VALUES (?,?,?,?,?,?,?)`
  ).run(clientId, clientId, 'p', `h${n}`, who.userId, 'active', ts);
  r.prepare(
    `INSERT INTO agent_grants (grant_id, user_id, bound_client_id, label, scopes, resource, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?)`
  ).run(grantId, who.userId, clientId, grantId, '["tools"]', 'https://x/mcp', ts, FAR);
  const res = await svc.createOrFind({
    grantId,
    boundClientId: clientId,
    userId: who.userId,
    mcpId: 'bbm1',
    toolName: `tool_${n}`,
    argsHash: HASH(n),
    pinHash: null,
    required,
    preview: `{"title":"${CANARY}"}`,
    via: 'mcp',
    disclosureMode: 'full',
    grantExpiresAt: FAR,
  } as any);
  if (res.kind !== 'created') throw new Error(`create ${res.kind}`);
  return { id: res.request.approval_id, hash: HASH(n), clientId, grantId };
}

let audits: Array<{ action: string; meta: Record<string, unknown> }> = [];

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'amb-appr-api-bb-'));
  const pre = await initializeDatabase({
    type: 'sqlite',
    sqliteFilePath: path.join(tmp, 'ambassador.db'),
    seedOnInit: true,
  });
  await runMigrations(pre);
  adminKey = (await createAdminKey(pre, tmp)).admin_key;
  await closeDatabase(pre);

  // Fake only Date BEFORE the server is built so StepUpStore (default clock = Date.now) is fakeable.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);

  server = new AmbassadorServer({ dataDir: tmp, port: 0, host: '127.0.0.1' } as never);
  await server.initialize();
  db = (server as any).db;
  svc = (server as any).approvals;
  const orig = (svc as any).audit as (a: string, m: Record<string, unknown>) => void;
  (svc as any).audit = (action: string, meta: Record<string, unknown>): void => {
    audits.push({ action, meta });
    orig(action, meta);
  };
  const mkUser = (username: string, is_admin: boolean) =>
    createUser(db, { username, password: PW, display_name: username, is_admin });
  const uo = await mkUser('bbowner', false);
  const ux = await mkUser('bbother', false);
  const ua = await mkUser('bbadm', true);
  const ub = await mkUser('bbadm2', true);
  raw()
    .prepare(
      `INSERT INTO mcp_catalog (mcp_id, name, display_name, transport_type, created_at, updated_at) VALUES (?,?,?,?,?,?)`
    )
    .run('bbm1', 'bbm1', 'bbm1', 'stdio', T0.toISOString(), T0.toISOString());
  owner = await login('bbowner', uo.user_id);
  other = await login('bbother', ux.user_id);
  adm = await login('bbadm', ua.user_id);
  adm2 = await login('bbadm2', ub.user_id);
});
afterAll(async () => {
  vi.useRealTimers();
  try {
    await server.stop();
  } catch {
    /* ignore */
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('credential refusal on every approval route', () => {
  const routes: Array<['GET' | 'POST', string]> = [
    ['GET', '/v1/admin/approvals'],
    ['GET', '/v1/admin/approvals/summary'],
    ['GET', '/v1/admin/approvals/apr_nope'],
    ['POST', '/v1/admin/approvals/apr_nope/decision'],
    ['GET', '/v1/users/me/approvals'],
    ['GET', '/v1/users/me/approvals/summary'],
    ['GET', '/v1/users/me/approvals/apr_nope'],
    ['POST', '/v1/users/me/approvals/apr_nope/decision'],
    ['POST', '/v1/auth/reauth'],
  ];
  const payloadFor = (m: string) =>
    m === 'POST'
      ? { payload: { decision: 'approve', expected_args_hash: HASH(1), password: PW } }
      : {};

  const variants: Array<[string, (a: Actor) => Record<string, string>]> = [
    ['valid admin key + valid admin session', a => ({ 'x-admin-key': adminKey, cookie: a.cookie })],
    ['valid admin key, no session', () => ({ 'x-admin-key': adminKey })],
    ['bogus admin key + session', a => ({ 'x-admin-key': 'amb_ak_bogus', cookie: a.cookie })],
    ['empty admin key + session', a => ({ 'x-admin-key': '', cookie: a.cookie })],
    ['bearer + session', a => ({ authorization: 'Bearer amb_pk_bogus', cookie: a.cookie })],
    ['basic auth, no session', () => ({ authorization: 'Basic Zm9vOmJhcg==' })],
    ['empty authorization + session', a => ({ authorization: '', cookie: a.cookie })],
  ];

  for (const [name, mkHeaders] of variants) {
    it(`403 + audit approval_credential_refused: ${name}`, async () => {
      for (const [method, url] of routes) {
        audits = [];
        const res = await adm.client.inject({
          method,
          url,
          headers: mkHeaders(adm),
          ...payloadFor(method),
        });
        // A syntactically-present but invalid admin key on /v1/admin/* or on a POST is already rejected (401)
        // by the global admin-key hook before the approval guard; that is a refusal too.
        const globalReject =
          /bogus|empty admin key/.test(name) && (url.startsWith('/v1/admin/') || method === 'POST');
        if (globalReject && res.statusCode === 401) continue;
        expect(res.statusCode, `${method} ${url}`).toBe(403);
        expect(
          audits.some(a => a.action === 'approval_credential_refused'),
          `audit for ${method} ${url}`
        ).toBe(true);
        const refused = audits.find(a => a.action === 'approval_credential_refused')!;
        expect(JSON.stringify(refused.meta)).not.toContain(adminKey);
      }
    });
  }

  it('an admin key can never decide: the request stays pending', async () => {
    const q = await mk(owner, 'owner');
    const res = await adm.client.inject({
      method: 'POST',
      url: decideUrl('admin', q.id),
      headers: { 'x-admin-key': adminKey },
      payload: { decision: 'approve', expected_args_hash: q.hash },
    });
    expect(res.statusCode).toBe(403);
    expect(row(q.id).status).toBe('pending');
  });

  it('401 without any credential on every route (not 403/200)', async () => {
    const anon = makeAdminClient(server.getAdminServer());
    for (const [method, url] of routes) {
      const res = await anon.inject({ method, url, ...payloadFor(method) });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });
});

describe('check order: 401 -> 403 csrf -> 400 body -> 404 -> 403 role -> 428 -> 409', () => {
  it('missing CSRF beats everything after it (even a nonexistent id): 403 and no state change', async () => {
    const q = await mk(owner, 'owner');
    const res = await server.getAdminServer().inject({
      method: 'POST',
      url: decideUrl('user', q.id),
      headers: { cookie: owner.cookie },
      payload: { decision: 'approve', expected_args_hash: q.hash },
    });
    expect(res.statusCode).toBe(403);
    expect(row(q.id).status).toBe('pending');
    const res2 = await server.getAdminServer().inject({
      method: 'POST',
      url: decideUrl('user', 'apr_does_not_exist'),
      headers: { cookie: owner.cookie },
      payload: { decision: 'approve', expected_args_hash: q.hash },
    });
    expect(res2.statusCode).toBe(403);
  });

  it('malformed / nonexistent / foreign ids are all the same 404 for a user', async () => {
    const q = await mk(owner, 'owner');
    const bodies = new Set<string>();
    for (const id of ['apr_does_not_exist', '../../etc/passwd', 'x'.repeat(90), q.id]) {
      const res = await decide(other, 'user', encodeURIComponent(id), q.hash);
      expect(res.statusCode, id.slice(0, 20)).toBe(404);
      bodies.add(res.body);
      const det = await call(other, 'GET', `/v1/users/me/approvals/${encodeURIComponent(id)}`);
      expect(det.statusCode).toBe(404);
    }
    expect(bodies.size).toBe(1); // foreign id is indistinguishable from nonexistent
    expect(row(q.id).status).toBe('pending');
  });

  it('404 beats 403: a non-owner probing an admin-class request sees 404, not 403', async () => {
    const q = await mk(owner, 'admin');
    const res = await decide(other, 'user', q.id, q.hash);
    expect(res.statusCode).toBe(404);
  });

  it('403 role beats 428: owner on admin-class request -> 403 (no reauth prompt)', async () => {
    const q = await mk(owner, 'admin');
    const res = await decide(owner, 'user', q.id, q.hash);
    expect(res.statusCode).toBe(403);
    expect(row(q.id).status).toBe('pending');
  });

  it('403 role beats 428: admin scope on an owner-class request -> 403 even without step-up', async () => {
    const q = await mk(owner, 'owner');
    const res = await decide(adm, 'admin', q.id, q.hash);
    expect(res.statusCode).toBe(403);
    expect(row(q.id).status).toBe('pending');
  });

  it('non-admin on admin scope -> 403 for existing and nonexistent ids alike (no existence oracle)', async () => {
    const q = await mk(owner, 'admin');
    const a = await decide(other, 'admin', q.id, q.hash);
    const b = await decide(other, 'admin', 'apr_does_not_exist', q.hash);
    expect(a.statusCode).toBe(403);
    expect(b.statusCode).toBe(403);
    expect(a.body).toBe(b.body);
  });

  it('404 beats 428: admin without step-up on a nonexistent id -> 404', async () => {
    const res = await decide(adm2, 'admin', 'apr_does_not_exist', HASH(1));
    expect(res.statusCode).toBe(404);
  });

  it('invalid body is 400 before visibility (nonexistent id + bad body)', async () => {
    const res = await call(owner, 'POST', decideUrl('user', 'apr_does_not_exist'), {
      decision: 'maybe',
    });
    expect(res.statusCode).toBe(400);
  });

  it('428 for admin-class without step-up leaves the request pending and carries the code', async () => {
    const q = await mk(owner, 'admin');
    const res = await decide(adm, 'admin', q.id, q.hash);
    expect(res.statusCode).toBe(428);
    expect(json(res).error?.code ?? json(res).code).toBeTruthy();
    expect(row(q.id).status).toBe('pending');
  });

  it('409 after step-up: stale expected_args_hash leaves it pending; lost race is 409', async () => {
    expect((await reauth(adm)).statusCode).toBe(200);
    const q = await mk(owner, 'admin');
    const stale = await decide(adm, 'admin', q.id, HASH(999_999));
    expect(stale.statusCode).toBe(409);
    expect(row(q.id).status).toBe('pending');
    const ok = await decide(adm, 'admin', q.id, q.hash);
    expect(ok.statusCode).toBe(200);
    const again = await decide(adm, 'admin', q.id, q.hash);
    expect(again.statusCode).toBe(409);
    const deny = await decide(adm, 'admin', q.id, q.hash, 'deny');
    expect(deny.statusCode).toBe(409);
    expect(row(q.id).status).toBe('approved');
  });

  it('owner-class owner decision needs no step-up (200) and cannot be re-decided (409)', async () => {
    const q = await mk(owner, 'owner');
    expect((await decide(owner, 'user', q.id, q.hash)).statusCode).toBe(200);
    expect((await decide(owner, 'user', q.id, q.hash, 'deny')).statusCode).toBe(409);
  });

  it('concurrent approve + deny over HTTP: exactly one 200, the rest 409', async () => {
    const q = await mk(owner, 'owner');
    const rs = await Promise.all([
      decide(owner, 'user', q.id, q.hash, 'approve'),
      decide(owner, 'user', q.id, q.hash, 'deny'),
      decide(owner, 'user', q.id, q.hash, 'approve'),
      decide(owner, 'user', q.id, q.hash, 'deny'),
    ]);
    const codes = rs.map(r => r.statusCode).sort();
    expect(codes.filter(c => c === 200).length).toBe(1);
    expect(codes.filter(c => c === 409).length).toBe(3);
  });
});

describe('step-up window (fake clock)', () => {
  it('window is 300s from reauth: ok at +299s, 428 at +301s, fresh reauth reopens', async () => {
    vi.setSystemTime(new Date(T0.getTime() + 3_600_000));
    const base = Date.now();
    const re = await reauth(adm2);
    expect(re.statusCode).toBe(200);
    const body = json(re).data;
    expect(body.window_seconds).toBe(300);
    expect(Date.parse(body.reauthenticated_until)).toBe(base + 300_000);

    const a = await mk(owner, 'admin');
    vi.setSystemTime(new Date(base + 299_000));
    expect((await decide(adm2, 'admin', a.id, a.hash)).statusCode).toBe(200);

    const b = await mk(owner, 'admin');
    expect((await decide(adm2, 'admin', b.id, b.hash)).statusCode).toBe(200); // window is not one-shot

    const c = await mk(owner, 'admin');
    vi.setSystemTime(new Date(base + 301_000));
    expect((await decide(adm2, 'admin', c.id, c.hash)).statusCode).toBe(428);
    expect(row(c.id).status).toBe('pending');

    expect((await reauth(adm2)).statusCode).toBe(200);
    expect((await decide(adm2, 'admin', c.id, c.hash)).statusCode).toBe(200);
  });

  it('step-up is per session: a second login of the same admin is not fresh; other admins are not fresh', async () => {
    vi.setSystemTime(new Date(T0.getTime() + 7_200_000));
    expect((await reauth(adm)).statusCode).toBe(200);
    const sameUserNewSession = await login('bbadm', adm.userId);
    const q = await mk(owner, 'admin');
    expect((await decide(sameUserNewSession, 'admin', q.id, q.hash)).statusCode).toBe(428);
    expect((await decide(adm2, 'admin', q.id, q.hash)).statusCode).toBe(428);
    expect((await decide(adm, 'admin', q.id, q.hash)).statusCode).toBe(200);
  });

  it("a user cannot reauth with another user's password, and a failed reauth opens no window", async () => {
    vi.setSystemTime(new Date(T0.getTime() + 10_800_000));
    const bad = await reauth(adm2, WRONG_PW);
    expect(bad.statusCode).toBe(401);
    const q = await mk(owner, 'admin');
    expect((await decide(adm2, 'admin', q.id, q.hash)).statusCode).toBe(428);
    expect(bad.body).not.toContain(WRONG_PW);
  });

  it('wrong password: generic 401, audited without password material, 429 after repeated failures', async () => {
    audits = [];
    const victim = await login('bbother', other.userId);
    let last = 0;
    for (let i = 0; i < 12; i++) {
      const r = await reauth(victim, `${WRONG_PW}-${i}`);
      last = r.statusCode;
      expect(r.body).not.toContain('WRONG-PASSWORD');
      if (r.statusCode === 429) break;
    }
    expect(last).toBe(429);
    const failed = audits.filter(a => a.action === 'approval_reauth_failed');
    expect(failed.length).toBeGreaterThan(0);
    expect(JSON.stringify(audits)).not.toContain('WRONG-PASSWORD');
    // even the correct password is refused while limited (no oracle through the limiter)
    expect((await reauth(victim)).statusCode).toBe(429);
  });
});

describe('principal re-read at decision time', () => {
  it('demoted admin (fresh step-up) loses the admin scope immediately: 403, request pending', async () => {
    vi.setSystemTime(new Date(T0.getTime() + 14_400_000));
    const u = await createUser(db, {
      username: 'bbtemp1',
      password: PW,
      display_name: 'bbtemp1',
      is_admin: true,
    });
    const t = await login('bbtemp1', u.user_id);
    expect((await reauth(t)).statusCode).toBe(200);
    const q = await mk(owner, 'admin');
    raw().prepare('UPDATE users SET is_admin=0 WHERE user_id=?').run(u.user_id);
    expect((await decide(t, 'admin', q.id, q.hash)).statusCode).toBe(403);
    expect((await call(t, 'GET', '/v1/admin/approvals')).statusCode).toBe(403);
    expect(row(q.id).status).toBe('pending');
  });

  it('disabled user with a live session gets 401 on every route', async () => {
    const u = await createUser(db, {
      username: 'bbtemp2',
      password: PW,
      display_name: 'bbtemp2',
    });
    const t = await login('bbtemp2', u.user_id);
    const q = await mk(t, 'owner');
    raw().prepare("UPDATE users SET status='suspended' WHERE user_id=?").run(u.user_id);
    expect((await call(t, 'GET', '/v1/users/me/approvals')).statusCode).toBe(401);
    expect((await decide(t, 'user', q.id, q.hash)).statusCode).toBe(401);
    expect((await reauth(t)).statusCode).toBe(401);
    expect(row(q.id).status).toBe('pending');
  });
});

describe('read paths never leak the argument preview', () => {
  it('list/summary never carry it; detail only to the visible party; terminal detail is null', async () => {
    const q = await mk(owner, 'owner');
    const list = await call(owner, 'GET', '/v1/users/me/approvals');
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(CANARY);
    const sum = await call(owner, 'GET', '/v1/users/me/approvals/summary');
    expect(sum.body).not.toContain(CANARY);
    const adminList = await call(adm, 'GET', '/v1/admin/approvals');
    expect(adminList.body).not.toContain(CANARY);
    expect((await call(other, 'GET', `/v1/users/me/approvals/${q.id}`)).body).not.toContain(CANARY);
    expect(json(await call(owner, 'GET', `/v1/users/me/approvals/${q.id}`)).data.preview).toContain(
      CANARY
    );
    expect((await decide(owner, 'user', q.id, q.hash, 'deny')).body).not.toContain(CANARY);
    const after = await call(owner, 'GET', `/v1/users/me/approvals/${q.id}`);
    expect(json(after).data.preview).toBeNull();
    expect(after.body).not.toContain(CANARY);
  });

  it('error bodies for refused/failed decisions never contain the preview or hash internals', async () => {
    const q = await mk(owner, 'admin');
    for (const res of [
      await decide(owner, 'user', q.id, q.hash),
      await decide(other, 'user', q.id, q.hash),
      await decide(adm2, 'admin', q.id, HASH(424242)),
    ]) {
      expect(res.body).not.toContain(CANARY);
      expect(res.body).not.toMatch(/SQLITE|at .*\.ts|node_modules/);
    }
  });

  it('after shutdown: no preview and no password in the audit files', async () => {
    await server.stop();
    const dir = path.join(tmp, 'audit');
    const text = fs
      .readdirSync(dir)
      .map(f => fs.readFileSync(path.join(dir, f), 'utf8'))
      .join('\n');
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain('WRONG-PASSWORD');
    expect(text).not.toContain(PW);
    expect(text).not.toContain(adminKey);
    expect(text).toContain('approval_credential_refused');
    expect(text).toContain('approval_reauth_failed');
  });
});
