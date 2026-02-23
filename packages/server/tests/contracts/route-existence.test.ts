import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
// simple recursive file collector (avoids external glob dependency)
import { startTestServer, stopTestServer } from '../admin-api/helpers';

const DUMMY_ID = '00000000-0000-0000-0000-000000000000';

function normalizePathLiteral(raw: string) {
  // raw includes surrounding quotes or backticks
  const inner = raw.replace(/^['"`]|['"`]$/g, '');
  // replace template ${...} with :param
  const replaced = inner.replace(/\$\{[^}]+\}/g, ':param');
  // replace path params like :id (keep as-is)
  return replaced;
}

function pathToInjectUrl(p: string) {
  // convert :param placeholders into dummy id
  return p.replace(/:param/g, DUMMY_ID);
}

function extractApiCallsFromFile(content: string) {
  const results: Array<{ method: string; path: string }> = [];
  const re = /apiClient\.(get|post|put|patch|delete)\s*\(\s*([`"'][^`"']*[`"'])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    const method = m[1].toUpperCase();
    const rawPath = m[2];
    const normalized = normalizePathLiteral(rawPath);
    // skip full URLs
    if (/^https?:\/\//.test(normalized)) continue;
    results.push({ method, path: normalized });
  }
  return results;
}

async function gatherSpaRoutes(): Promise<Array<{ method: string; path: string }>> {
  // Tests run from packages/server, so go up two levels to reach monorepo root
  const monorepoRoot = path.join(process.cwd(), '..', '..');
  const spaRoot = path.join(monorepoRoot, 'packages', 'spa', 'src');

  function collectFiles(dir: string, out: string[]) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) collectFiles(full, out);
      else if (ent.isFile() && /\.(ts|tsx|js)$/.test(ent.name)) out.push(full);
    }
  }

  const files: string[] = [];
  try { collectFiles(spaRoot, files); } catch (e) { /* ignore if spa not present */ }

  const routes: Array<{ method: string; path: string }> = [];
  for (const f of files) {
    try {
      const content = fs.readFileSync(f, 'utf8');
      const extracted = extractApiCallsFromFile(content);
      for (const e of extracted) routes.push(e);
    } catch (e) {
      // ignore unreadable files
    }
  }

  // deduplicate
  const unique = new Map<string, { method: string; path: string }>();
  for (const r of routes) {
    const key = `${r.method} ${r.path}`;
    if (!unique.has(key)) unique.set(key, r);
  }
  return Array.from(unique.values());
}

let handle: Awaited<ReturnType<typeof startTestServer>>;
let userCookieHeader = '';

beforeAll(async () => {
  handle = await startTestServer();
  // attempt login to obtain a user session cookie for non-admin routes
  const loginRes = await handle.fastify.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: 'admin', password: 'admin123' } });
  if (loginRes.cookies && loginRes.cookies.length) {
    userCookieHeader = loginRes.cookies.map((c: any) => `${c.name}=${c.value}`).join('; ');
  }
});

afterAll(async () => {
  await stopTestServer(handle);
});

describe('Contract: SPA route existence checker', () => {
  it('all SPA-referenced API endpoints must be registered on the server', async () => {
    const spaRoutes = await gatherSpaRoutes();
    expect(spaRoutes.length).toBeGreaterThan(0);

    const missing: Array<{ method: string; path: string; status: number; body: any }> = [];

    for (const r of spaRoutes) {
      const url = pathToInjectUrl(r.path);
      const opts: any = { method: r.method, url };

      // choose auth: admin routes use X-Admin-Key, others use session cookie when available
      if (url.startsWith('/v1/admin') || url.startsWith('/v1/audit') || url.startsWith('/v1/admin/')) {
        opts.headers = { 'X-Admin-Key': handle.adminKey };
      } else {
        if (userCookieHeader) opts.headers = { cookie: userCookieHeader };
      }

      const res = await handle.fastify.inject(opts);
      let body: any = {};
      try { body = JSON.parse(res.body || '{}'); } catch (e) { body = res.body; }

      // detect Fastify route-not-found
      const isRouteNotFound = (body && (body.code === 'FST_ERR_NOT_FOUND' || (typeof body.message === 'string' && body.message.includes('not found')))) || (!body && res.statusCode === 404);
      if (isRouteNotFound) {
        missing.push({ method: r.method, path: r.path, status: res.statusCode, body });
      }
    }

    if (missing.length) {
      const lines = missing.map(m => `${m.method} ${m.path} => status ${m.status} body=${JSON.stringify(m.body)}`);
      throw new Error('Missing routes detected:\n' + lines.join('\n'));
    }
  }, 200000);
});
