/**
 * TD-036 regression guard: a raw `<e> instanceof Error ? <e>.message` in code that answers HTTP
 * clients, agents, audit metadata or admin results leaks bound SQL parameters when <e> is a
 * DrizzleQueryError (Postgres). Such sites must go through publicErrorMessage(). A site that
 * is legitimately raw (downstream connection errors, logger-only, JSON.parse text) carries a
 * `td036-allow: <reason>` comment within the three lines above it.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '..', 'src');
const DIRS = ['admin', 'routes', 'services', 'downstream'];
const RAW = /instanceof Error\s*\?\s*\w+\.message/g;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(n => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}

export function findRawErrorMessageSites(text: string): number[] {
  const lines = text.split('\n');
  const hits: number[] = [];
  for (const m of text.matchAll(RAW)) {
    const line = text.slice(0, m.index).split('\n').length - 1;
    const window = lines.slice(Math.max(0, line - 3), line + 1).join('\n');
    if (!window.includes('td036-allow:')) hits.push(line + 1);
  }
  return hits;
}

describe('TD-036: no raw err.message in client-facing code', () => {
  it('detector flags a raw site and passes publicErrorMessage and allowlisted sites', () => {
    expect(findRawErrorMessageSites('x = e instanceof Error ? e.message : String(e);')).toEqual([
      1,
    ]);
    expect(findRawErrorMessageSites('x = e instanceof Error\n  ? e.message : "a";')).toEqual([1]);
    expect(findRawErrorMessageSites('x = publicErrorMessage(e);')).toEqual([]);
    expect(
      findRawErrorMessageSites('x = e instanceof Error ? publicErrorMessage(e) : "a";')
    ).toEqual([]);
    expect(
      findRawErrorMessageSites(
        '// td036-allow: logger only\nx = e instanceof Error ? e.message : "a";'
      )
    ).toEqual([]);
  });

  it('every raw site under admin/, routes/, services/, downstream/ is allowlisted with a reason', () => {
    const offenders: string[] = [];
    for (const d of DIRS) {
      for (const f of walk(join(SRC, d))) {
        for (const line of findRawErrorMessageSites(readFileSync(f, 'utf8'))) {
          offenders.push(`${relative(SRC, f)}:${line}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
