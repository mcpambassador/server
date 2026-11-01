/**
 * ADR-022 (3b) extras: malformed names, the 800-code-point description on every surface, and
 * meta-tools reachable from full-mode grants.
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
  rpc,
} from './fake-mcp-world.js';

vi.setConfig({ testTimeout: 60_000 });
const SEARCH = 'ambassador__search_tools';
const DESCRIBE = 'ambassador__describe_tool';
const CALL = 'ambassador__call_tool';
const LONG = 'b'.repeat(499) + '\u{1F600}' + 'c'.repeat(300); // 800 code points, emoji at the cut

let s: AgentTestServer;
let restoreEnv: () => void;
let full: string;
let prog: string;
let stdio: string;
const text = (r: { json: any }): string => r.json?.result?.content?.[0]?.text ?? '';
const call = (tok: string, name: string, args: unknown) =>
  rpc(s, tok, 'tools/call', { name, arguments: args });

beforeAll(async () => {
  restoreEnv = allowFakeMcpCommand();
  s = await startAgentTestServer(agentEndpointOpts());
  const u = await createUser(s, 'bob');
  const sess = await loginSession(s, u);
  const c = await createClientWithKey(sess, 'x-client');
  const fk = await createFakeMcp(s, {
    name: 'x-long',
    tools: ['xlong'],
    env: { FAKE_MCP_DESC: LONG },
  });
  await grantUserAccess(s, u.userId, fk.mcpId);
  await applyCatalog(s);
  await subscribe(sess, c.clientId, fk.mcpId);
  stdio = await stdioSession(s, c.key);
  const g = async (extra: Record<string, unknown>): Promise<string> => {
    const r = await sess.request({
      method: 'POST',
      url: AGENT_GRANTS_ROUTE,
      payload: { bound_client_id: c.clientId, label: 'x', scopes: ['mcp:*'], ...extra },
    });
    return JSON.parse(r.body).data.access_token as string;
  };
  full = await g({});
  prog = await g({ disclosure_mode: 'progressive' });
}, 120_000);
afterAll(async () => {
  await stopAgentTestServer(s);
  restoreEnv();
});

describe('malformed names answer the exact Unknown tool text', () => {
  const bad: unknown[] = ['ambassador__nope', 'x'.repeat(257), 42, null, '', ['a'], { a: 1 }];
  for (const tok of ['full', 'prog'] as const) {
    it(`describe and call_tool (${tok})`, async () => {
      const t = tok === 'full' ? full : prog;
      for (const name of bad) {
        for (const tool of [DESCRIBE, CALL]) {
          const r = await call(t, tool, { name, arguments: {} });
          expect(r.status, JSON.stringify(name)).toBe(200);
          expect(r.json.result.isError).toBe(true);
          expect(text(r)).toBe('Unknown tool');
        }
      }
    });
  }
  it('search with an over-long query is Invalid arguments', async () => {
    expect(text(await call(prog, SEARCH, { query: 'q'.repeat(201) }))).toBe('Invalid arguments');
  });
});

describe('an 800-code-point description is served intact (500 code points) on every surface', () => {
  const ok = (d: string): void => {
    expect(Array.from(d)).toHaveLength(500);
    expect(d.endsWith('\u{1F600}')).toBe(true);
  };
  it('tools/list (full), /v1/tools, describe', async () => {
    const list = (await rpc(s, full, 'tools/list', {})).json.result.tools as any[];
    ok(list.find(t => t.name === 'xlong').description);
    const v1 = JSON.parse((await stdioTools(s, stdio)).body);
    ok((v1.tools as any[]).find(t => t.name === 'xlong').description);
    ok(JSON.parse(text(await call(prog, DESCRIBE, { name: 'xlong' }))).description);
  });
  it('search summary is derived from the cut text and stays whole', async () => {
    const h = JSON.parse(text(await call(prog, SEARCH, { query: 'xlong' }))).tools.find(
      (x: any) => x.name === 'xlong'
    );
    expect(h.summary.length).toBeLessThanOrEqual(400);
    expect(h.summary).not.toMatch(/[\uD800-\uDBFF]$/); // no lone high surrogate
  });
});

describe('meta-tools are callable from a full-mode grant too', () => {
  it('search works without being listed', async () => {
    const names = ((await rpc(s, full, 'tools/list', {})).json.result.tools as any[]).map(
      t => t.name
    );
    expect(names.some(n => n.startsWith('ambassador__'))).toBe(false);
    expect(text(await call(full, SEARCH, { query: 'xlong' }))).toContain('xlong');
  });
});
