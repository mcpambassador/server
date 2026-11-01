/**
 * FB-031 (PR #115): the SPA dialog's API path. Register an OAuth client via
 * POST /v1/admin/oauth-clients, confirm it is listed with an exact redirect_uris match,
 * then DELETE it and confirm its grants are revoked and tokens stop working.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AGENT_MCP_ROUTE, ADMIN_OAUTH_CLIENTS_ROUTE } from '@mcpambassador/contracts';
import {
  startAgentTestServer,
  stopAgentTestServer,
  agentEndpointOpts,
  createUser,
  loginSession,
  type AgentTestServer,
  type UserSession,
} from './helpers.js';
import { registerAdminClient, fullFlow, REDIRECT_URI } from './oauth-flow-helpers.js';

const URIS = [REDIRECT_URI, 'http://localhost:33418/callback'];

let s: AgentTestServer;
let alice: UserSession;
beforeAll(async () => {
  s = await startAgentTestServer(agentEndpointOpts());
  alice = await loginSession(s, await createUser(s, 'alice'));
});
afterAll(async () => {
  await stopAgentTestServer(s);
});

const adm = { 'X-Admin-Key': '' };
const call = (method: 'GET' | 'DELETE', url: string) =>
  s.admin.inject({ method, url, headers: { ...adm, 'X-Admin-Key': s.adminKey } });

describe('admin OAuth client lifecycle (FB-031)', () => {
  it('create -> listed with exact redirect_uris -> delete revokes grants', async () => {
    const clientId = await registerAdminClient(s, {
      client_name: 'dlg-client',
      redirect_uris: URIS,
    });

    const list = await call('GET', ADMIN_OAUTH_CLIENTS_ROUTE);
    expect(list.statusCode).toBe(200);
    const row = (list.json().data as Array<Record<string, unknown>>).find(
      c => c['client_id'] === clientId
    );
    expect(row).toBeDefined();
    expect(row!['client_name']).toBe('dlg-client');
    expect(row!['redirect_uris']).toEqual(URIS);

    // grant issued through that client works...
    const tok = await fullFlow(s, alice, clientId, { scopes: ['mcp:*'] });
    const init = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    };
    const ok = await s.api.inject({
      method: 'POST',
      url: AGENT_MCP_ROUTE,
      headers: { authorization: `Bearer ${tok.access_token}`, 'content-type': 'application/json' },
      payload: init,
    });
    expect(ok.statusCode).not.toBe(401);

    const before = await call('GET', '/v1/admin/agent-grants?include_inactive=true');
    const ids = (before.json().data as Array<Record<string, unknown>>)
      .filter(g => g['client_id'] === clientId)
      .map(g => g['grant_id']);
    expect(ids.length).toBeGreaterThan(0);

    const del = await call('DELETE', `${ADMIN_OAUTH_CLIENTS_ROUTE}/${clientId}`);
    expect(del.statusCode).toBe(204);

    // gone from list, grants revoked, token rejected
    const after = await call('GET', ADMIN_OAUTH_CLIENTS_ROUTE);
    expect(
      (after.json().data as Array<Record<string, unknown>>).some(c => c['client_id'] === clientId)
    ).toBe(false);
    const grants = await call('GET', '/v1/admin/agent-grants?include_inactive=true');
    const mine = (grants.json().data as Array<Record<string, unknown>>).filter(g =>
      ids.includes(g['grant_id'])
    );
    expect(mine.length).toBe(ids.length);
    for (const g of mine) expect(g['revoked_at']).toBeTruthy();
    const denied = await s.api.inject({
      method: 'POST',
      url: AGENT_MCP_ROUTE,
      headers: { authorization: `Bearer ${tok.access_token}`, 'content-type': 'application/json' },
      payload: init,
    });
    expect(denied.statusCode).toBe(401);
  });

  it('rejects a disallowed redirect_uri (fragment / non-loopback http)', async () => {
    for (const bad of ['https://a.example/cb#frag', 'http://evil.example/cb', 'ftp://x/cb']) {
      await expect(registerAdminClient(s, { redirect_uris: [bad] })).rejects.toThrow(/40\d/);
    }
  });
});
