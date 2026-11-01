/** TD-044 black-box: create/update refuse a non-allowlisted command[0]; MCP_ALLOWED_COMMANDS opts in. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  startAgentTestServer,
  stopAgentTestServer,
  agentEndpointOpts,
  type AgentTestServer,
} from '../agent-endpoint/helpers.js';

const CANARY = 'LEAKCANARY-td044c';
let s: AgentTestServer;
let prev: string | undefined;
const adm = () => ({ 'X-Admin-Key': s.adminKey });
const raw = (): any => (s.db as any).session.client;
let n = 0;
const body = (command: string[], extra: Record<string, unknown> = {}) => ({
  name: `td044c-${++n}-${Date.now() % 100000}`,
  display_name: 'x',
  transport_type: 'stdio',
  config: { command },
  ...extra,
});
const post = (payload: unknown) =>
  s.admin.inject({
    method: 'POST',
    url: '/v1/admin/mcps',
    headers: adm(),
    payload: payload as never,
  });
const stored = (name: string): boolean =>
  raw().prepare('SELECT 1 FROM mcp_catalog WHERE name=?').get(name) !== undefined;

beforeAll(async () => {
  prev = process.env['MCP_ALLOWED_COMMANDS'];
  delete process.env['MCP_ALLOWED_COMMANDS'];
  s = await startAgentTestServer(agentEndpointOpts());
});
afterAll(async () => {
  await stopAgentTestServer(s);
  if (prev === undefined) delete process.env['MCP_ALLOWED_COMMANDS'];
  else process.env['MCP_ALLOWED_COMMANDS'] = prev;
});

describe('default allowlist', () => {
  const REFUSED: Array<[string, string[]]> = [
    ['docker', ['docker', 'run', '--rm', `${CANARY}/img`]],
    ['absolute path to docker', ['/usr/bin/docker', 'run', `${CANARY}/img`]],
    ['bash', ['bash', '-c', CANARY]],
    ['arbitrary binary', [`/tmp/${CANARY}`]],
  ];
  for (const [label, cmd] of REFUSED) {
    it(`${label}: POST is 400, nothing stored, value not echoed`, async () => {
      const b = body(cmd);
      const r = await post(b);
      expect(r.statusCode, r.body).toBe(400);
      expect(r.body).not.toContain(CANARY);
      expect(stored(b.name)).toBe(false);
    });
  }

  it('control: npx and node drafts are accepted', async () => {
    for (const cmd of [
      ['npx', '-y', 'pkg@1.2.3'],
      ['node', 'server.js'],
    ]) {
      const r = await post(body(cmd));
      expect(r.statusCode, r.body).toBe(201);
    }
  });

  it('PATCH to a non-allowlisted command is 400 and the stored command is unchanged', async () => {
    const c = await post(body(['npx', '-y', 'pkg@1.2.3']));
    const id = JSON.parse(c.body).data.mcp_id as string;
    const before = raw().prepare('SELECT config FROM mcp_catalog WHERE mcp_id=?').get(id);
    const r = await s.admin.inject({
      method: 'PATCH',
      url: `/v1/admin/mcps/${id}`,
      headers: adm(),
      payload: { config: { command: ['docker', 'run', `${CANARY}/img`] } } as never,
    });
    expect(r.statusCode, r.body).toBe(400);
    expect(r.body).not.toContain(CANARY);
    expect(raw().prepare('SELECT config FROM mcp_catalog WHERE mcp_id=?').get(id)).toEqual(before);
  });

  it('http-transport entries (no command) are unaffected', async () => {
    const r = await post({
      name: `td044c-http-${Date.now() % 100000}`,
      display_name: 'h',
      transport_type: 'http',
      config: { url: 'https://mcp.example/mcp' },
    });
    expect(r.statusCode, r.body).toBe(201);
  });
});

describe('opt-in via MCP_ALLOWED_COMMANDS', () => {
  it('docker is accepted when listed, and refused again once the override is removed', async () => {
    process.env['MCP_ALLOWED_COMMANDS'] = 'npx,node,docker';
    try {
      expect((await post(body(['docker', 'run', 'img']))).statusCode).toBe(201);
      // an override that omits npx now refuses npx (create-time check mirrors spawn exactly)
      process.env['MCP_ALLOWED_COMMANDS'] = 'docker';
      expect((await post(body(['npx', '-y', 'pkg@1.2.3']))).statusCode).toBe(400);
    } finally {
      delete process.env['MCP_ALLOWED_COMMANDS'];
    }
    expect((await post(body(['docker', 'run', 'img']))).statusCode).toBe(400);
  });
});
