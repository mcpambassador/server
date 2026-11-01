/**
 * TD-030: every HTML response from the SPA handler (/login, /setup, /app/*, client-route fallback)
 * must carry the CSP and hardening headers, not only /app URLs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { registerSpaHandler, SPA_CSP } from '../src/spa-handler.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const spaIndex = path.join(here, '..', '..', 'spa', 'dist', 'index.html');
const hasSpaDist = fs.existsSync(spaIndex);

describe.skipIf(!hasSpaDist)('SPA handler security headers (TD-030)', () => {
  const app = Fastify();

  beforeAll(async () => {
    await registerSpaHandler(app);
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  const htmlPaths = ['/login', '/setup', '/app/', '/app/dashboard', '/some/client/route'];

  it.each(htmlPaths)('%s is HTML with CSP and hardening headers', async url => {
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers['content-security-policy']).toBe(SPA_CSP);
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('CSP does not allow inline or remote scripts', () => {
    const scriptSrc = SPA_CSP.split(';')
      .map(d => d.trim())
      .find(d => d.startsWith('script-src'));
    expect(scriptSrc).toBe("script-src 'self'");
  });

  it('theme script is an external same-origin script allowed by script-src self', async () => {
    const res = await app.inject({ method: 'GET', url: '/login' });
    expect(res.body).toMatch(/<script[^>]+src="\/app\/theme-init\.js"/);
    expect(res.body).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>\s*\S/);
  });

  it('API-looking paths do not get the SPA fallback or CSP', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-security-policy']).toBeUndefined();
  });
});
