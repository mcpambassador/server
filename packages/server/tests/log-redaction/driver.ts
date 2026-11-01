/**
 * TD-026/TD-028 adversarial driver. Runs in a CHILD process (so pino writes to real stdout) and
 * drives real error paths with canary credentials. Writes sink captures to argv[2] as JSON.
 * Never imported by vitest (not a *.test.ts file).
 */
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import { randomUUID } from 'crypto';
import Fastify from 'fastify';
import { createMcpEntry, createOAuthState } from '@mcpambassador/core';
import { HttpMcpConnection } from '../../src/downstream/http-connection.js';
import { StdioMcpConnection } from '../../src/downstream/stdio-connection.js';
import { registerAdminHealthRoutes } from '../../src/admin/health-routes.js';
import { SecretStore } from '../../src/services/secret-store.js';
import { OAuthTokenManager } from '../../src/services/oauth-token-manager.js';
import { createUser } from '../../src/auth/user-auth.js';
import { startTestServer, stopTestServer } from '../admin-api/helpers.js';

const N = process.env.CANARY_NONCE ?? 'n0nce';
const out: Record<string, unknown> = { endpoint: {}, history: {}, thrown: {} };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Credential-shaped strings built from the nonce. Each `core` must never reach a sink.
export const hostile = (tag: string): string =>
  [
    `amb_pk_${N}${tag}pkcore`,
    `amb_ak_${N}${tag}akcore`,
    `amb_st_${N}${tag}stcore`,
    `amb_rt_${N}${tag}rtcore`,
    `Bearer ${N}${tag}bearercore`,
    `https://user:${N}${tag}urlpass@evil.example/path`,
    `eyJ${N}${tag}hdr0000.eyJ${N}${tag}pay0000.${N}${tag}sig00000`,
    `https://cb.example/cb?code=${N}${tag}codeval&state=${N}${tag}stateval&access_token=${N}${tag}atval`,
    `password: ${N}${tag}pwval token=${N}${tag}tokval`,
  ].join(' | ');

const connections = new Map<string, HttpMcpConnection | StdioMcpConnection>();

async function httpScenarios(): Promise<void> {
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += String(c)));
    req.on('end', () => {
      if (req.url === '/five00') {
        // reason phrase and body both carry credentials
        res.writeHead(500, `Bearer ${N}h5reason`, { 'content-type': 'text/plain' });
        res.end(hostile('h5body'));
        return;
      }
      // /rpcerr: HTTP 200 with a JSON-RPC error that echoes credentials
      const id = (JSON.parse(body || '{}') as { id?: number }).id ?? 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          error: { code: -32000, message: hostile('hrpc'), data: { echo: hostile('hrpcdata') } },
        })
      );
    });
  });
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as AddressInfo).port;
  for (const [name, p] of [
    ['http-500', '/five00'],
    ['http-rpcerr', '/rpcerr'],
  ] as const) {
    const c = new HttpMcpConnection({
      name,
      transport: 'http',
      url: `http://127.0.0.1:${port}${p}`,
      timeout_ms: 3000,
    } as never);
    connections.set(name, c);
    try {
      await c.start();
    } catch (e) {
      (out.thrown as Record<string, string>)[name] = (e as Error).message;
    }
  }
  // connection-level failure whose URL carries credentials (ECONNREFUSED on a closed port)
  srv.close();
  const dead = new HttpMcpConnection({
    name: 'http-dead',
    transport: 'http',
    url: `http://user:${N}deadpass@127.0.0.1:${port}/x?access_token=${N}deadat`,
    timeout_ms: 2000,
  } as never);
  connections.set('http-dead', dead);
  try {
    await dead.start();
  } catch (e) {
    (out.thrown as Record<string, string>)['http-dead'] = (e as Error).message;
  }
}

async function stdioScenarios(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stderr-mcp-'));
  const script = path.join(dir, 'noisy.cjs');
  fs.writeFileSync(
    script,
    `
const H = ${JSON.stringify(hostile('se'))};
console.error(H);
console.error('line two ' + H);
// secrets split across stderr chunks (write boundary inside the credential)
process.stderr.write('before amb_pk_${N}splitA');
setTimeout(() => process.stderr.write('splitB${N}splittail end\\n'), 150);
setTimeout(() => process.stderr.write('Bearer ${N}bsplitA'), 300);
setTimeout(() => process.stderr.write('bsplitB${N}bsplittail\\n'), 450);
// PEM block split across chunks
process.stderr.write('-----BEGIN PRIVATE KEY-----\n${N}pemA');
setTimeout(() => process.stderr.write('${N}pemB\nMIIE${N}pemline2\n-----END PRIVATE KEY-----\n'), 200);
// malformed JSON on stdout carrying credentials (parse-error logging)
process.stdout.write('{"result": {bad json amb_pk_${N}jsoncore Bearer ${N}jsonbearer\n');
// very long line with a credential deep inside
console.error('x'.repeat(90000) + ' amb_pk_${N}longcore ' + 'y'.repeat(20000));
setTimeout(() => process.exit(3), 800);
`
  );
  const c = new StdioMcpConnection({
    name: 'stdio-noisy',
    transport: 'stdio',
    command: ['node', script, `--token=${N}argtoken`, '--api-key', `${N}argkey`, `--url=https://u:${N}argurlpass@h.example/x`],
    timeout_ms: 2500,
  } as never);
  connections.set('stdio-noisy', c);
  try {
    await c.start();
  } catch (e) {
    (out.thrown as Record<string, string>)['stdio-noisy'] = (e as Error).message;
  }
  await sleep(1200);
}

async function oauthScenarios(): Promise<void> {
  process.env['GITHUB_OAUTH_CLIENT_ID'] = 'cid';
  const server = await startTestServer();
  const user = await createUser(server.db, {
    username: 'lr' + randomUUID().slice(0, 6),
    password: 'pass1234',
    display_name: 'LR',
    email: `lr${randomUUID().slice(0, 6)}@example.com`,
  });
  const cfg = {
    auth_url: 'https://github.com/login/oauth/authorize',
    token_url: 'https://github.com/login/oauth/access_token',
    scopes: 'repo',
    client_id_env: 'GITHUB_OAUTH_CLIENT_ID',
    client_secret_env: 'GITHUB_OAUTH_CLIENT_SECRET',
    access_token_env_var: 'GITHUB_TOKEN',
  };
  const mgr = new OAuthTokenManager({
    db: server.db,
    vault: {} as never,
    callbackBaseUrl: 'https://x',
    secretStore: new SecretStore({
      GITHUB_OAUTH_CLIENT_SECRET: {
        value: `${N}oauthclientsecret`,
        allowedTokenHosts: ['github.com'],
      },
    }),
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        error: 'invalid_grant',
        error_description: hostile('oa'),
        access_token: `${N}oabodyat`,
        refresh_token: `${N}oabodyrt`,
      }),
      {
        status: 400,
        statusText: `Bearer ${N}oareason`,
        headers: { 'content-type': 'application/json' },
      }
    )) as typeof fetch;
  try {
    const mcp = await createMcpEntry(server.db, {
      name: 'lr-' + randomUUID().slice(0, 8),
      display_name: 'LR',
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
      user_id: user.user_id,
      mcp_id: mcp.mcp_id,
      code_verifier: 'v'.repeat(64),
      redirect_uri: 'https://x/cb',
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 600000).toISOString(),
    });
    try {
      await mgr.exchangeCodeForTokens(state, `${N}authcode`);
    } catch (e) {
      (out.thrown as Record<string, string>)['oauth-exchange'] = (e as Error).message;
    }
    try {
      await mgr.refreshAccessToken(cfg as never, `${N}oldrefresh`);
    } catch (e) {
      (out.thrown as Record<string, string>)['oauth-refresh'] = (e as Error).message;
    }
  } finally {
    globalThis.fetch = realFetch;
    await stopTestServer(server);
  }
}

async function adminEndpoint(): Promise<void> {
  const app = Fastify({ logger: false });
  const mcpManager = {
    getConnection: (n: string) => connections.get(n),
    getConnectionNames: () => [...connections.keys()],
    getAllConnections: () => connections,
  } as never;
  await app.register(registerAdminHealthRoutes, { mcpManager, userPool: null });
  for (const [name, c] of connections) {
    const r = await app.inject({ method: 'GET', url: `/v1/admin/health/mcps/${name}/logs` });
    (out.endpoint as Record<string, string>)[name] = r.body;
    (out.history as Record<string, unknown>)[name] = c.getErrorHistory();
  }
  const sum = await app.inject({ method: 'GET', url: '/v1/admin/health/mcps' });
  (out.endpoint as Record<string, string>)['__summary'] = sum.body;
  await app.close();
}

await httpScenarios();
await stdioScenarios();
await oauthScenarios();
await adminEndpoint();
for (const c of connections.values()) {
  try {
    await c.stop();
  } catch {
    /* ignore */
  }
}
fs.writeFileSync(process.argv[2]!, JSON.stringify(out));
// flush pino (sync stdout) then exit
setTimeout(() => process.exit(0), 200);
