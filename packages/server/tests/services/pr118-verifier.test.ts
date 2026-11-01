/**
 * PR #118 verifier tests (independent of the builder's client-revoke-ordering.test.ts):
 *  1. delete racing a token exchange never leaves a live grant
 *  2. disable aborts in-flight streams; re-enable restores access
 *  3. oauth grant with NULL client_id -> 401 on /mcp over HTTP
 *  4. booting twice / legacy DB without `kind` migrates idempotently
 *  5. resource_url computed when enabled, null when disabled
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import {
  initializeDatabase,
  runMigrations,
  closeDatabase,
  AgentEndpointConfigSchema,
  type DatabaseClient,
} from '@mcpambassador/core';
import { AGENT_MCP_ROUTE } from '@mcpambassador/contracts';
import {
  createAgentEndpointDeps,
  resolveAgentEndpointConfig,
  startAuthorization,
  decideConsent,
  exchangeToken,
  validateAgentToken,
  adminCreateClient,
  adminDeleteClient,
  adminSetClientDisabled,
  type AgentEndpointDeps,
} from '../../src/services/agent-endpoint/index.js';
import {
  startAgentTestServer,
  stopAgentTestServer,
  restartAgentTestServer,
  agentEndpointOpts,
  createUser,
  loginSession,
  TEST_RESOURCE_BASE,
  type AgentTestServer,
} from '../agent-endpoint/helpers.js';
import { registerAdminClient, fullFlow } from '../agent-endpoint/oauth-flow-helpers.js';

const RESOURCE = 'https://amb.test:8443/mcp';
const REDIRECT = 'http://localhost:7777/cb';
const raw = (db: DatabaseClient): any => (db as any).session.client;
const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

describe('service level', () => {
  let dir: string;
  let db: DatabaseClient;
  let deps: AgentEndpointDeps;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amb-v118-'));
    db = await initializeDatabase({ type: 'sqlite', sqliteFilePath: path.join(dir, 'a.db') });
    await runMigrations(db);
    const ts = new Date().toISOString();
    const r = raw(db);
    r.prepare(
      `INSERT INTO users (user_id, username, display_name, created_at, updated_at) VALUES (?,?,?,?,?)`
    ).run('u1', 'u1', 'u1', ts, ts);
    r.prepare(
      `INSERT INTO clients (client_id, client_name, key_prefix, key_hash, user_id, status, created_at) VALUES (?,?,?,?,?,?,?)`
    ).run('k1', 'k1', 'p', 'h', 'u1', 'active', ts);
    const cfg = resolveAgentEndpointConfig(
      AgentEndpointConfigSchema.parse({ enabled: true, dynamic_client_registration: true }),
      { issuer: 'https://amb.test:9443', agentBaseUrl: 'https://amb.test:8443' }
    );
    deps = createAgentEndpointDeps(db, cfg, { emit: () => Promise.resolve() } as any);
  });
  afterEach(async () => {
    await closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const newClient = async (): Promise<string> =>
    (
      await adminCreateClient(
        deps,
        'admin',
        { client_name: 'Agent', redirect_uris: [REDIRECT] },
        '1.1.1.1'
      )
    ).client_id;

  async function codeFor(clientId: string): Promise<{ code: string; verifier: string }> {
    const p = pkce();
    const { requestId } = await startAuthorization(deps, {
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: p.challenge,
      code_challenge_method: 'S256',
      resource: RESOURCE,
      scope: 'mcp:*',
      state: 's',
    });
    const res = await decideConsent(deps, 'u1', requestId, {
      decision: 'approve',
      bound_client_id: 'k1',
      scopes: ['mcp:*'],
      ttl_seconds: 3600,
    });
    return {
      code: new URL(res.redirect_url).searchParams.get('code')!,
      verifier: p.verifier,
    };
  }

  const tokenReq = (clientId: string, code: string, verifier: string) =>
    ({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
      resource: RESOURCE,
    }) as const;

  it('delete racing a token exchange never leaves a live grant (both orders, 30 rounds)', async () => {
    for (let i = 0; i < 30; i++) {
      const clientId = await newClient();
      const { code, verifier } = await codeFor(clientId);
      const ex = () => exchangeToken(deps, tokenReq(clientId, code, verifier), '1.1.1.1');
      const del = () => adminDeleteClient(deps, 'admin', clientId, '1.1.1.1');
      const [a, b] =
        i % 2 === 0
          ? await Promise.allSettled([ex(), del()])
          : await (async () => {
              const d = del();
              const e = ex();
              const rd = await Promise.allSettled([d]);
              const re = await Promise.allSettled([e]);
              return [re[0]!, rd[0]!] as const;
            })();
      // the delete must succeed; the exchange may succeed or be rejected, never throw something odd
      expect(b.status).toBe('fulfilled');
      if (a.status === 'fulfilled') {
        const tok = (a.value as any).access_token as string;
        expect(await validateAgentToken(deps, tok)).toEqual({ ok: false, reason: 'revoked' });
      }
      const live = raw(db)
        .prepare(
          `SELECT COUNT(*) AS n FROM agent_grants
           WHERE kind='oauth' AND revoked_at IS NULL
             AND (client_id IS NULL OR client_id NOT IN (SELECT client_id FROM oauth_clients))`
        )
        .get();
      expect(live.n).toBe(0);
    }
    const stillLive = raw(db)
      .prepare(`SELECT COUNT(*) AS n FROM agent_grants WHERE kind='oauth' AND revoked_at IS NULL`)
      .get();
    expect(stillLive.n).toBe(0);
  });

  it('disable aborts an in-flight stream; re-enable restores access', async () => {
    const clientId = await newClient();
    const { code, verifier } = await codeFor(clientId);
    const t = (await exchangeToken(deps, tokenReq(clientId, code, verifier), '1.1.1.1')) as any;
    const grantId = raw(db)
      .prepare(`SELECT grant_id FROM agent_grants WHERE client_id=?`)
      .get(clientId).grant_id as string;

    let aborted = 0;
    const release = deps.streams.acquire(grantId, 5, () => aborted++);
    expect(release).not.toBeNull();
    expect(deps.streams.count(grantId)).toBe(1);

    await adminSetClientDisabled(deps, 'admin', clientId, true, '1.1.1.1');
    expect(aborted).toBe(1);
    expect(deps.streams.count(grantId)).toBe(0);
    expect(await validateAgentToken(deps, t.access_token)).toEqual({
      ok: false,
      reason: 'revoked',
    });

    await adminSetClientDisabled(deps, 'admin', clientId, false, '1.1.1.1');
    expect((await validateAgentToken(deps, t.access_token)).ok).toBe(true);
    // re-enable does not resurrect the aborted stream, but new ones can be acquired
    expect(deps.streams.acquire(grantId, 5, () => undefined)).not.toBeNull();
  });

  it('legacy DB without agent_grants.kind migrates; existing grants default to oauth; rerun is a no-op', async () => {
    const clientId = await newClient();
    const { code, verifier } = await codeFor(clientId);
    const t = (await exchangeToken(deps, tokenReq(clientId, code, verifier), '1.1.1.1')) as any;
    try {
      raw(db).exec(`ALTER TABLE agent_grants DROP COLUMN kind`);
      // A legacy DB predates migration tracking (TD-032): the next boot bootstraps it.
      raw(db).exec(`DROP TABLE schema_migrations`);
      // ...and predates every later migration (0004 tool pins), which would otherwise re-run on top.
      raw(db).exec(`DROP TABLE tool_pins`);
      raw(db).exec(`ALTER TABLE mcp_catalog DROP COLUMN pin_policy`);
    } catch {
      return; // SQLite too old for DROP COLUMN: nothing to simulate
    }
    expect(
      raw(db)
        .prepare(`PRAGMA table_info(agent_grants)`)
        .all()
        .some((c: any) => c.name === 'kind')
    ).toBe(false);
    await runMigrations(db);
    await runMigrations(db);
    const cols = raw(db).prepare(`PRAGMA table_info(agent_grants)`).all();
    expect(cols.filter((c: any) => c.name === 'kind')).toHaveLength(1);
    const row = raw(db).prepare(`SELECT kind FROM agent_grants WHERE client_id=?`).get(clientId);
    expect(row.kind).toBe('oauth');
    expect((await validateAgentToken(deps, t.access_token)).ok).toBe(true);
  });
});

describe('server level', () => {
  let s: AgentTestServer | null = null;
  afterEach(async () => {
    await stopAgentTestServer(s);
    s = null;
  });

  const mcpCall = (tok: string) =>
    s!.api.inject({
      method: 'POST',
      url: AGENT_MCP_ROUTE,
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    });

  it('oauth grant whose client_id is NULL gets 401 on /mcp', async () => {
    s = await startAgentTestServer(agentEndpointOpts());
    const sess = await loginSession(s, await createUser(s, 'nullc'));
    const clientId = await registerAdminClient(s);
    const tok = await fullFlow(s, sess, clientId, { scopes: ['mcp:*'] });
    expect((await mcpCall(tok.access_token)).statusCode).not.toBe(401);
    raw(s.db).prepare(`UPDATE agent_grants SET client_id=NULL WHERE client_id=?`).run(clientId);
    expect((await mcpCall(tok.access_token)).statusCode).toBe(401);
  });

  it('booting twice on the same DB is idempotent and keeps grants working', async () => {
    const opts = agentEndpointOpts();
    s = await startAgentTestServer(opts);
    const sess = await loginSession(s, await createUser(s, 'boot'));
    const clientId = await registerAdminClient(s);
    const tok = await fullFlow(s, sess, clientId, { scopes: ['mcp:*'] });
    expect((await mcpCall(tok.access_token)).statusCode).not.toBe(401);

    s = await restartAgentTestServer(s, opts);
    s = await restartAgentTestServer(s, opts);
    const cols = raw(s.db).prepare(`PRAGMA table_info(agent_grants)`).all();
    expect(cols.filter((c: any) => c.name === 'kind')).toHaveLength(1);
    expect((await mcpCall(tok.access_token)).statusCode).not.toBe(401);
  });

  it('resource_url is <agent base>/mcp when enabled', async () => {
    s = await startAgentTestServer(agentEndpointOpts());
    const sess = await loginSession(s, await createUser(s, 'ru'));
    const r = await sess.request({ method: 'GET', url: '/v1/users/me/agent-endpoint' });
    expect(r.statusCode).toBe(200);
    expect(r.json().data.enabled).toBe(true);
    expect(r.json().data.resource_url).toBe(`${TEST_RESOURCE_BASE}${AGENT_MCP_ROUTE}`);
  });

  it('resource_url is null when the endpoint is disabled', async () => {
    s = await startAgentTestServer({});
    const sess = await loginSession(s, await createUser(s, 'ru0'));
    const r = await sess.request({ method: 'GET', url: '/v1/users/me/agent-endpoint' });
    expect(r.statusCode).toBe(200);
    expect(r.json().data.enabled).toBe(false);
    expect(r.json().data.resource_url).toBeNull();
  });
});
