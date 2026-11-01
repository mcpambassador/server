/**
 * TD-027 (defense in depth): production keeps REGISTRY_TOKEN / GITHUB_OAUTH_CLIENT_SECRET out of
 * process.env (captured before the scrub). Even if a server process did hold them, spawned stdio MCPs
 * must NOT inherit them (SAFE_ENV_VARS whitelist). Uses the fake-mcp fixture's __env tool over /mcp
 * for both spawn paths (shared and per_user).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AGENT_GRANTS_ROUTE } from '@mcpambassador/contracts';
import {
  startAgentTestServer,
  stopAgentTestServer,
  agentEndpointOpts,
  createUser,
  loginSession,
  type AgentTestServer,
  type UserSession,
} from './helpers.js';
import {
  allowFakeMcpCommand,
  createFakeMcp,
  grantUserAccess,
  applyCatalog,
  createClientWithKey,
  subscribe,
  rpc,
  isDenied,
} from './fake-mcp-world.js';

vi.setConfig({ testTimeout: 30_000 });

const CANARIES: Record<string, string> = {
  REGISTRY_TOKEN: 'CANARY_registry_token_5f3a9c',
  GITHUB_OAUTH_CLIENT_SECRET: 'CANARY_github_oauth_secret_8d21e7',
};

let s: AgentTestServer;
let restoreCmd: () => void;
const prev: Record<string, string | undefined> = {};
let alice: UserSession;
let carol: UserSession;
let cShared: { clientId: string; key: string };
let cPerUser: { clientId: string; key: string };

async function oneShotToken(sess: UserSession, clientId: string): Promise<string> {
  const res = await sess.request({
    method: 'POST',
    url: AGENT_GRANTS_ROUTE,
    payload: { bound_client_id: clientId, label: 'env-scrub', scopes: ['mcp:*'] },
  });
  if (res.statusCode !== 201) throw new Error(`oneShot: ${res.statusCode} ${res.body}`);
  return JSON.parse(res.body).data.access_token as string;
}

async function childEnv(token: string): Promise<Record<string, string>> {
  const r = await rpc(s, token, 'tools/call', { name: '__env', arguments: {} });
  expect(isDenied(r)).toBe(false);
  return JSON.parse(r.json.result.content[0].text) as Record<string, string>;
}

beforeAll(async () => {
  // The server process holds these (simulating a server that still holds them in process.env) before any spawn.
  for (const [k, v] of Object.entries(CANARIES)) {
    prev[k] = process.env[k];
    process.env[k] = v;
  }
  restoreCmd = allowFakeMcpCommand();
  s = await startAgentTestServer(agentEndpointOpts());
  const a = await createUser(s, 'envsh');
  alice = await loginSession(s, a);
  const c = await createUser(s, 'envpu');
  carol = await loginSession(s, c);

  const shared = await createFakeMcp(s, {
    name: 'env-shared',
    isolation: 'shared',
    tools: ['echo'],
    env: { EXPLICIT_MCP_VAR: 'explicit-ok' },
  });
  const perUser = await createFakeMcp(s, {
    name: 'env-peruser',
    isolation: 'per_user',
    tools: ['uecho'],
    env: { EXPLICIT_MCP_VAR: 'explicit-ok' },
  });
  await grantUserAccess(s, a.userId, shared.mcpId);
  await grantUserAccess(s, c.userId, perUser.mcpId);
  await applyCatalog(s);
  cShared = await createClientWithKey(alice, 'env-shared-client');
  await subscribe(alice, cShared.clientId, shared.mcpId);
  cPerUser = await createClientWithKey(carol, 'env-peruser-client');
  await subscribe(carol, cPerUser.clientId, perUser.mcpId);
}, 120_000);

afterAll(async () => {
  await stopAgentTestServer(s);
  restoreCmd();
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('TD-027: server secrets in process.env never reach spawned stdio MCPs', () => {
  it('the server process holds the canary vars (premise)', () => {
    for (const [k, v] of Object.entries(CANARIES)) expect(process.env[k]).toBe(v);
  });

  it.each([
    ['shared', () => [alice, cShared] as const],
    ['per_user', () => [carol, cPerUser] as const],
  ])(
    '%s spawn path: child env lacks REGISTRY_TOKEN / GITHUB_OAUTH_CLIENT_SECRET',
    async (_n, pick) => {
      const [sess, client] = pick();
      const env = await childEnv(await oneShotToken(sess, client.clientId));
      // positive controls: __env really reflects the child, and explicit config env still passes
      expect(env['EXPLICIT_MCP_VAR']).toBe('explicit-ok');
      expect(Object.keys(env).length).toBeGreaterThan(0);
      for (const [k, v] of Object.entries(CANARIES)) {
        expect(env, k).not.toHaveProperty(k);
        expect(JSON.stringify(env)).not.toContain(v);
      }
    }
  );
});
