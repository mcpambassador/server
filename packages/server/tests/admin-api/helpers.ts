import os from 'os';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import type { FastifyInstance } from 'fastify';
import { AmbassadorServer } from '@mcpambassador/server';
import {
  initializeDatabase,
  closeDatabase,
  runMigrations,
  type DatabaseClient,
  createAdminKey,
} from '@mcpambassador/core';

/**
 * Client for the 9443 admin/SPA listener (cookie sessions live ONLY there since F1).
 * `inject` mirrors fastify.inject but transparently supplies the CSRF secret cookie and
 * `x-csrf-token` header on state-changing requests (skipped for X-Admin-Key requests,
 * or when the caller already passed x-csrf-token). Caller-supplied cookies are kept.
 */
export interface AdminClient {
  inject: (opts: Record<string, any>) => ReturnType<FastifyInstance['inject']>;
  /** The raw 9443 Fastify instance. */
  raw: FastifyInstance;
}

export function makeAdminClient(admin: FastifyInstance): AdminClient {
  let csrfCookie = '';
  const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
  const cookieOf = (setCookie: unknown): string => {
    const list = Array.isArray(setCookie) ? setCookie : setCookie ? [String(setCookie)] : [];
    const hit = list.find(c => String(c).startsWith('_csrf='));
    return hit ? String(hit).split(';')[0]! : '';
  };
  return {
    raw: admin,
    inject: async opts => {
      const headers: Record<string, any> = Object.fromEntries(
        Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])
      );
      const method = String(opts.method ?? 'GET').toUpperCase();
      if (SAFE.has(method) || headers['x-admin-key'] || headers['x-csrf-token']) {
        return admin.inject(opts as never);
      }
      const base = [headers.cookie].flat().filter(Boolean).join('; ');
      const withCsrf = (c: string) => [base, c].filter(Boolean).join('; ');
      const tok = await admin.inject({
        method: 'GET',
        url: '/v1/csrf-token',
        headers: { cookie: withCsrf(csrfCookie) },
      });
      csrfCookie = cookieOf(tok.headers['set-cookie']) || csrfCookie;
      const token = (JSON.parse(tok.body) as { csrfToken: string }).csrfToken;
      return admin.inject({
        ...opts,
        headers: { ...headers, cookie: withCsrf(csrfCookie), 'x-csrf-token': token },
      } as never);
    },
  };
}

export interface TestServerHandle {
  /** Client-facing listener (8443): /v1/sessions, /v1/tools, /mcp. No cookies since F1. */
  fastify: FastifyInstance;
  /** Admin/SPA listener (9443) with automatic CSRF: cookie-session + admin routes. */
  admin: AdminClient;
  adminKey: string;
  dataDir: string;
  db: DatabaseClient; // M19.2a: Expose database for test assertions
  stop: () => Promise<void>;
}

export async function startTestServer(
  extra: Record<string, unknown> = {}
): Promise<TestServerHandle> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));

  // Initialize database and create admin key BEFORE starting server
  const dbPath = path.join(tmp, 'ambassador.db');
  const db = await initializeDatabase({ type: 'sqlite', sqliteFilePath: dbPath, seedOnInit: true });

  // Ensure schema is present
  await runMigrations(db as DatabaseClient);

  // Create admin key for tests (plaintext returned)
  const { admin_key } = await createAdminKey(db as DatabaseClient, tmp);

  // Close the temporary DB connection
  await closeDatabase(db as DatabaseClient);

  // Now initialize the server - it will open its own DB connection
  const server = new AmbassadorServer({
    dataDir: tmp,
    port: 0,
    host: '127.0.0.1',
    ...extra,
  } as never);
  await server.initialize();

  return {
    fastify: server.getServer(),
    admin: makeAdminClient(server.getAdminServer()),
    adminKey: admin_key,
    dataDir: tmp,
    db: (server as any).db, // M19.2a: Expose database for test assertions
    stop: async () => {
      try {
        await server.stop();
      } catch (e) {
        // ignore
      }
    },
  };
}

export async function stopTestServer(handle: TestServerHandle) {
  if (!handle) return;
  await handle.stop();
  // best-effort cleanup
  try {
    fs.rmSync(handle.dataDir, { recursive: true, force: true });
  } catch (e) {
    // ignore
  }
}
