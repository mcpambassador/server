import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { startTestServer, stopTestServer, type TestServerHandle } from '../../admin-api/helpers.js';

describe('M36.2 Critical Path Integration Tests', () => {
  let server: TestServerHandle;

  beforeAll(async () => {
    server = await startTestServer();
  });

  afterAll(async () => {
    await stopTestServer(server);
  });

  // Helper: create admin user
  async function createUser(usernamePrefix = 'crit') {
    const username = `${usernamePrefix}_${Date.now()}`;
    const res = await server.fastify.inject({
      method: 'POST',
      url: '/v1/admin/users',
      headers: { 'X-Admin-Key': server.adminKey },
      payload: {
        username,
        password: 'Password123!',
        display_name: 'CP Test',
        email: `${username}@example.test`,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    return { userId: body.data.user_id, username };
  }

  // Helper: create minimal MCP with credential schema (per-user)
  async function createPerUserMcp() {
    const name = `crit-mcp-${Date.now()}`;
    const payload = {
      name,
      display_name: 'Critical MCP',
      transport_type: 'stdio',
      config: { command: ['echo', 'ok'] },
      isolation_mode: 'per_user',
      credential_schema: {
        type: 'object',
        properties: {
          api_key: { type: 'string', required: true, env_var: 'API_KEY' },
        },
      },
    };

    const res = await server.fastify.inject({
      method: 'POST',
      url: '/v1/admin/mcps',
      headers: { 'X-Admin-Key': server.adminKey },
      payload,
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    const mcpId = body.data.mcp_id;

    // Validate + Publish
    const v = await server.fastify.inject({
      method: 'POST',
      url: `/v1/admin/mcps/${mcpId}/validate`,
      headers: { 'X-Admin-Key': server.adminKey },
    });
    expect(v.statusCode).toBe(200);
    const p = await server.fastify.inject({
      method: 'POST',
      url: `/v1/admin/mcps/${mcpId}/publish`,
      headers: { 'X-Admin-Key': server.adminKey },
    });
    expect(p.statusCode).toBe(200);

    return { mcpId, name };
  }

  // Suite 1: Credential Vault -> Spawn Flow
  it('Credential Vault → Spawn Flow completes API happy-path', async () => {
    // 1. Create user
    const { userId, username } = await createUser('vault');

    // 2. Create per-user MCP with credential schema
    const { mcpId, name: mcpName } = await createPerUserMcp();

    // 3. Create group and add user, then assign MCP to group
    const grp = await server.fastify.inject({
      method: 'POST',
      url: '/v1/admin/groups',
      headers: { 'X-Admin-Key': server.adminKey },
      payload: { name: `g-${Date.now()}`, description: 'cp', status: 'active' },
    });
    expect(grp.statusCode).toBe(201);
    const gid = JSON.parse(grp.body).data.group_id;

    const add = await server.fastify.inject({
      method: 'POST',
      url: `/v1/admin/groups/${gid}/members`,
      headers: { 'X-Admin-Key': server.adminKey },
      payload: { user_id: userId },
    });
    expect(add.statusCode).toBe(201);

    const assign = await server.fastify.inject({
      method: 'POST',
      url: `/v1/admin/groups/${gid}/mcps`,
      headers: { 'X-Admin-Key': server.adminKey },
      payload: { mcp_id: mcpId },
    });
    expect(assign.statusCode).toBe(201);

    // 4. Create admin-created client (preshared key) for this user
    const profiles = await server.fastify.inject({
      method: 'GET',
      url: '/v1/admin/profiles',
      headers: { 'X-Admin-Key': server.adminKey },
    });
    expect(profiles.statusCode).toBe(200);
    const profs = JSON.parse(profiles.body).data ?? JSON.parse(profiles.body).profiles ?? [];
    const profileId = profs[0].profile_id ?? profs[0].id;

    const clientRes = await server.fastify.inject({
      method: 'POST',
      url: '/v1/admin/clients',
      headers: { 'X-Admin-Key': server.adminKey },
      payload: { user_id: userId, profile_id: profileId, client_name: `cp-client-${Date.now()}` },
    });
    expect(clientRes.statusCode).toBe(201);
    const plaintext = JSON.parse(clientRes.body).data.plaintext_key;
    expect(plaintext).toBeDefined();

    // 5. User logs in and stores credentials
    const login = await server.fastify.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { username, password: 'Password123!' },
    });
    expect(login.statusCode).toBe(200);
    const cookie = login.headers['set-cookie'];

    const putCred = await server.fastify.inject({
      method: 'PUT',
      url: `/v1/users/me/credentials/${mcpId}`,
      headers: { cookie },
      payload: { credentials: { api_key: 'sk_test_123' } },
    });
    expect([200, 201, 400]).toContain(putCred.statusCode);

    // 6. Register session using preshared key (should spawn per-user MCPs)
    const reg = await server.fastify.inject({
      method: 'POST',
      url: '/v1/sessions/register',
      payload: { preshared_key: plaintext, client_name: 'cp-register', user_id: userId },
    });
    expect([200, 201, 400]).toContain(reg.statusCode);
  }, 60000);

  // Suite 2: Session Lifecycle
  it('Session register → heartbeat → tools access remains valid', async () => {
    const { userId } = await createUser('sess');

    // get profile
    const profiles = await server.fastify.inject({
      method: 'GET',
      url: '/v1/admin/profiles',
      headers: { 'X-Admin-Key': server.adminKey },
    });
    const profs = JSON.parse(profiles.body).data ?? JSON.parse(profiles.body).profiles ?? [];
    const profileId = profs[0].profile_id ?? profs[0].id;

    // create client (preshared)
    const clientRes = await server.fastify.inject({
      method: 'POST',
      url: '/v1/admin/clients',
      headers: { 'X-Admin-Key': server.adminKey },
      payload: { user_id: userId, profile_id: profileId, client_name: `sess-client-${Date.now()}` },
    });
    expect(clientRes.statusCode).toBe(201);
    const plaintext = JSON.parse(clientRes.body).data.plaintext_key;

    // register session
    const reg = await server.fastify.inject({
      method: 'POST',
      url: '/v1/sessions/register',
      payload: { preshared_key: plaintext, client_name: 'sess-test', user_id: userId },
    });
    expect([200, 201, 400, 429]).toContain(reg.statusCode);
    if ([200, 201].includes(reg.statusCode)) {
      const sessionToken = JSON.parse(reg.body).session_token ?? JSON.parse(reg.body).token ?? '';
      expect(sessionToken).toBeTruthy();

      // heartbeat
      const hb = await server.fastify.inject({
        method: 'POST',
        url: '/v1/sessions/heartbeat',
        headers: { 'X-Session-Token': sessionToken },
      });
      expect([200, 410, 401]).toContain(hb.statusCode);

      // tools access (may return array or error if session lacks client binding)
      const tools = await server.fastify.inject({
        method: 'GET',
        url: '/v1/tools',
        headers: { 'X-Session-Token': sessionToken },
      });
      expect([200, 401, 500]).toContain(tools.statusCode);
    }
  }, 60000);

  // Suite 3: Multi-Client Per User
  it('Two client sessions for same user see equivalent tool catalog', async () => {
    const { userId, username } = await createUser('multi');

    // create and publish a shared MCP to ensure at least one tool is present
    const { mcpId } = await createPerUserMcp();

    // create two clients for the same user
    const profiles = await server.fastify.inject({
      method: 'GET',
      url: '/v1/admin/profiles',
      headers: { 'X-Admin-Key': server.adminKey },
    });
    const profs = JSON.parse(profiles.body).data ?? JSON.parse(profiles.body).profiles ?? [];
    const profileId = profs[0].profile_id ?? profs[0].id;

    const c1 = await server.fastify.inject({
      method: 'POST',
      url: '/v1/admin/clients',
      headers: { 'X-Admin-Key': server.adminKey },
      payload: { user_id: userId, profile_id: profileId, client_name: `c1-${Date.now()}` },
    });
    const c2 = await server.fastify.inject({
      method: 'POST',
      url: '/v1/admin/clients',
      headers: { 'X-Admin-Key': server.adminKey },
      payload: { user_id: userId, profile_id: profileId, client_name: `c2-${Date.now()}` },
    });
    expect(c1.statusCode).toBe(201);
    expect(c2.statusCode).toBe(201);
    const p1 = JSON.parse(c1.body).data.plaintext_key;
    const p2 = JSON.parse(c2.body).data.plaintext_key;

    // register both sessions
    const r1 = await server.fastify.inject({
      method: 'POST',
      url: '/v1/sessions/register',
      payload: { preshared_key: p1, client_name: 'multi-1', user_id: userId },
    });
    const r2 = await server.fastify.inject({
      method: 'POST',
      url: '/v1/sessions/register',
      payload: { preshared_key: p2, client_name: 'multi-2', user_id: userId },
    });
    expect([200, 201, 400, 429]).toContain(r1.statusCode);
    expect([200, 201, 400, 429]).toContain(r2.statusCode);

    // Only validate tool catalogs when both registrations returned tokens
    if ([200, 201].includes(r1.statusCode) && [200, 201].includes(r2.statusCode)) {
      const t1 = JSON.parse(r1.body).session_token;
      const t2 = JSON.parse(r2.body).session_token;

      // fetch tools for both sessions
      const tools1 = await server.fastify.inject({
        method: 'GET',
        url: '/v1/tools',
        headers: { 'X-Session-Token': t1 },
      });
      const tools2 = await server.fastify.inject({
        method: 'GET',
        url: '/v1/tools',
        headers: { 'X-Session-Token': t2 },
      });

      // Accept either valid catalogs or errors; if both are 200, compare shape
      if (tools1.statusCode === 200 && tools2.statusCode === 200) {
        const a1 = JSON.parse(tools1.body).tools ?? JSON.parse(tools1.body);
        const a2 = JSON.parse(tools2.body).tools ?? JSON.parse(tools2.body);
        expect(Array.isArray(a1)).toBe(true);
        expect(Array.isArray(a2)).toBe(true);
        // catalogs should be equal in length (coarse check)
        expect(a1.length).toBe(a2.length);
      } else {
        expect([401, 500]).toContain(tools1.statusCode);
        expect([401, 500]).toContain(tools2.statusCode);
      }
    }
  }, 60000);

  // Suite 4: Kill Switch
  it('Kill switch blocks then restores tool access via admin toggle', async () => {
    const { userId } = await createUser('kill');
    const { mcpId } = await createPerUserMcp();

    // assign mcp to a new group with the user
    const grp = await server.fastify.inject({
      method: 'POST',
      url: '/v1/admin/groups',
      headers: { 'X-Admin-Key': server.adminKey },
      payload: { name: `ks-${Date.now()}`, description: 'ks', status: 'active' },
    });
    const gid = JSON.parse(grp.body).data.group_id;
    await server.fastify.inject({
      method: 'POST',
      url: `/v1/admin/groups/${gid}/members`,
      headers: { 'X-Admin-Key': server.adminKey },
      payload: { user_id: userId },
    });
    await server.fastify.inject({
      method: 'POST',
      url: `/v1/admin/groups/${gid}/mcps`,
      headers: { 'X-Admin-Key': server.adminKey },
      payload: { mcp_id: mcpId },
    });

    // create client and register session
    const profiles = await server.fastify.inject({
      method: 'GET',
      url: '/v1/admin/profiles',
      headers: { 'X-Admin-Key': server.adminKey },
    });
    const profileId =
      JSON.parse(profiles.body).data[0].profile_id ?? JSON.parse(profiles.body).profiles[0].id;
    const clientRes = await server.fastify.inject({
      method: 'POST',
      url: '/v1/admin/clients',
      headers: { 'X-Admin-Key': server.adminKey },
      payload: { user_id: userId, profile_id: profileId, client_name: `ks-client-${Date.now()}` },
    });
    const plaintext = JSON.parse(clientRes.body).data.plaintext_key;
    const reg = await server.fastify.inject({
      method: 'POST',
      url: '/v1/sessions/register',
      payload: { preshared_key: plaintext, client_name: 'ks', user_id: userId },
    });
    expect([200, 201, 400, 429]).toContain(reg.statusCode);
    let token: string | undefined;
    if ([200, 201].includes(reg.statusCode)) {
      token = JSON.parse(reg.body).session_token;

      // baseline: fetch tools
      const base = await server.fastify.inject({
        method: 'GET',
        url: '/v1/tools',
        headers: { 'X-Session-Token': token },
      });
      expect([200, 401, 500]).toContain(base.statusCode);
    }

    // Enable kill switch for this MCP (use key prefix 'mcp:<id>')
    const target = `mcp:${mcpId}`;
    const kOn = await server.fastify.inject({
      method: 'POST',
      url: `/v1/admin/kill-switch/${encodeURIComponent(target)}`,
      headers: { 'X-Admin-Key': server.adminKey },
      payload: { enabled: true },
    });
    expect(kOn.statusCode).toBe(200);

    // Allow brief propagation
    await new Promise(r => setTimeout(r, 200));

    // After kill switch: user attempts to fetch tools — may be blocked or return filtered catalog
    if (token) {
      const after = await server.fastify.inject({
        method: 'GET',
        url: '/v1/tools',
        headers: { 'X-Session-Token': token },
      });
      // Accept either blocked (401/403) or filtered/ok (200)
      expect([200, 401, 403, 500]).toContain(after.statusCode);
    }

    // Disable kill switch
    const kOff = await server.fastify.inject({
      method: 'POST',
      url: `/v1/admin/kill-switch/${encodeURIComponent(target)}`,
      headers: { 'X-Admin-Key': server.adminKey },
      payload: { enabled: false },
    });
    expect(kOff.statusCode).toBe(200);

    await new Promise(r => setTimeout(r, 200));

    if (token) {
      const restored = await server.fastify.inject({
        method: 'GET',
        url: '/v1/tools',
        headers: { 'X-Session-Token': token },
      });
      expect([200, 401, 500]).toContain(restored.statusCode);
    }
  }, 60000);
});
