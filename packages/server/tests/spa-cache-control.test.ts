/**
 * TD-021: the global no-store hook must not override the SPA static handler's cache policy for
 * /app files, while API, auth and HTML responses stay no-store/no-cache.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { applyNoStoreUnlessStaticAsset, registerSpaHandler } from '../src/spa-handler.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const spaDist = path.join(here, '..', '..', 'spa', 'dist');
const assetsDir = path.join(spaDist, 'assets');
const hasSpaDist = fs.existsSync(path.join(spaDist, 'index.html')) && fs.existsSync(assetsDir);

describe('applyNoStoreUnlessStaticAsset (TD-021)', () => {
  const run = (url: string, existing?: string): string | undefined => {
    const headers: Record<string, string> = existing ? { 'cache-control': existing } : {};
    applyNoStoreUnlessStaticAsset(
      { url },
      {
        getHeader: n => headers[n.toLowerCase()],
        header: (n, v) => {
          headers[n.toLowerCase()] = v;
        },
      }
    );
    return headers['cache-control'];
  };

  it('keeps a public cache policy only for /app files', () => {
    expect(run('/app/assets/a.js', 'public, max-age=31536000, immutable')).toBe(
      'public, max-age=31536000, immutable'
    );
  });
  it('forces no-store everywhere else', () => {
    expect(run('/v1/users/me')).toBe('no-store');
    expect(run('/v1/users/me', 'public, max-age=60')).toBe('no-store');
    expect(run('/app/dashboard', 'no-cache')).toBe('no-store');
    expect(run('/login')).toBe('no-store');
  });
});

describe.skipIf(!hasSpaDist)('SPA assets with the global no-store hook (TD-021)', () => {
  const app = Fastify();

  beforeAll(async () => {
    app.addHook('onSend', async (request, reply) => {
      applyNoStoreUnlessStaticAsset(request, reply);
    });
    app.get('/v1/ping', async () => ({ ok: true }));
    await registerSpaHandler(app);
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  it('serves hashed assets as immutable', async () => {
    const file = fs.readdirSync(assetsDir).find(f => f.endsWith('.js'));
    expect(file).toBeDefined();
    const res = await app.inject({ method: 'GET', url: `/app/assets/${file}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('keeps API responses no-store', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/ping' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('keeps the HTML shell uncacheable', async () => {
    const res = await app.inject({ method: 'GET', url: '/app/dashboard' });
    expect(res.headers['cache-control']).toMatch(/no-store|no-cache/);
  });
});
