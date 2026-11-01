/**
 * Real-client smoke: the official @modelcontextprotocol/sdk Streamable HTTP client talks to /mcp on a
 * real listening socket with a one-shot grant token, against the fake downstream MCP. Then the grant
 * is revoked and the same token must stop working (401).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AGENT_GRANTS_ROUTE, AGENT_MCP_ROUTE } from '@mcpambassador/contracts';
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
} from './fake-mcp-world.js';

vi.setConfig({ testTimeout: 30_000 });

let s: AgentTestServer;
let restoreEnv: () => void;
let alice: UserSession;
let clientId: string;
let baseUrl: string;
const prevTls = process.env['NODE_TLS_REJECT_UNAUTHORIZED'];

async function grant(): Promise<{ grantId: string; token: string }> {
  const res = await alice.request({
    method: 'POST',
    url: AGENT_GRANTS_ROUTE,
    payload: { bound_client_id: clientId, label: 'sdk-smoke', scopes: ['mcp:*'] },
  });
  if (res.statusCode !== 201) throw new Error(`grant: ${res.statusCode} ${res.body}`);
  const d = JSON.parse(res.body).data;
  return { grantId: d.grant_id as string, token: d.access_token as string };
}

function connect(token: string): { client: Client; transport: StreamableHTTPClientTransport } {
  const transport = new StreamableHTTPClientTransport(new URL(AGENT_MCP_ROUTE, baseUrl), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'verifier-smoke', version: '0.0.0' });
  return { client, transport };
}

beforeAll(async () => {
  // the test listener uses a self-signed cert; scoped to this file, restored in afterAll
  process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
  restoreEnv = allowFakeMcpCommand();
  s = await startAgentTestServer(agentEndpointOpts());
  const au = await createUser(s, 'alice');
  alice = await loginSession(s, au);
  const fk = await createFakeMcp(s, { name: 'fk-sdk', tools: ['echo', 'other'] });
  await grantUserAccess(s, au.userId, fk.mcpId);
  await applyCatalog(s);
  clientId = (await createClientWithKey(alice, 'c-sdk')).clientId;
  await subscribe(alice, clientId, fk.mcpId);
  baseUrl = await s.api.listen({ port: 0, host: '127.0.0.1' });
}, 120_000);

afterAll(async () => {
  await stopAgentTestServer(s);
  restoreEnv();
  if (prevTls === undefined) delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
  else process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = prevTls;
});

describe('SDK Streamable HTTP client → /mcp', () => {
  it('listTools + callTool work with a one-shot grant token; revoke → 401', async () => {
    const g = await grant();
    const { client, transport } = connect(g.token);
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      const names = tools.map(t => t.name);
      expect(names).toEqual(expect.arrayContaining(['echo', 'other']));

      const r = await client.callTool({ name: 'echo', arguments: { text: 'hi-from-sdk' } });
      expect(r.isError).toBeFalsy();
      expect(JSON.stringify(r.content)).toContain('hi-from-sdk');
    } finally {
      await client.close().catch(() => undefined);
    }

    const del = await alice.request({
      method: 'DELETE',
      url: `${AGENT_GRANTS_ROUTE}/${g.grantId}`,
    });
    expect(del.statusCode).toBeLessThan(300);

    // same token, brand-new client: revoked grant must be rejected at the HTTP layer
    const again = connect(g.token);
    await expect(again.client.connect(again.transport)).rejects.toThrow(/401|Unauthorized/i);
    const raw = await fetch(new URL(AGENT_MCP_ROUTE, baseUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${g.token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(raw.status).toBe(401);
  });
});
