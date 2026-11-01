/**
 * ADR-020 P5: /mcp resource server — auth, scoping, rate limits, revocation, pre-authenticated
 * session confinement.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  initializeDatabase,
  runMigrations,
  closeDatabase,
  createGroup,
  addUserToGroup,
  grantGroupAccess,
  AgentEndpointConfigSchema,
  Pipeline,
  type DatabaseClient,
} from '@mcpambassador/core';
import { registerAgentMcpRoutes } from '../src/routes/agent-mcp.js';
import {
  createAgentEndpointDeps,
  resolveAgentEndpointConfig,
  createGrant,
  revokeGrant,
  type AgentEndpointDeps,
} from '../src/services/agent-endpoint/index.js';
import { UserMcpPool } from '../src/downstream/index.js';

const raw = (db: DatabaseClient): any => (db as any).session.client;
const MCP_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

let dir: string;
let db: DatabaseClient;
let app: FastifyInstance;
let deps: AgentEndpointDeps;
let events: any[];
let invoked: string[];
let ensured: string[];
let authnCalls: number;
let userPool: UserMcpPool;

const CATALOG = [
  { name: 'gh_issue', description: 'issue', inputSchema: { type: 'object' }, source_mcp: 'github' },
  { name: 'fs_read', description: 'read', inputSchema: { type: 'object' }, source_mcp: 'files' },
];

async function build(cfgOverride: Record<string, unknown> = {}): Promise<void> {
  const cfg = resolveAgentEndpointConfig(
    AgentEndpointConfigSchema.parse({ enabled: true, ...cfgOverride }),
    { issuer: 'https://amb.test:9443', agentBaseUrl: 'https://amb.test:8443' }
  );
  deps = createAgentEndpointDeps(db, cfg, {
    emit: (e: any) => {
      events.push(e);
      return Promise.resolve();
    },
  } as any);
  const authn = {
    id: 'api_key',
    authenticate: () => {
      authnCalls++;
      return Promise.resolve({ success: false });
    },
  };
  const authz = {
    id: 'test',
    authorize: () => Promise.resolve({ decision: 'permit', reason: 'ok' }),
  };
  const audit = {
    emit: (e: any) => {
      events.push(e);
      return Promise.resolve();
    },
  };
  const pipeline = new Pipeline(authn as any, authz as any, audit as any);
  userPool = new UserMcpPool({ healthCheckIntervalMs: 0 } as any);
  const toolDeps = {
    db,
    authz,
    pipeline,
    toolRouter: { getIsolationAwareToolCatalog: () => Promise.resolve(CATALOG) },
    mcpManager: {
      getToolDescriptor: (n: string) => CATALOG.find(t => t.name === n),
      invokeTool: (r: any) => {
        invoked.push(r.tool_name);
        return Promise.resolve({ content: [{ type: 'text', text: 'done' }] });
      },
    },
    userPool,
  } as any;
  app = Fastify();
  await registerAgentMcpRoutes(app, deps, {
    toolDeps,
    userPool,
    ensureUserMcps: (u: string) => {
      ensured.push(u);
      return Promise.resolve();
    },
  });
  await app.ready();
}

beforeEach(async () => {
  events = [];
  invoked = [];
  ensured = [];
  authnCalls = 0;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amb-p5-'));
  db = await initializeDatabase({ type: 'sqlite', sqliteFilePath: path.join(dir, 'a.db') });
  await runMigrations(db);
  const ts = new Date().toISOString();
  raw(db)
    .prepare(
      `INSERT INTO users (user_id, username, display_name, created_at, updated_at) VALUES (?,?,?,?,?)`
    )
    .run('u1', 'u1', 'u1', ts, ts);
  raw(db)
    .prepare(
      `INSERT INTO clients (client_id, client_name, key_prefix, key_hash, user_id, status, created_at) VALUES (?,?,?,?,?,?,?)`
    )
    .run('k1', 'k1', 'p', 'h', 'u1', 'active', ts);
  for (const [id, name] of [
    ['m1', 'github'],
    ['m2', 'files'],
  ] as const) {
    raw(db)
      .prepare(
        `INSERT INTO mcp_catalog (mcp_id, name, display_name, transport_type, created_at, updated_at) VALUES (?,?,?,?,?,?)`
      )
      .run(id, name, name, 'stdio', ts, ts);
    raw(db)
      .prepare(
        `INSERT INTO client_mcp_subscriptions (subscription_id, client_id, mcp_id, status, subscribed_at, updated_at) VALUES (?,?,?,?,?,?)`
      )
      .run(`s-${id}`, 'k1', id, 'active', ts, ts);
  }
  // ADR-025 M2: the owner must hold the MCPs through an active group.
  const grp = await createGroup(db, { name: 'g-u1', description: '', created_by: 'test' } as never);
  await addUserToGroup(db, { user_id: 'u1', group_id: grp.group_id, assigned_by: 'test' });
  for (const mcp_id of ['m1', 'm2']) {
    await grantGroupAccess(db, { mcp_id, group_id: grp.group_id, assigned_by: 'test' });
  }
});
afterEach(async () => {
  await app.close();
  userPool.shutdown().catch(() => undefined);
  await closeDatabase(db);
  fs.rmSync(dir, { recursive: true, force: true });
});

const rpc = (method: string, params?: unknown, id = 1): any => ({
  jsonrpc: '2.0',
  id,
  method,
  ...(params ? { params } : {}),
});
const post = (token: string | null, body: unknown, extra: Record<string, string> = {}): any =>
  app.inject({
    method: 'POST',
    url: '/mcp',
    headers: { ...MCP_HEADERS, ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
    payload: body as any,
  });
const grant = async (scopes = ['mcp:*'], allow?: string[]): Promise<any> =>
  createGrant(deps, 'u1', {
    bound_client_id: 'k1',
    scopes,
    ...(allow ? { tool_allowlist: allow } : {}),
  } as any);

describe('/mcp', () => {
  it('serves protected resource metadata from config', async () => {
    await build();
    for (const url of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
    ]) {
      const m = (
        await app.inject({ method: 'GET', url, headers: { host: 'evil.example' } })
      ).json();
      expect(m.resource).toBe('https://amb.test:8443/mcp');
      expect(m.authorization_servers).toEqual(['https://amb.test:9443']);
    }
  });

  it('401 with resource_metadata challenge; token in query rejected; bad origin 403', async () => {
    await build();
    const g = await grant();
    const r = await post(null, rpc('tools/list'));
    expect(r.statusCode).toBe(401);
    expect(r.headers['www-authenticate']).toContain(
      'resource_metadata="https://amb.test:8443/.well-known/oauth-protected-resource/mcp"'
    );
    const bad = await post('amb_at_nope', rpc('tools/list'));
    expect(bad.statusCode).toBe(401);
    expect(bad.headers['www-authenticate']).toContain('error="invalid_token"');
    const q = await app.inject({
      method: 'POST',
      url: `/mcp?access_token=${g.access_token}`,
      headers: { ...MCP_HEADERS, authorization: `Bearer ${g.access_token}` },
      payload: rpc('tools/list'),
    });
    expect(q.statusCode).toBe(401);
    const o = await post(g.access_token, rpc('tools/list'), { origin: 'https://evil.example' });
    expect(o.statusCode).toBe(403);
    expect(events.some(e => e.action === 'agent_auth_failure')).toBe(true);
  });

  it('tools/list is scope ∩ allowlist, spawns user MCPs and counts as activity', async () => {
    await build();
    const all = await grant(['mcp:*']);
    const names = (r: any): string[] => r.json().result.tools.map((t: any) => t.name);
    const r1 = await post(all.access_token, rpc('tools/list'));
    expect(r1.statusCode).toBe(200);
    expect(names(r1).sort()).toEqual(['fs_read', 'gh_issue']);
    expect(ensured).toEqual(['u1']);
    expect(userPool.hasRecentActivity('u1')).toBe(true);

    const gh = await grant(['mcp:github']);
    expect(names(await post(gh.access_token, rpc('tools/list')))).toEqual(['gh_issue']);

    const allow = await grant(['mcp:*'], ['fs_read']);
    expect(names(await post(allow.access_token, rpc('tools/list')))).toEqual(['fs_read']);
  });

  it('tools/call runs the pipeline with the pre-authenticated session (authn never called) and audits bound client', async () => {
    await build();
    const g = await grant(['mcp:github']);
    const ok = await post(g.access_token, rpc('tools/call', { name: 'gh_issue', arguments: {} }));
    expect(ok.statusCode).toBe(200);
    expect(ok.json().result.isError).toBeFalsy();
    expect(invoked).toEqual(['gh_issue']);
    expect(authnCalls).toBe(0);
    const inv = events.find(e => e.action === 'tool_invocation');
    expect(inv.client_id).toBe('k1');
    expect(inv.session_id).toBe(`agent:${g.grant_id}`);

    // out-of-scope tool is refused with 403 insufficient_scope even though the client could call it
    const denied = await post(
      g.access_token,
      rpc('tools/call', { name: 'fs_read', arguments: {} }, 2)
    );
    expect(denied.statusCode).toBe(403);
    expect(String(denied.headers['www-authenticate'])).toContain('error="insufficient_scope"');
    expect(invoked).toEqual(['gh_issue']);
  });

  it('revoked grant, deleted bound client and disabled user stop working on the next call', async () => {
    await build();
    const g = await grant();
    expect((await post(g.access_token, rpc('tools/list'))).statusCode).toBe(200);
    await revokeGrant(deps, { user_id: 'u1', admin: false }, g.grant_id);
    expect((await post(g.access_token, rpc('tools/list'))).statusCode).toBe(401);

    const g2 = await grant();
    raw(db).prepare(`UPDATE clients SET status='suspended' WHERE client_id='k1'`).run();
    expect((await post(g2.access_token, rpc('tools/list'))).statusCode).toBe(401);
    raw(db).prepare(`UPDATE clients SET status='active' WHERE client_id='k1'`).run();
    raw(db).prepare(`UPDATE users SET status='disabled' WHERE user_id='u1'`).run();
    expect((await post(g2.access_token, rpc('tools/list'))).statusCode).toBe(401);
  });

  it('rate-limits tools/call per grant (429) and caps concurrency per grant', async () => {
    await build({ rate_limits: { tool_calls_per_minute_per_grant: 2 } });
    const g = await grant();
    const call = (i: number): any =>
      post(g.access_token, rpc('tools/call', { name: 'gh_issue', arguments: {} }, i));
    expect((await call(1)).statusCode).toBe(200);
    expect((await call(2)).statusCode).toBe(200);
    const limited = await call(3);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();

    // concurrency cap: occupy all slots, next request is refused
    const release: Array<() => void> = [];
    for (let i = 0; i < deps.config.max_streams_per_grant; i++) {
      release.push(deps.streams.acquire(g.grant_id, deps.config.max_streams_per_grant, () => {})!);
    }
    expect(
      deps.streams.acquire(g.grant_id, deps.config.max_streams_per_grant, () => {})
    ).toBeNull();
    release.forEach(r => r());
  });

  it('GET/DELETE are 405 after auth (stateless); failed-auth throttle returns 429', async () => {
    await build({ rate_limits: { failed_auth_per_minute: 2 } });
    const g = await grant();
    const get = await app.inject({
      method: 'GET',
      url: '/mcp',
      headers: { authorization: `Bearer ${g.access_token}` },
    });
    expect(get.statusCode).toBe(405);
    expect(get.headers.allow).toBe('POST');
    const unauth = await app.inject({ method: 'DELETE', url: '/mcp' });
    expect(unauth.statusCode).toBe(401);
    await post('amb_at_x', rpc('ping'));
    expect((await post('amb_at_x', rpc('ping'))).statusCode).toBe(429);
  });

  it('POST without content-type is 401 + audited (auth before parsing); authed DELETE with empty JSON body is 405', async () => {
    await build();
    const g = await grant();
    events.length = 0;
    const noCt = await app.inject({ method: 'POST', url: '/mcp' });
    expect(noCt.statusCode).toBe(401);
    expect(events.some(e => e.action === 'agent_auth_failure')).toBe(true);
    const del = await app.inject({
      method: 'DELETE',
      url: '/mcp',
      headers: { authorization: `Bearer ${g.access_token}`, 'content-type': 'application/json' },
    });
    expect(del.statusCode).toBe(405);
    expect(del.headers.allow).toBe('POST');
  });

  it('revocation aborts in-flight requests of the grant', async () => {
    await build();
    const g = await grant();
    const abort = vi.fn();
    deps.streams.acquire(g.grant_id, 4, abort);
    await revokeGrant(deps, { user_id: 'u1', admin: false }, g.grant_id);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(deps.streams.count(g.grant_id)).toBe(0);
  });
});

describe('preAuthenticatedSession confinement', () => {
  it('is reachable only from internal code: no HTTP route/header/body can set it', async () => {
    await build();
    // Nothing in the request is ever consulted for a session: a forged field in body/headers
    // on a tool-invocation path without a valid token is just an unauthenticated request.
    const forged = await post(
      null,
      {
        ...rpc('tools/call', { name: 'gh_issue', arguments: {} }),
        preAuthenticatedSession: {
          user_id: 'u1',
          bound_client_id: 'k1',
          grant_id: 'g',
          scopes: ['mcp:*'],
        },
      },
      { 'x-pre-authenticated-session': '1' }
    );
    expect(forged.statusCode).toBe(401);
    expect(invoked).toEqual([]);

    // Source-level guard: only tool-service passes the option, and only from agent-mcp.
    const srcRoot = path.join(__dirname, '..', 'src');
    const hits: string[] = [];
    const walk = (d: string): void => {
      for (const f of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, f.name);
        if (f.isDirectory()) walk(p);
        else if (
          f.name.endsWith('.ts') &&
          fs.readFileSync(p, 'utf8').includes('preAuthenticatedSession')
        )
          hits.push(path.relative(srcRoot, p));
      }
    };
    walk(srcRoot);
    expect(hits.sort()).toEqual(['services/tool-service.ts']);
  });
});
