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
