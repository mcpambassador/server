/**
 * ADR-020 phase 1: discovery metadata + master switch.
 * Disabled-state tests run for real today; enabled-state tests are marked `itImpl`
 * until the routes stop being 501 stubs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  AGENT_MCP_ROUTE,
  OAUTH_PROTECTED_RESOURCE_ROUTE,
  OAUTH_PROTECTED_RESOURCE_MCP_ROUTE,
  OAUTH_AS_METADATA_ROUTE,
  OAUTH_AUTHORIZE_ROUTE,
  OAUTH_TOKEN_ROUTE,
  OAUTH_REGISTER_ROUTE,
  OAUTH_REVOKE_ROUTE,
} from '@mcpambassador/contracts';
import {
  startAgentTestServer,
  stopAgentTestServer,
  agentEndpointOpts,
  itImpl,
  TEST_ISSUER,
  TEST_RESOURCE,
  type AgentTestServer,
} from './helpers.js';

/**
 * "Not served" = no stub (501), no 401 challenge, no metadata/MCP/OAuth payload (a generic JSON error is fine). Note: the SPA
 * catch-all answers unknown GETs with 200 text/html, and the admin CSRF hook answers
 * unauthenticated POSTs with 403, so a literal 404 is not guaranteed on every path.
 */
function expectNotServed(res: {
  statusCode: number;
  headers: Record<string, unknown>;
  body: string;
}): void {
  expect(res.statusCode).toBe(404);
  expect(String(res.headers['content-type'] ?? '')).toMatch(/json/);
  expect(String(res.headers['content-type'] ?? '')).not.toMatch(/html/);
  expect(res.body).not.toMatch(/<html|<!doctype/i);
  expect(res.body).not.toContain('not_implemented');
  expect(res.body).not.toContain('jsonrpc');
  expect(res.body).not.toContain('access_token');
  expect(res.body).not.toContain('authorization_endpoint');
  expect(res.body).not.toContain('authorization_servers');
  expect(res.headers['www-authenticate']).toBeUndefined();
}

describe('agent endpoint disabled (default)', () => {
  let s: AgentTestServer;
  beforeAll(async () => {
    s = await startAgentTestServer();
  });
  afterAll(async () => {
    await stopAgentTestServer(s);
  });

  it.each([
    ['GET', OAUTH_PROTECTED_RESOURCE_ROUTE],
    ['GET', OAUTH_PROTECTED_RESOURCE_MCP_ROUTE],
    ['POST', AGENT_MCP_ROUTE],
    ['GET', AGENT_MCP_ROUTE],
    ['DELETE', AGENT_MCP_ROUTE],
    ['GET', OAUTH_AS_METADATA_ROUTE],
    ['GET', OAUTH_AUTHORIZE_ROUTE],
    ['POST', OAUTH_TOKEN_ROUTE],
  ] as const)('8443 %s %s is not served', async (method, url) => {
    const res = await s.api.inject({ method, url });
    expectNotServed(res);
  });

  it.each([
    ['GET', OAUTH_AS_METADATA_ROUTE],
    ['POST', OAUTH_AS_METADATA_ROUTE],
    ['GET', OAUTH_AUTHORIZE_ROUTE],
    ['GET', OAUTH_TOKEN_ROUTE],
    ['GET', AGENT_MCP_ROUTE],
    ['POST', AGENT_MCP_ROUTE],
    ['GET', OAUTH_PROTECTED_RESOURCE_ROUTE],
    ['POST', OAUTH_TOKEN_ROUTE],
    ['POST', OAUTH_REGISTER_ROUTE],
    ['POST', OAUTH_REVOKE_ROUTE],
  ] as const)('9443 %s %s is not served', async (method, url) => {
    const res = await s.admin.inject({ method, url });
    expectNotServed(res);
  });

  it('default config has endpoint off, DCR off, refresh on, 15m access TTL', async () => {
    const { AgentEndpointConfigSchema } = await import('@mcpambassador/core');
    const cfg = AgentEndpointConfigSchema.parse(undefined);
    expect(cfg.enabled).toBe(false);
    expect(cfg.dynamic_client_registration).toBe(false);
    expect(cfg.refresh_tokens_enabled).toBe(true);
    expect(cfg.access_token_ttl_seconds).toBe(900);
    expect(cfg.default_grant_ttl_seconds).toBe(3600);
    expect(cfg.max_grant_ttl_seconds).toBe(86400);
    expect(cfg.allowed_origins).toEqual([]);
  });

  it('rejects out-of-range TTL config', async () => {
    const { AgentEndpointConfigSchema } = await import('@mcpambassador/core');
    expect(() => AgentEndpointConfigSchema.parse({ max_grant_ttl_seconds: 86401 })).toThrow();
    expect(() => AgentEndpointConfigSchema.parse({ access_token_ttl_seconds: 30 })).toThrow();
  });
});

describe('agent endpoint enabled: metadata', () => {
  let s: AgentTestServer;
  beforeAll(async () => {
    s = await startAgentTestServer(agentEndpointOpts());
  });
  afterAll(async () => {
    await stopAgentTestServer(s);
  });

  itImpl.each([OAUTH_PROTECTED_RESOURCE_ROUTE, OAUTH_PROTECTED_RESOURCE_MCP_ROUTE])(
    'RFC 9728 protected-resource metadata at %s',
    async url => {
      const res = await s.api.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      const body = JSON.parse(res.body);
      expect(body.resource).toBe(TEST_RESOURCE);
      expect(body.authorization_servers).toEqual([TEST_ISSUER]);
      expect(body.bearer_methods_supported).toEqual(['header']);
      expect(Array.isArray(body.scopes_supported)).toBe(true);
    }
  );

  it('RFC 8414 AS metadata advertises only PKCE S256, code grant, public clients', async () => {
    const res = await s.admin.inject({ method: 'GET', url: OAUTH_AS_METADATA_ROUTE });
    expect(res.statusCode).toBe(200);
    const m = JSON.parse(res.body);
    expect(m.issuer).toBe(TEST_ISSUER);
    expect(m.authorization_endpoint).toBe(`${TEST_ISSUER}${OAUTH_AUTHORIZE_ROUTE}`);
    expect(m.token_endpoint).toBe(`${TEST_ISSUER}${OAUTH_TOKEN_ROUTE}`);
    expect(m.revocation_endpoint).toBe(`${TEST_ISSUER}${OAUTH_REVOKE_ROUTE}`);
    expect(m.response_types_supported).toEqual(['code']);
    expect(m.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
    expect(m.code_challenge_methods_supported).toEqual(['S256']);
    expect(m.token_endpoint_auth_methods_supported).toEqual(['none']);
  });

  it('AS metadata omits registration_endpoint while DCR is off', async () => {
    const res = await s.admin.inject({ method: 'GET', url: OAUTH_AS_METADATA_ROUTE });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).registration_endpoint).toBeUndefined();
  });

  itImpl('metadata URLs ignore a spoofed Host / X-Forwarded-Host header', async () => {
    const headers = { host: 'evil.example', 'x-forwarded-host': 'evil.example' };
    const pr = await s.api.inject({ method: 'GET', url: OAUTH_PROTECTED_RESOURCE_ROUTE, headers });
    const as = await s.admin.inject({ method: 'GET', url: OAUTH_AS_METADATA_ROUTE, headers });
    expect(pr.statusCode).toBe(200);
    expect(as.statusCode).toBe(200);
    expect(pr.body).not.toContain('evil.example');
    expect(as.body).not.toContain('evil.example');
  });
});

describe('agent endpoint enabled with DCR on: metadata', () => {
  let s: AgentTestServer;
  beforeAll(async () => {
    s = await startAgentTestServer(agentEndpointOpts({ dynamic_client_registration: true }));
  });
  afterAll(async () => {
    await stopAgentTestServer(s);
  });

  it('AS metadata advertises registration_endpoint', async () => {
    const res = await s.admin.inject({ method: 'GET', url: OAUTH_AS_METADATA_ROUTE });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).registration_endpoint).toBe(
      `${TEST_ISSUER}${OAUTH_REGISTER_ROUTE}`
    );
  });
});
