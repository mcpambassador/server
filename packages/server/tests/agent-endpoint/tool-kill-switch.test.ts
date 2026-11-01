import os from 'os';
import path from 'path';
import fs from 'fs';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  ADMIN_MCP_PIN_POLICY_ROUTE,
  ADMIN_TOOL_PINS_ROUTE,
  AGENT_GRANTS_ROUTE,
} from '@mcpambassador/contracts';
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
  FAKE_MCP_PATH,
  allowFakeMcpCommand,
  createFakeMcp,
  grantUserAccess,
  applyCatalog,
  createClientWithKey,
  subscribe,
  stdioSession,
  stdioTools,
  rpc,
  mcpToolNames,
  auditLines,
  waitForAudit,
} from './fake-mcp-world.js';
import {
  registerAdminClient,
  pkce,
  startAuthorize,
  approveAndGetCode,
  exchangeCode,
} from './oauth-flow-helpers.js';

vi.setConfig({ testTimeout: 60_000 });

/** ADR-025 M1 over a REAL downstream MCP: a killed (mcp_id, tool) disappears from tools/list, search and
 * describe and call_tool(mcp) gets the kill error, while the same-named tool on another MCP stays usable. */
const SEARCH = 'ambassador__search_tools';
const DESCRIBE = 'ambassador__describe_tool';
const CALL = 'ambassador__call_tool';

let s: AgentTestServer;
let restoreEnv: () => void;
let dir: string;
let alice: UserSession;
let aliceId: string;
let client: { clientId: string; key: string };
const adm = () => ({ 'X-Admin-Key': s.adminKey });
const J = (r: { body: string }): any => JSON.parse(r.body);
const callLog = (name: string): string => path.join(dir, `${name}.log`);

async function grant(
  clientId: string,
  extra: Record<string, unknown> = {}
): Promise<{ grantId: string; token: string }> {
  const res = await alice.request({
    method: 'POST',
    url: AGENT_GRANTS_ROUTE,
    payload: { bound_client_id: clientId, label: '3b', scopes: ['mcp:*'], ...extra },
  });
  if (res.statusCode !== 201) throw new Error(`grant: ${res.statusCode} ${res.body}`);
  const d = J(res).data;
  return { grantId: d.grant_id as string, token: d.access_token as string };
}

/** MCP with its own call log and description; policy decides whether tools start approved or pending. */
async function mkMcp(
  name: string,
  tools: string[],
  desc: string,
  policy: 'auto' | 'review'
): Promise<string> {
  const c = await s.admin.inject({
    method: 'POST',
    url: '/v1/admin/mcps',
    headers: adm(),
    payload: {
      name,
      display_name: name,
      transport_type: 'stdio',
      isolation_mode: 'shared',
      config: {
        command: ['node', FAKE_MCP_PATH],
        env: { FAKE_MCP_TOOLS: tools.join(','), FAKE_MCP_LOG: callLog(name), FAKE_MCP_DESC: desc },
      },
    },
  });
  if (c.statusCode !== 201) throw new Error(`create ${name}: ${c.statusCode} ${c.body}`);
  const mcpId = J(c).data.mcp_id as string;
  const pol = await s.admin.inject({
    method: 'PATCH',
    url: ADMIN_MCP_PIN_POLICY_ROUTE.replace(':mcpId', mcpId),
    headers: adm(),
    payload: { pin_policy: policy },
  });
  if (pol.statusCode !== 200) throw new Error(`pin-policy ${name}: ${pol.statusCode}`);
  for (const step of ['validate', 'discover', 'publish']) {
    const r = await s.admin.inject({
      method: 'POST',
      url: `/v1/admin/mcps/${mcpId}/${step}`,
      headers: adm(),
    });
    if (r.statusCode !== 200) throw new Error(`${name} ${step}: ${r.statusCode} ${r.body}`);
  }
  await grantUserAccess(s, aliceId, mcpId);
  await applyCatalog(s);
  await subscribe(alice, client.clientId, mcpId);
  return mcpId;
}

const tool = (token: string, name: string, args: unknown) =>
  rpc(s, token, 'tools/call', { name, arguments: args });
const text = (r: { json: any }): string => r.json?.result?.content?.[0]?.text ?? '';
const isErr = (r: { json: any }): boolean => !!r.json?.result?.isError;
const hits = (r: { json: any }): Array<{ name: string; mcp: string }> =>
  (JSON.parse(text(r)).tools as Array<{ name: string; mcp: string }>).filter(
    h => h.name !== '__env'
  );
const kill = (target: string, enabled: boolean) =>
  s.admin.inject({
    method: 'POST',
    url: `/v1/admin/kill-switch/${encodeURIComponent(target)}`,
    headers: adm(),
    payload: { enabled },
  });

let aId: string;
let prog: string;
let full: string;

beforeAll(async () => {
  restoreEnv = allowFakeMcpCommand();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tks-'));
  s = await startAgentTestServer(agentEndpointOpts());
  const u = await createUser(s, 'alice');
  aliceId = u.userId;
  alice = await loginSession(s, u);
  client = await createClientWithKey(alice, 'tks-client');
  aId = await mkMcp('tks-a', ['echo', 'other'], 'A tool.', 'auto');
  await mkMcp('tks-b', ['echo'], 'B tool.', 'auto'); // `echo` on two MCPs
  prog = (await grant(client.clientId, { disclosure_mode: 'progressive' })).token;
  full = (await grant(client.clientId)).token;
}, 180_000);

afterAll(async () => {
  await stopAgentTestServer(s);
  restoreEnv();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('tool kill switch over the agent endpoint', () => {
  it('hides the killed tool from list/search/describe and blocks call_tool; the same name on another MCP stays', async () => {
    expect(
      hits(await tool(prog, SEARCH, { query: 'echo' }))
        .map(h => `${h.mcp}/${h.name}`)
        .sort()
    ).toEqual(['tks-a/echo', 'tks-b/echo']);
    expect((await kill(`tool:${aId}:echo`, true)).statusCode).toBe(200);
    try {
      // search: only the other MCP's echo
      expect(
        hits(await tool(prog, SEARCH, { query: 'echo' })).map(h => `${h.mcp}/${h.name}`)
      ).toEqual(['tks-b/echo']);
      // describe addressed to the killed (mcp, tool) is indistinguishable from unknown
      const d = await tool(prog, DESCRIBE, { name: 'echo', mcp: 'tks-a' });
      const unknown = await tool(prog, DESCRIBE, { name: 'definitely-not-a-tool' });
      expect(isErr(d)).toBe(true);
      expect(text(d)).toBe(text(unknown));
      // call_tool with mcp hits the kill error and never reaches the downstream
      const c = await tool(prog, CALL, { name: 'echo', mcp: 'tks-a', arguments: { x: 1 } });
      expect(isErr(c)).toBe(true);
      expect(text(c)).toMatch(/kill|unknown|not permitted/i);
      expect(
        fs.existsSync(callLog('tks-a')) ? fs.readFileSync(callLog('tks-a'), 'utf8') : ''
      ).not.toContain('"name":"echo"');
      // the other MCP's echo is still callable, and `other` on the killed MCP is untouched
      expect(
        isErr(await tool(prog, CALL, { name: 'echo', mcp: 'tks-b', arguments: { x: 1 } }))
      ).toBe(false);
      expect(isErr(await tool(prog, CALL, { name: 'other', mcp: 'tks-a', arguments: {} }))).toBe(
        false
      );
      // full mode tools/list: echo still present (from tks-b), `other` present
      const names = await mcpToolNames(s, full);
      expect(names).toEqual(expect.arrayContaining(['echo', 'other']));
    } finally {
      await kill(`tool:${aId}:echo`, false);
    }
    expect(
      hits(await tool(prog, SEARCH, { query: 'echo' }))
        .map(h => `${h.mcp}/${h.name}`)
        .sort()
    ).toEqual(['tks-a/echo', 'tks-b/echo']);
  });
});
