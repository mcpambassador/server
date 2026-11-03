/**
 * TD-014: server.body_limit_bytes and session.heartbeat_min_interval_seconds are read from config
 * (defaults unchanged: 1 MiB, 10 s); all secret hashing shares one ARGON2_OPTIONS constant.
 */
import { describe, it, expect, afterEach } from 'vitest';
import argon2 from 'argon2';
import { ARGON2_OPTIONS as CORE_ARGON2 } from '@mcpambassador/core';
import { ARGON2_OPTIONS as POLICY_ARGON2 } from '../src/auth/password-policy.js';
import {
  startAgentTestServer,
  stopAgentTestServer,
  createUser,
  type AgentTestServer,
} from './agent-endpoint/helpers.js';

let s: AgentTestServer | undefined;
afterEach(async () => {
  if (s) await stopAgentTestServer(s);
  s = undefined;
});

const bigJson = (bytes: number): string => JSON.stringify({ pad: 'x'.repeat(bytes) });
const post = (srv: FastifyLike, url: string, payload: string, adminKey?: string) =>
  srv.inject({
    method: 'POST',
    url,
    headers: {
      'content-type': 'application/json',
      ...(adminKey ? { 'X-Admin-Key': adminKey } : {}),
    },
    payload,
  });
type FastifyLike = AgentTestServer['api'];

describe('argon2 options (shared constant)', () => {
  it('is one object with the OWASP-minimum values', () => {
    expect(POLICY_ARGON2).toBe(CORE_ARGON2);
    expect(CORE_ARGON2).toEqual({
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });
  });
});

describe('server.body_limit_bytes', () => {
  it('rejects a body over the configured limit with 413 on both listeners', async () => {
    s = await startAgentTestServer({
      ambassadorConfig: { server: { body_limit_bytes: 2048 } } as never,
    });
    expect((await post(s.admin, '/v1/admin/users', bigJson(4096), s.adminKey)).statusCode).toBe(
      413
    );
    expect((await post(s.api, '/v1/sessions/register', bigJson(4096))).statusCode).toBe(413);
  });

  it('keeps the 1 MiB default when unset', async () => {
    s = await startAgentTestServer();
    const mid = await post(s.admin, '/v1/admin/users', bigJson(200 * 1024), s.adminKey);
    expect(mid.statusCode).not.toBe(413);
    const big = await post(s.admin, '/v1/admin/users', bigJson(1.5 * 1024 * 1024), s.adminKey);
    expect(big.statusCode).toBe(413);
  });
});

describe('session.heartbeat_min_interval_seconds', () => {
  it('spaces heartbeats by the configured interval (429 inside it, 200 after)', async () => {
    s = await startAgentTestServer({
      ambassadorConfig: { session: { heartbeat_min_interval_seconds: 1 } } as never,
    });
    const { userId } = await createUser(s, 'hb');
    const profiles = await s.admin.inject({
      method: 'GET',
      url: '/v1/admin/profiles',
      headers: { 'X-Admin-Key': s.adminKey },
    });
    const profs = JSON.parse(profiles.body).data as Array<{ profile_id: string }>;
    const clientRes = await s.admin.inject({
      method: 'POST',
      url: '/v1/admin/clients',
      headers: { 'X-Admin-Key': s.adminKey },
      payload: { user_id: userId, profile_id: profs[0]!.profile_id, client_name: 'hb-client' },
    });
    expect(clientRes.statusCode).toBe(201);
    const key = JSON.parse(clientRes.body).data.plaintext_key as string;
    const reg = await s.api.inject({
      method: 'POST',
      url: '/v1/sessions/register',
      payload: { preshared_key: key, friendly_name: 'hb-test', host_tool: 'vscode' },
    });
    expect(reg.statusCode, reg.body).toBeLessThan(300);
    const token = (JSON.parse(reg.body).session_token ?? JSON.parse(reg.body).token) as string;

    const hb = () =>
      s!.api.inject({
        method: 'POST',
        url: '/v1/sessions/heartbeat',
        headers: { 'X-Session-Token': token },
      });
    expect((await hb()).statusCode).toBe(200);
    expect((await hb()).statusCode).toBe(429);
    await new Promise(r => setTimeout(r, 1100));
    expect((await hb()).statusCode).toBe(200);
  });
});
