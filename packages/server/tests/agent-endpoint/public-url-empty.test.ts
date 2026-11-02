/**
 * Compose passes `PUBLIC_URL: ${PUBLIC_URL:-}` ("" when unset). With the agent endpoint really enabled
 * (full schema, no issuer_url/resource_base_url), the issuer and protected-resource metadata must fall
 * back to https://<serverName>:<adminPort>, not "".
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  OAUTH_AS_METADATA_ROUTE,
  OAUTH_PROTECTED_RESOURCE_MCP_ROUTE,
} from '@mcpambassador/contracts';
import { AgentEndpointConfigSchema } from '@mcpambassador/core';
import { startAgentTestServer, stopAgentTestServer, type AgentTestServer } from './helpers.js';

describe.each(['', '   '])('agent endpoint with PUBLIC_URL=%j', publicUrl => {
  let s: AgentTestServer;
  beforeAll(async () => {
    s = await startAgentTestServer({
      publicUrl,
      serverName: 'amb.test',
      adminPort: 9443,
      ambassadorConfig: {
        agent_endpoint: AgentEndpointConfigSchema.parse({ enabled: true }),
      } as never,
    });
  });
  afterAll(async () => {
    await stopAgentTestServer(s);
  });

  it('AS metadata has a non-empty https issuer and absolute endpoints', async () => {
    const res = await s.admin.inject({ method: 'GET', url: OAUTH_AS_METADATA_ROUTE });
    expect(res.statusCode).toBe(200);
    const m = res.json() as Record<string, unknown>;
    expect(m['issuer']).toBe('https://amb.test:9443');
    expect(String(m['authorization_endpoint'])).toMatch(/^https:\/\/amb\.test:/);
    expect(String(m['token_endpoint'])).toMatch(/^https:\/\/amb\.test:/);
  });

  it('protected-resource metadata lists the issuer as authorization server', async () => {
    const res = await s.api.inject({ method: 'GET', url: OAUTH_PROTECTED_RESOURCE_MCP_ROUTE });
    expect(res.statusCode).toBe(200);
    const m = res.json() as Record<string, unknown>;
    expect(m['authorization_servers']).toEqual(['https://amb.test:9443']);
    expect(String(m['resource'])).toMatch(/^https:\/\/amb\.test:\d+\/mcp$/);
  });
});
