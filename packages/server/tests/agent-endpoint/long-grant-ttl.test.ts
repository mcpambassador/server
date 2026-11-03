/**
 * Long-lived grants: the grant (refresh family) may live up to a year while the access token
 * stays short, one-shot grants keep their own lower cap, and unused refresh tokens go idle.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { AGENT_GRANTS_ROUTE } from '@mcpambassador/contracts';
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
import { registerAdminClient, refresh, fullFlow, boundClientId } from './oauth-flow-helpers.js';

const DAY = 86400;
const YEAR = 365 * DAY;

afterEach(() => {
  vi.useRealTimers();
});

describe('agent_endpoint config bounds', () => {
  it('accepts a 1-year grant ceiling and rejects above it', () => {
    const ok = AgentEndpointConfigSchema.parse({
      default_grant_ttl_seconds: YEAR,
      max_grant_ttl_seconds: YEAR,
    });
    expect(ok.max_grant_ttl_seconds).toBe(YEAR);
    expect(() => AgentEndpointConfigSchema.parse({ max_grant_ttl_seconds: YEAR + 1 })).toThrow();
    expect(() =>
      AgentEndpointConfigSchema.parse({ default_grant_ttl_seconds: YEAR + 1 })
    ).toThrow();
  });

  it('defaults: 30d max grant, 24h one-shot, 30d idle, 15m access token', () => {
    const c = AgentEndpointConfigSchema.parse({});
    expect(c.max_grant_ttl_seconds).toBe(30 * DAY);
    expect(c.max_one_shot_grant_ttl_seconds).toBe(DAY);
    expect(c.refresh_token_idle_ttl_seconds).toBe(30 * DAY);
    expect(c.access_token_ttl_seconds).toBe(900);
  });

  it('one-shot ceiling is 7 days; access token ceiling stays 1h', () => {
    expect(
      AgentEndpointConfigSchema.parse({ max_one_shot_grant_ttl_seconds: 7 * DAY })
        .max_one_shot_grant_ttl_seconds
    ).toBe(7 * DAY);
    expect(() =>
      AgentEndpointConfigSchema.parse({ max_one_shot_grant_ttl_seconds: 7 * DAY + 1 })
    ).toThrow();
    expect(() => AgentEndpointConfigSchema.parse({ access_token_ttl_seconds: 3601 })).toThrow();
  });

  it('default above max fails with a message naming both keys', () => {
    const r = AgentEndpointConfigSchema.safeParse({
      default_grant_ttl_seconds: 2 * DAY,
      max_grant_ttl_seconds: DAY,
    });
    expect(r.success).toBe(false);
    const msg = JSON.stringify(r.error?.issues);
    expect(msg).toContain('default_grant_ttl_seconds');
    expect(msg).toContain('max_grant_ttl_seconds');
  });
});

async function grantExpiry(alice: UserSession): Promise<number> {
  const g = JSON.parse((await alice.request({ method: 'GET', url: AGENT_GRANTS_ROUTE })).body);
  const row = g.data[0] ?? g.data.items?.[0];
  return Date.parse(row.expires_at);
}

describe('OAuth grant with a 1-year max', () => {
  let s: AgentTestServer;
  let alice: UserSession;
  let clientId: string;

  beforeAll(async () => {
    s = await startAgentTestServer(
      agentEndpointOpts({
        max_grant_ttl_seconds: YEAR,
        rate_limits: { token_per_minute: 10000 },
      })
    );
    alice = await loginSession(s, await createUser(s, 'alice'));
    clientId = await registerAdminClient(s);
  });
  afterAll(async () => {
    await stopAgentTestServer(s);
  });

  it('grants a year, but the access token stays short and refresh outlives it', async () => {
    const start = Date.now();
    const t = await fullFlow(s, alice, clientId, { ttl_seconds: YEAR });
    const exp = await grantExpiry(alice);
    expect(exp - start).toBeGreaterThan(YEAR * 1000 - 60_000);
    expect(exp - start).toBeLessThanOrEqual(YEAR * 1000 + 60_000);

    // 20 days later the refresh still works and the new access token is short
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(start + 20 * DAY * 1000);
    const r = await refresh(s, { client_id: clientId, refresh_token: t.refresh_token! });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).expires_in).toBeLessThanOrEqual(900);
  });

  it('a request above the max is clamped to it', async () => {
    const t = await fullFlow(s, alice, clientId, { ttl_seconds: 2 * YEAR });
    expect(t.access_token).toBeTruthy();
    const exp = await grantExpiry(alice);
    expect(exp - Date.now()).toBeLessThanOrEqual(YEAR * 1000 + 60_000);
  });
});

describe('refresh idle window and grant expiry', () => {
  let s: AgentTestServer;
  let alice: UserSession;
  let clientId: string;

  beforeAll(async () => {
    s = await startAgentTestServer(
      agentEndpointOpts({
        max_grant_ttl_seconds: YEAR,
        refresh_token_idle_ttl_seconds: 30 * DAY,
        rate_limits: { token_per_minute: 10000 },
      })
    );
    alice = await loginSession(s, await createUser(s, 'alice'));
    clientId = await registerAdminClient(s);
  });
  afterAll(async () => {
    await stopAgentTestServer(s);
  });

  it('rotation slides the idle window; an unused token dies after 30 days', async () => {
    const start = Date.now();
    const t = await fullFlow(s, alice, clientId, { ttl_seconds: 90 * DAY });
    let token = t.refresh_token!;
    // Refresh every 25 days (within idle window) for 75 days: all succeed
    for (const day of [25, 50, 75]) {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(start + day * DAY * 1000);
      const r = await refresh(s, { client_id: clientId, refresh_token: token });
      expect(r.statusCode).toBe(200);
      token = JSON.parse(r.body).refresh_token;
    }
    // Fresh 1-year grant to isolate the idle limit from grant expiry: 31 days unused is dead
    vi.useRealTimers();
    const t2 = await fullFlow(s, alice, clientId, { ttl_seconds: 365 * DAY });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 31 * DAY * 1000);
    const dead = await refresh(s, { client_id: clientId, refresh_token: t2.refresh_token! });
    expect(dead.statusCode).toBe(400);
    expect(JSON.parse(dead.body).error).toBe('invalid_grant');
  });

  it('within the idle window the refresh works, and never outlives the grant', async () => {
    const t = await fullFlow(s, alice, clientId, { ttl_seconds: 10 * DAY });
    const t0 = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0 + 9 * DAY * 1000);
    const ok = await refresh(s, { client_id: clientId, refresh_token: t.refresh_token! });
    expect(ok.statusCode).toBe(200);
    // access token is capped at the grant's remaining life, which is ~1 day here (<= 900s ttl)
    expect(JSON.parse(ok.body).expires_in).toBeLessThanOrEqual(900);
    vi.setSystemTime(t0 + 11 * DAY * 1000);
    const after = await refresh(s, {
      client_id: clientId,
      refresh_token: JSON.parse(ok.body).refresh_token,
    });
    expect(after.statusCode).toBe(400);
  });
});

describe('one-shot grant cap', () => {
  it('is capped at max_one_shot even when max_grant is 1 year', async () => {
    const s = await startAgentTestServer(agentEndpointOpts({ max_grant_ttl_seconds: YEAR }));
    try {
      const alice = await loginSession(s, await createUser(s, 'alice'));
      const create = async (ttl?: number) =>
        alice.request({
          method: 'POST',
          url: AGENT_GRANTS_ROUTE,
          payload: {
            bound_client_id: await boundClientId(alice),
            label: 'ci',
            scopes: ['mcp:*'],
            ...(ttl ? { ttl_seconds: ttl } : {}),
          },
        });
      const res = await create(YEAR);
      expect(res.statusCode).toBe(201);
      const exp = Date.parse(JSON.parse(res.body).data.expires_at);
      expect(exp - Date.now()).toBeLessThanOrEqual(DAY * 1000 + 5000);
      // Default (1h) is below the cap and is kept
      const dflt = Date.parse(JSON.parse((await create()).body).data.expires_at);
      expect(dflt - Date.now()).toBeLessThanOrEqual(3600 * 1000 + 5000);
    } finally {
      await stopAgentTestServer(s);
    }
  });

  it('operator can raise the one-shot cap to 7 days', async () => {
    const s = await startAgentTestServer(
      agentEndpointOpts({ max_grant_ttl_seconds: YEAR, max_one_shot_grant_ttl_seconds: 7 * DAY })
    );
    try {
      const alice = await loginSession(s, await createUser(s, 'alice'));
      const res = await alice.request({
        method: 'POST',
        url: AGENT_GRANTS_ROUTE,
        payload: {
          bound_client_id: await boundClientId(alice),
          label: 'ci',
          scopes: ['mcp:*'],
          ttl_seconds: 30 * DAY,
        },
      });
      const exp = Date.parse(JSON.parse(res.body).data.expires_at);
      expect(exp - Date.now()).toBeLessThanOrEqual(7 * DAY * 1000 + 5000);
      expect(exp - Date.now()).toBeGreaterThan(6 * DAY * 1000);
    } finally {
      await stopAgentTestServer(s);
    }
  });
});
