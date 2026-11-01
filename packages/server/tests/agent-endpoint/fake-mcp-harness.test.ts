/**
 * Self-test of the fake-MCP harness against the EXISTING stdio path (/v1/tools, /v1/tools/invoke).
 * Plain `it`: must pass today. If it breaks, the /mcp tests built on it are meaningless.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  startAgentTestServer,
  stopAgentTestServer,
  agentEndpointOpts,
  createUser,
  loginSession,
  type AgentTestServer,
} from './helpers.js';
import {
  allowFakeMcpCommand,
  createFakeMcp,
  grantUserAccess,
  applyCatalog,
  createClientWithKey,
  subscribe,
  stdioSession,
  stdioTools,
  stdioInvoke,
} from './fake-mcp-world.js';

let s: AgentTestServer;
let restore: () => void;

beforeAll(async () => {
  restore = allowFakeMcpCommand();
  s = await startAgentTestServer(agentEndpointOpts());
});
afterAll(async () => {
  await stopAgentTestServer(s);
  restore();
});

describe('fake MCP harness over the stdio path', () => {
  it('shared fake MCP: tools listed and echoed through /v1/tools(/invoke); no agent token in env', async () => {
    const user = await createUser(s, 'harness');
    const sess = await loginSession(s, user);
    const mcp = await createFakeMcp(s, { name: 'fk-shared', tools: ['echo', 'other'] });
    await grantUserAccess(s, user.userId, mcp.mcpId);
    await applyCatalog(s);
    const { clientId, key } = await createClientWithKey(sess, 'stdio-c');
    await subscribe(sess, clientId, mcp.mcpId);
    const tok = await stdioSession(s, key, user.userId);

    const list = await stdioTools(s, tok);
    expect(list.statusCode).toBe(200);
    const names = (JSON.parse(list.body).tools as { name: string }[]).map(t => t.name);
    expect(names).toEqual(expect.arrayContaining(['echo', 'other']));

    const call = await stdioInvoke(s, tok, 'echo', { a: 1 });
    expect(call.statusCode).toBe(200);
    expect(JSON.parse(JSON.parse(call.body).result[0].text).args).toEqual({ a: 1 });
  });
});
