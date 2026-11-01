/**
 * Boot-level kill-switch persistence (TD-022): switches load unconditionally at startup,
 * independent of the agent_endpoint flag. Uses real AmbassadorServer instances on one data dir.
 */
import { describe, it, expect, afterAll } from 'vitest';
import {
  startAgentTestServer,
  restartAgentTestServer,
  stopAgentTestServer,
  agentEndpointOpts,
  type AgentTestServer,
} from './agent-endpoint/helpers.js';

const list = async (s: AgentTestServer) => {
  const r = await s.api.inject({
    method: 'GET',
    url: '/v1/admin/kill-switches',
    headers: { 'x-admin-key': s.adminKey },
  });
  expect(r.statusCode).toBe(200);
  return r.json().data as Array<{
    target: string;
    type: string;
    activated_by: string;
    activated_at: string;
  }>;
};
const toggle = (s: AgentTestServer, target: string, enabled: boolean) =>
  s.api.inject({
    method: 'POST',
    url: `/v1/admin/kill-switch/${encodeURIComponent(target)}`,
    headers: { 'x-admin-key': s.adminKey },
    payload: { enabled },
  });

describe('kill switches across full-server restart (agent_endpoint disabled)', () => {
  let s: AgentTestServer | undefined;
  afterAll(async () => {
    await stopAgentTestServer(s);
  });

  it('persisted switches are honoured after restart with agent_endpoint disabled', async () => {
    s = await startAgentTestServer(); // agent_endpoint not configured => disabled
    expect((await toggle(s, 'mcp:github', true)).statusCode).toBe(200);
    expect((await toggle(s, 'client:abc-123', true)).statusCode).toBe(200);
    expect((await toggle(s, 'mcp:slack', true)).statusCode).toBe(200);
    expect((await toggle(s, 'mcp:slack', false)).statusCode).toBe(200);
    const before = await list(s);
    expect(before.map(x => x.target).sort()).toEqual(['client:abc-123', 'mcp:github']);

    s = await restartAgentTestServer(s); // still disabled
    const after = await list(s);
    expect(after.map(x => x.target).sort()).toEqual(['client:abc-123', 'mcp:github']);
    // activation record preserved, deactivated switch stays off
    const gh = after.find(x => x.target === 'mcp:github')!;
    expect(gh).toMatchObject({
      type: 'mcp',
      activated_at: before.find(x => x.target === 'mcp:github')!.activated_at,
    });
    expect(gh.activated_by).toMatch(/^admin-key:/);

    // deactivation after restart persists too
    expect((await toggle(s, 'mcp:github', false)).statusCode).toBe(200);
    s = await restartAgentTestServer(s);
    expect((await list(s)).map(x => x.target)).toEqual(['client:abc-123']);
  });

  it('switches also survive a restart that flips agent_endpoint on (load is flag-independent)', async () => {
    s = await restartAgentTestServer(s!, agentEndpointOpts());
    expect((await list(s)).map(x => x.target)).toEqual(['client:abc-123']);
    s = await restartAgentTestServer(s); // and back off
    expect((await list(s)).map(x => x.target)).toEqual(['client:abc-123']);
  });
});
