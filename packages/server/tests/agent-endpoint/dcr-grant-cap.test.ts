/**
 * TD-080: dynamically registered (unverified) OAuth clients get a lower grant-lifetime cap
 * (agent_endpoint.max_dcr_grant_ttl_seconds, default 7d); admin-registered clients keep the full cap.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AGENT_GRANTS_ROUTE, OAUTH_REGISTER_ROUTE } from '@mcpambassador/contracts';
import { AgentEndpointConfigSchema } from '@mcpambassador/core';
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
  REDIRECT_URI,
  registerAdminClient,
  fullFlow,
  pkce,
  startAuthorize,
} from './oauth-flow-helpers.js';

const DAY = 86400;

async function dcrClient(s: AgentTestServer): Promise<string> {
  const res = await s.admin.inject({
    method: 'POST',
    url: OAUTH_REGISTER_ROUTE,
    headers: { 'content-type': 'application/json' },
    payload: { client_name: 'dcr-agent', redirect_uris: [REDIRECT_URI] },
  });
  return JSON.parse(res.body).client_id as string;
}

async function newestGrantExpiry(alice: UserSession): Promise<number> {
  const g = JSON.parse((await alice.request({ method: 'GET', url: AGENT_GRANTS_ROUTE })).body);
  const rows = (g.data.items ?? g.data) as Array<{ expires_at: string }>;
  return Math.max(...rows.map(r => Date.parse(r.expires_at)));
}

describe('config', () => {
  it('defaults to 7 days, bounded to 60s..1y', () => {
    expect(AgentEndpointConfigSchema.parse({}).max_dcr_grant_ttl_seconds).toBe(7 * DAY);
    expect(() => AgentEndpointConfigSchema.parse({ max_dcr_grant_ttl_seconds: 59 })).toThrow();
    expect(() =>
      AgentEndpointConfigSchema.parse({ max_dcr_grant_ttl_seconds: 365 * DAY + 1 })
    ).toThrow();
  });
});

describe('DCR vs admin client grant cap', () => {
  let s: AgentTestServer;
  let alice: UserSession;
  let adminClient: string;
  let dcr: string;

  beforeAll(async () => {
    s = await startAgentTestServer(
      agentEndpointOpts({
        dynamic_client_registration: true,
        max_grant_ttl_seconds: 30 * DAY,
        rate_limits: { token_per_minute: 10000, register_per_hour: 100 },
      })
    );
    alice = await loginSession(s, await createUser(s, 'alice'));
    adminClient = await registerAdminClient(s);
    dcr = await dcrClient(s);
  });
  afterAll(async () => {
    await stopAgentTestServer(s);
  });

  it('DCR client asking for 30d gets 7d', async () => {
    const start = Date.now();
    await fullFlow(s, alice, dcr, { ttl_seconds: 30 * DAY });
    const exp = await newestGrantExpiry(alice);
    expect(exp - start).toBeLessThanOrEqual(7 * DAY * 1000 + 60_000);
    expect(exp - start).toBeGreaterThan(7 * DAY * 1000 - 60_000);
  });

  it('admin client asking for 30d still gets 30d', async () => {
    const start = Date.now();
    await fullFlow(s, alice, adminClient, { ttl_seconds: 30 * DAY });
    const exp = await newestGrantExpiry(alice);
    expect(exp - start).toBeGreaterThan(30 * DAY * 1000 - 60_000);
  });

  it('consent details report the effective cap and flag the limit for DCR only', async () => {
    const details = async (cid: string) => {
      const { requestId } = await startAuthorize(s, alice, {
        client_id: cid,
        code_challenge: pkce().challenge,
      });
      const d = await alice.request({ method: 'GET', url: `/v1/oauth/consent/${requestId}` });
      return JSON.parse(d.body).data;
    };
    const d = await details(dcr);
    expect(d.max_ttl_seconds).toBe(7 * DAY);
    expect(d.unverified_ttl_limited).toBe(true);
    const a = await details(adminClient);
    expect(a.max_ttl_seconds).toBe(30 * DAY);
    expect(a.unverified_ttl_limited).toBe(false);
  });
});

describe('DCR cap above max_grant_ttl_seconds is a no-op', () => {
  it('uses the smaller value and does not flag the limit', async () => {
    const s = await startAgentTestServer(
      agentEndpointOpts({
        dynamic_client_registration: true,
        max_grant_ttl_seconds: 2 * DAY,
        max_dcr_grant_ttl_seconds: 7 * DAY,
        rate_limits: { register_per_hour: 100 },
      })
    );
    try {
      const alice = await loginSession(s, await createUser(s, 'alice'));
      const cid = await dcrClient(s);
      const { requestId } = await startAuthorize(s, alice, {
        client_id: cid,
        code_challenge: pkce().challenge,
      });
      const d = JSON.parse(
        (await alice.request({ method: 'GET', url: `/v1/oauth/consent/${requestId}` })).body
      ).data;
      expect(d.max_ttl_seconds).toBe(2 * DAY);
      expect(d.unverified_ttl_limited).toBe(false);
    } finally {
      await stopAgentTestServer(s);
    }
  });
});
