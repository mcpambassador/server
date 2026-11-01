/**
 * TD-027 B2 (verifier set): OAuth secret/host binding.
 * Create-time: POST/PATCH /v1/admin/mcps reject unsafe oauth_config with 400 VALIDATION_ERROR.
 * Runtime: a bad config seeded straight into the DB never causes an outbound request.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { createMcpEntry, createOAuthState } from '@mcpambassador/core';
import { startTestServer, stopTestServer, type TestServerHandle } from '../admin-api/helpers.js';
import { createUser } from '../../src/auth/user-auth.js';
import { SecretStore } from '../../src/services/secret-store.js';
import { OAuthTokenManager } from '../../src/services/oauth-token-manager.js';

const GH_SECRET = 'b2-github-secret-canary';

const SECRETS = {
  GITHUB_OAUTH_CLIENT_SECRET: { value: GH_SECRET, allowedTokenHosts: ['github.com'] },
};

const oauth = (over: Record<string, string> = {}): Record<string, string> => ({
  auth_url: 'https://github.com/login/oauth/authorize',
  token_url: 'https://github.com/login/oauth/access_token',
  scopes: 'repo',
  client_id_env: 'GITHUB_OAUTH_CLIENT_ID',
  client_secret_env: 'GITHUB_OAUTH_CLIENT_SECRET',
  access_token_env_var: 'GITHUB_TOKEN',
  ...over,
});

describe('B2 create-time validation (admin API)', () => {
  let server: TestServerHandle;
  beforeAll(async () => {
    server = await startTestServer({ oauthClientSecrets: SECRETS });
  });
  afterAll(async () => {
    await stopTestServer(server);
  });

  const headers = () => ({ 'X-Admin-Key': server.adminKey });
  const body = (oauthConfig: Record<string, string>) => ({
    name: 'b2-' + randomUUID().slice(0, 8),
    display_name: 'B2',
    transport_type: 'http',
    config: { url: 'https://mcp.example/mcp' },
    auth_type: 'oauth2',
    oauth_config: oauthConfig,
  });
  const post = (oc: Record<string, string>) =>
    server.admin.inject({
      method: 'POST',
      url: '/v1/admin/mcps',
      headers: headers(),
      payload: body(oc),
    });

  const bad: Array<[string, Record<string, string>]> = [
    ['GitHub secret + non-github token_url', oauth({ token_url: 'https://evil.example/token' })],
    ['GitHub secret + lookalike host', oauth({ token_url: 'https://github.com.evil.example/t' })],
    ['client_secret_env=REGISTRY_TOKEN', oauth({ client_secret_env: 'REGISTRY_TOKEN' })],
    [
      'http:// token_url on github.com',
      oauth({ token_url: 'http://github.com/login/oauth/access_token' }),
    ],
    ['client_id_env=DATABASE_URL', oauth({ client_id_env: 'DATABASE_URL' })],
  ];

  for (const [label, cfg] of bad) {
    it(`POST rejects: ${label}`, async () => {
      const r = await post(cfg);
      expect(r.statusCode).toBe(400);
      expect(r.body).toContain('VALIDATION_ERROR');
    });
    it(`PATCH rejects: ${label}`, async () => {
      const created = await post(oauth());
      expect(created.statusCode).toBe(201);
      const id = created.json().data.mcp_id as string;
      const r = await server.admin.inject({
        method: 'PATCH',
        url: `/v1/admin/mcps/${id}`,
        headers: headers(),
        payload: { oauth_config: cfg },
      });
      expect(r.statusCode).toBe(400);
      expect(r.body).toContain('VALIDATION_ERROR');
    });
  }

  it('non-OAuth invalid body (missing name) -> 400 VALIDATION_ERROR, no echoed input values', async () => {
    const canary = 'ECHO-CANARY-9d41';
    const payload = {
      display_name: canary,
      transport_type: canary, // invalid enum value
      config: { url: 'https://mcp.example/mcp', token: canary },
    };
    for (const method of ['POST', 'PATCH'] as const) {
      const url = method === 'POST' ? '/v1/admin/mcps' : `/v1/admin/mcps/${randomUUID()}`;
      const r = await server.admin.inject({ method, url, headers: headers(), payload });
      expect(r.statusCode, `${method}`).toBe(400);
      expect(r.body).toContain('VALIDATION_ERROR');
      expect(r.body.includes(canary), r.body.slice(0, 500)).toBe(false);
    }
  });

  it('control: GitHub secret + github.com token_url + *_CLIENT_ID is accepted', async () => {
    const r = await post(oauth());
    expect(r.statusCode).toBe(201);
  });
});

describe('B2 runtime: bad config seeded in the DB sends nothing', () => {
  let server: TestServerHandle;
  let userId: string;
  beforeAll(async () => {
    server = await startTestServer();
    userId = (
      await createUser(server.db, {
        username: 'b2user',
        password: 'pass1234',
        display_name: 'B2',
        email: 'b2@example.com',
      })
    ).user_id;
  });
  afterAll(async () => {
    await stopTestServer(server);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env['GITHUB_OAUTH_CLIENT_ID'];
  });

  const mgr = () =>
    new OAuthTokenManager({
      db: server.db,
      vault: {} as never,
      callbackBaseUrl: 'https://x',
      secretStore: new SecretStore(SECRETS),
    });

  async function seed(cfg: Record<string, string>): Promise<string> {
    const mcp = await createMcpEntry(server.db, {
      name: 'b2rt-' + randomUUID().slice(0, 8),
      display_name: 'B2 runtime',
      transport_type: 'http',
      config: JSON.stringify({ url: 'https://mcp.example/mcp' }),
      requires_user_credentials: false,
      auth_type: 'oauth2',
      oauth_config: JSON.stringify(cfg),
      status: 'published',
    } as never);
    const state = randomUUID();
    const now = new Date();
    await createOAuthState(server.db, {
      state,
      user_id: userId,
      mcp_id: mcp.mcp_id,
      code_verifier: 'v'.repeat(64),
      redirect_uri: 'https://x/cb',
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 600000).toISOString(),
    });
    return state;
  }

  const badRuntime: Array<[string, Record<string, string>]> = [
    ['GitHub secret + evil token_url', oauth({ token_url: 'https://evil.example/token' })],
    ['client_secret_env=REGISTRY_TOKEN', oauth({ client_secret_env: 'REGISTRY_TOKEN' })],
    [
      'http://github.com token_url',
      oauth({ token_url: 'http://github.com/login/oauth/access_token' }),
    ],
  ];

  for (const [label, cfg] of badRuntime) {
    it(`exchangeCodeForTokens throws, no request: ${label}`, async () => {
      process.env['GITHUB_OAUTH_CLIENT_ID'] = 'cid';
      process.env['REGISTRY_TOKEN'] = GH_SECRET;
      const f = vi.spyOn(globalThis, 'fetch');
      const state = await seed(cfg);
      await expect(mgr().exchangeCodeForTokens(state, 'code')).rejects.toThrow();
      expect(f).not.toHaveBeenCalled();
      delete process.env['REGISTRY_TOKEN'];
    });
  }

  it('refresh with http://github.com token_url throws, no request', async () => {
    process.env['GITHUB_OAUTH_CLIENT_ID'] = 'cid';
    const f = vi.spyOn(globalThis, 'fetch');
    await expect(
      mgr().refreshAccessToken(
        oauth({ token_url: 'http://github.com/login/oauth/access_token' }) as never,
        'rt'
      )
    ).rejects.toThrow();
    expect(f).not.toHaveBeenCalled();
  });

  it('(a) github token_url + revocation_url on another host: revoke sends nothing', async () => {
    process.env['GITHUB_OAUTH_CLIENT_ID'] = 'cid';
    const f = vi.spyOn(globalThis, 'fetch');
    await mgr().revokeTokens(
      oauth({ revocation_url: 'https://evil.example/revoke' }) as never,
      'at',
      'rt'
    );
    expect(f).not.toHaveBeenCalled();
  });

  it('control: revoke to a github.com revocation_url does send', async () => {
    process.env['GITHUB_OAUTH_CLIENT_ID'] = 'cid';
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 200 }));
    await mgr().revokeTokens(
      oauth({ revocation_url: 'https://github.com/login/oauth/revoke' }) as never,
      'at'
    );
    expect(f).toHaveBeenCalled();
  });
});
