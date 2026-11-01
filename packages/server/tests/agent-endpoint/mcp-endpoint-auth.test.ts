/**
 * ADR-020 phase 3 (rejection paths): /mcp must refuse anything without a valid agent
 * token, with 401 + WWW-Authenticate pointing at protected-resource metadata.
 * Positive-token cases (expiry, revoked, wrong audience, scope) land with P4/P5.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  AGENT_MCP_ROUTE,
  ACCESS_TOKEN_PREFIX,
  OAUTH_PROTECTED_RESOURCE_MCP_ROUTE,
} from '@mcpambassador/contracts';
import {
  startAgentTestServer,
  stopAgentTestServer,
  agentEndpointOpts,
  itImpl,
  TEST_RESOURCE_BASE,
  type AgentTestServer,
} from './helpers.js';

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'verifier', version: '0' },
  },
};
const MCP_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  'mcp-protocol-version': '2025-06-18',
};

describe('/mcp rejects unauthenticated / invalid callers', () => {
  let s: AgentTestServer;
  beforeAll(async () => {
    s = await startAgentTestServer(
      agentEndpointOpts({ allowed_origins: ['https://allowed.example'] })
    );
  });
  afterAll(async () => {
    await stopAgentTestServer(s);
  });

  const post = (headers: Record<string, string> = {}, url = AGENT_MCP_ROUTE) =>
    s.api.inject({ method: 'POST', url, headers: { ...MCP_HEADERS, ...headers }, payload: INIT });

  itImpl('no token → 401 with WWW-Authenticate resource_metadata', async () => {
    const res = await post();
    expect(res.statusCode).toBe(401);
    const www = String(res.headers['www-authenticate']);
    expect(www).toMatch(/^Bearer /);
    expect(www).toContain(
      `resource_metadata="${TEST_RESOURCE_BASE}${OAUTH_PROTECTED_RESOURCE_MCP_ROUTE}"`
    );
  });

  itImpl.each(['GET', 'DELETE'] as const)('no token on %s → 401', async method => {
    const res = await s.api.inject({ method, url: AGENT_MCP_ROUTE, headers: MCP_HEADERS });
    expect(res.statusCode).toBe(401);
    expect(String(res.headers['www-authenticate'])).toContain('resource_metadata=');
  });

  itImpl('garbage bearer → 401 invalid_token', async () => {
    const res = await post({ authorization: 'Bearer not-a-real-token' });
    expect(res.statusCode).toBe(401);
    expect(String(res.headers['www-authenticate'])).toContain('error="invalid_token"');
  });

  itImpl('well-formed but unknown amb_at_ token → 401', async () => {
    const res = await post({ authorization: `Bearer ${ACCESS_TOKEN_PREFIX}${'a'.repeat(43)}` });
    expect(res.statusCode).toBe(401);
  });

  itImpl('non-Bearer scheme → 401', async () => {
    const res = await post({ authorization: 'Basic dXNlcjpwYXNz' });
    expect(res.statusCode).toBe(401);
  });

  itImpl('admin key and client preshared keys are not accepted as bearer', async () => {
    const res = await post({ authorization: `Bearer ${s.adminKey}` });
    expect(res.statusCode).toBe(401);
    const res2 = await post({ 'x-admin-key': s.adminKey });
    expect(res2.statusCode).toBe(401);
  });

  itImpl('token in query string is rejected even if otherwise valid-looking', async () => {
    const res = await post(
      {},
      `${AGENT_MCP_ROUTE}?access_token=${ACCESS_TOKEN_PREFIX}${'a'.repeat(43)}`
    );
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain(ACCESS_TOKEN_PREFIX + 'a'.repeat(43));
  });

  itImpl('disallowed Origin → 403 (checked before auth success could matter)', async () => {
    const res = await post({ origin: 'https://evil.example' });
    expect(res.statusCode).toBe(403);
  });

  it('failure responses never echo the presented token', async () => {
    const tok = `${ACCESS_TOKEN_PREFIX}${'z'.repeat(43)}`;
    const res = await post({ authorization: `Bearer ${tok}` });
    expect(res.body).not.toContain(tok);
    expect(JSON.stringify(res.headers)).not.toContain(tok);
  });
});
