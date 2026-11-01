/**
 * Shared helpers for ADR-020 agent-endpoint tests.
 *
 * - startAgentTestServer(): like admin-api/helpers.startTestServer but also
 *   exposes the admin (9443) Fastify instance, where SPA sessions + CSRF live.
 * - createUser(): admin-API user creation.
 * - loginSession(): POST /v1/auth/login, returns a cookie jar + CSRF token so
 *   cookie-authenticated mutations (consent, grants) can be exercised.
 */
import os from 'os';
import path from 'path';
import fs from 'fs';
import { it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { AmbassadorServer } from '@mcpambassador/server';
import {
  initializeDatabase,
  closeDatabase,
  runMigrations,
  createAdminKey,
  AgentEndpointConfigSchema,
  type DatabaseClient,
} from '@mcpambassador/core';

/**
 * Build ServerConfig options that enable the agent endpoint (ADR-020).
 * `agent` overrides agent_endpoint.* keys (e.g. { dynamic_client_registration: true }).
 * URLs are pinned so tests can assert issuer/resource never follow the Host header.
 */
export const TEST_ISSUER = 'https://issuer.test.example:9443';
export const TEST_RESOURCE_BASE = 'https://resource.test.example:8443';
export const TEST_RESOURCE = `${TEST_RESOURCE_BASE}/mcp`;

export function agentEndpointOpts(agent: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ambassadorConfig: {
      agent_endpoint: AgentEndpointConfigSchema.parse({
        enabled: true,
        issuer_url: TEST_ISSUER,
        resource_base_url: TEST_RESOURCE_BASE,
        ...agent,
      }),
    } as never,
  };
}

/**
 * Use for tests whose feature is still a 501 stub on the current branch. `it.fails` passes
 * while the test body fails and turns RED once the feature works, forcing removal of this
 * marker (replace `itImpl` with `it`). Set AGENT_IMPL=1 to run them as normal tests.
 */
export const itImpl: typeof it = (process.env['AGENT_IMPL'] === '1' ? it : it.fails) as typeof it;

export interface AgentTestServer {
  /** Client-facing listener (8443 equivalent): /mcp, /.well-known, /v1/tools */
  api: FastifyInstance;
  /** Admin/SPA listener (9443 equivalent): /oauth/authorize, /v1/auth, /v1/csrf-token. */
  admin: FastifyInstance;
  adminKey: string;
  dataDir: string;
  db: DatabaseClient;
  stop: () => Promise<void>;
}

/** Start an in-process server on a temp dir. Pass extra constructor options (e.g. agent_endpoint config) via `opts`. */
export async function startAgentTestServer(
  opts: Record<string, unknown> = {}
): Promise<AgentTestServer> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-agent-test-'));
  const seed = await initializeDatabase({
    type: 'sqlite',
    sqliteFilePath: path.join(dataDir, 'ambassador.db'),
    seedOnInit: true,
  });
  await runMigrations(seed as DatabaseClient);
  const { admin_key } = await createAdminKey(seed as DatabaseClient, dataDir);
  await closeDatabase(seed as DatabaseClient);

  const server = new AmbassadorServer({
    dataDir,
    port: 0,
    host: '127.0.0.1',
    ...opts,
  } as ConstructorParameters<typeof AmbassadorServer>[0]);
  await server.initialize();

  return {
    api: server.getServer(),
    admin: server.getAdminServer(),
    adminKey: admin_key,
    dataDir,
    db: (server as unknown as { db: DatabaseClient }).db,
    stop: async () => {
      try {
        await server.stop();
      } catch {
        /* ignore */
      }
    },
  };
}

export async function stopAgentTestServer(s: AgentTestServer | null | undefined): Promise<void> {
  if (!s) return;
  await s.stop();
  try {
    fs.rmSync(s.dataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

export const TEST_PASSWORD = 'Password123!';

export async function createUser(
  s: AgentTestServer,
  prefix = 'agt'
): Promise<{ userId: string; username: string; password: string }> {
  const username = `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const res = await s.admin.inject({
    method: 'POST',
    url: '/v1/admin/users',
    headers: { 'X-Admin-Key': s.adminKey },
    payload: {
      username,
      password: TEST_PASSWORD,
      display_name: 'Agent Test',
      email: `${username}@example.test`,
    },
  });
  if (res.statusCode !== 201) {
    throw new Error(`createUser failed: ${res.statusCode} ${res.body}`);
  }
  return { userId: JSON.parse(res.body).data.user_id as string, username, password: TEST_PASSWORD };
}

/** Minimal cookie jar: name=value pairs from Set-Cookie headers. */
export class CookieJar {
  private jar = new Map<string, string>();

  absorb(setCookie: string | string[] | undefined): void {
    if (!setCookie) return;
    for (const raw of Array.isArray(setCookie) ? setCookie : [setCookie]) {
      const [pair] = raw.split(';');
      const eq = pair!.indexOf('=');
      if (eq < 1) continue;
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      if (value === '' || /;\s*max-age=0/i.test(raw)) this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  header(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  get(name: string): string | undefined {
    return this.jar.get(name);
  }
}

export interface UserSession {
  cookies: CookieJar;
  csrfToken: string;
  /** Headers for a cookie-authenticated request; set `mutating` to include x-csrf-token. */
  headers: (mutating?: boolean) => Record<string, string>;
  /** inject() on the admin listener with the session cookie (+ CSRF header for non-GET). */
  request: (req: {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    url: string;
    payload?: unknown;
    headers?: Record<string, string>;
  }) => ReturnType<FastifyInstance['inject']>;
}

/** Log in via /v1/auth/login, then fetch a CSRF token bound to the session. */
export async function loginSession(
  s: AgentTestServer,
  creds: { username: string; password: string }
): Promise<UserSession> {
  const cookies = new CookieJar();

  // CSRF cookie must exist before the login POST (login is a state-changing request).
  const pre = await s.admin.inject({ method: 'GET', url: '/v1/csrf-token' });
  cookies.absorb(pre.headers['set-cookie']);
  let csrfToken = (JSON.parse(pre.body) as { csrfToken: string }).csrfToken;

  const login = await s.admin.inject({
    method: 'POST',
    url: '/v1/auth/login',
    headers: { cookie: cookies.header(), 'x-csrf-token': csrfToken },
    payload: creds,
  });
  if (login.statusCode !== 200) {
    throw new Error(`login failed: ${login.statusCode} ${login.body}`);
  }
  cookies.absorb(login.headers['set-cookie']);

  // Re-fetch so the token matches the post-login session cookie.
  const post = await s.admin.inject({
    method: 'GET',
    url: '/v1/csrf-token',
    headers: { cookie: cookies.header() },
  });
  cookies.absorb(post.headers['set-cookie']);
  csrfToken = (JSON.parse(post.body) as { csrfToken: string }).csrfToken;

  const headers = (mutating = false): Record<string, string> => ({
    cookie: cookies.header(),
    ...(mutating ? { 'x-csrf-token': csrfToken } : {}),
  });

  return {
    cookies,
    csrfToken,
    headers,
    request: async req => {
      const mutating = req.method !== 'GET';
      const res = await s.admin.inject({
        method: req.method,
        url: req.url,
        payload: req.payload as never,
        headers: { ...headers(mutating), ...(req.headers ?? {}) },
      });
      cookies.absorb(res.headers['set-cookie']);
      return res;
    },
  };
}
