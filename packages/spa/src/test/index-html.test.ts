import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

// The server sends script-src 'self' (no 'unsafe-inline'); an inline <script> is blocked.
describe('index.html', () => {
  const html = readFileSync(resolve(__dirname, '../../index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];

  it('has no inline scripts', () => {
    expect(scripts.length).toBeGreaterThan(0);
    for (const m of scripts) {
      expect(m[1] ?? '').toMatch(/\bsrc=/);
      expect((m[2] ?? '').trim()).toBe('');
    }
  });

  it('loads the theme script from an existing public file', () => {
    expect(html).toContain('src="/theme-init.js"');
    expect(existsSync(resolve(__dirname, '../../public/theme-init.js'))).toBe(true);
  });
});

// Vite rewrites public/ URLs with base '/app/'. If it did not, the server's SPA fallback would
// answer /theme-init.js with index.html (nosniff blocks it) and the theme flash would return.
// Runs after `pnpm -r build` (CI order); skipped when dist/ has not been built.
const distHtml = resolve(__dirname, '../../dist/index.html');
describe.skipIf(!existsSync(distHtml))('built dist/index.html', () => {
  it('points the theme script at the /app/ base and ships the file', () => {
    const html = readFileSync(distHtml, 'utf8');
    expect(html).toContain('src="/app/theme-init.js"');
    expect(html).not.toContain('src="/theme-init.js"');
    expect(existsSync(resolve(__dirname, '../../dist/theme-init.js'))).toBe(true);
  });
});
