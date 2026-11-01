/**
 * TD-027 follow-up: secrets preserved in process.env for the server's own use
 * (REGISTRY_TOKEN, GITHUB_OAUTH_CLIENT_SECRET) must not leak through the
 * http-url ${VAR} fallback, and must still reach their legitimate consumers.
 */
import { describe, it, beforeAll, afterAll, afterEach, expect } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { HttpMcpConnection } from '../../src/downstream/http-connection';
import { RegistryService } from '../../src/services/registry-service';

const REG_CANARY = 'canary-registry-token-7f3a91';
const GH_CANARY = 'canary-github-secret-2c8d04';

interface Seen {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

describe('preserved server secrets: egress paths', () => {
  let server: http.Server;
  let port = 0;
  const seen: Seen[] = [];
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const k of ['REGISTRY_TOKEN', 'GITHUB_OAUTH_CLIENT_SECRET']) saved[k] = process.env[k];
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => (body += String(c)));
      req.on('end', () => {
        seen.push({ url: req.url ?? '', headers: req.headers, body });
        if (req.url?.startsWith('/registry')) {
          res.writeHead(200, { 'content-type': 'text/yaml' });
          res.end(
            'schema_version: "1"\nregistry:\n  name: t\n  maintainer: t\n  updated_at: "2026-01-01"\nmcps: []\n'
          );
          return;
        }
        let id: unknown = 1;
        try {
          id = (JSON.parse(body) as { id?: unknown }).id ?? 1;
        } catch {
          /* non-JSON */
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id, result: { tools: [] } }));
      });
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>(r => server.close(() => r()));
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  afterEach(() => {
    seen.length = 0;
  });

  it('http-url ${REGISTRY_TOKEN} is not expanded from process.env and fails closed (no request)', async () => {
    process.env['REGISTRY_TOKEN'] = REG_CANARY;
    const conn = new HttpMcpConnection({
      name: 'egress-reg',
      transport: 'http',
      url: `http://127.0.0.1:${port}/mcp?t=\${REGISTRY_TOKEN}`,
    } as never);
    await expect(conn.start()).rejects.toThrow();
    await conn.stop();
    // fail closed: unresolved \${NAME} => no request at all, and never expanded from process.env
    expect(seen).toHaveLength(0);
  });

  it('http-url ${GITHUB_OAUTH_CLIENT_SECRET} is not expanded from process.env and fails closed (no request)', async () => {
    process.env['GITHUB_OAUTH_CLIENT_SECRET'] = GH_CANARY;
    const conn = new HttpMcpConnection({
      name: 'egress-gh',
      transport: 'http',
      url: `http://127.0.0.1:${port}/mcp?s=\${GITHUB_OAUTH_CLIENT_SECRET}`,
    } as never);
    await expect(conn.start()).rejects.toThrow();
    await conn.stop();
    expect(seen).toHaveLength(0);
  });

  it('positive control: explicit config.env var still expands in the url', async () => {
    const conn = new HttpMcpConnection({
      name: 'egress-ctl',
      transport: 'http',
      url: `http://127.0.0.1:${port}/mcp?k=\${EXPLICIT_VAR}`,
      env: { EXPLICIT_VAR: 'explicit-ok' },
    } as never);
    await conn.start().catch(() => undefined);
    await conn.stop();
    expect(seen.some(s => s.url.includes('k=explicit-ok'))).toBe(true);
  });

  it('registry fetch still sends the configured token as Authorization', async () => {
    const svc = new RegistryService(
      {
        url: `http://127.0.0.1:${port}/registry`,
        refreshIntervalHours: 24,
        enabled: true,
        token: REG_CANARY,
      },
      {} as never
    );
    await svc.fetchRegistry();
    const req = seen.find(s => s.url.startsWith('/registry'));
    expect(req?.headers['authorization']).toBe(`token ${REG_CANARY}`);
  });
});
