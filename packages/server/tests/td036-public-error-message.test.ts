/**
 * TD-036 regression guard: raw error text in code that answers HTTP clients, agents, audit metadata
 * or admin results leaks bound SQL parameters when the error is a DrizzleQueryError (Postgres).
 * Such sites must go through publicErrorMessage(). A site that is legitimately raw (app-typed
 * errors, downstream connection errors, logger-only, JSON.parse/zod/ajv text) carries a
 * `td036-allow: <reason>` comment on its line or within the three lines above it.
 *
 * Scans all of packages/server/src and packages/core/src/pipeline.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SERVER_SRC = join(__dirname, '..', 'src');
const ROOTS = [SERVER_SRC, join(__dirname, '..', '..', 'core', 'src', 'pipeline')];

const V = '(?:err|error|e)';
const PATTERNS: Array<[string, RegExp]> = [
  ['instanceof-ternary', /instanceof Error\s*\?\s*\w+\.message/g],
  ['String(e)', new RegExp(`\\bString\\(\\s*${V}\\s*\\)`, 'g')],
  ['${e}', new RegExp(`\\$\\{\\s*${V}\\s*\\}`, 'g')],
  ['e?.message', new RegExp(`\\b${V}\\?\\.message`, 'g')],
  ['(e as T).message', new RegExp(`\\(${V} as [A-Za-z]+\\)\\.message`, 'g')],
  ['e.toString()', new RegExp(`\\b${V}\\.toString\\(\\)`, 'g')],
  [
    'bare e.message',
    new RegExp(`\\b${V}\\.message\\b(?!\\s*(?:\\.includes\\(|===|\\.startsWith\\())`, 'g'),
  ],
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(n => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}

export function findRawErrorTextSites(text: string): Array<{ line: number; kind: string }> {
  const lines = text.split('\n');
  const hits: Array<{ line: number; kind: string }> = [];
  for (const [kind, rx] of PATTERNS) {
    for (const m of text.matchAll(rx)) {
      const line = text.slice(0, m.index).split('\n').length - 1;
      // a line that already goes through publicErrorMessage( is fine
      if (lines[line]?.includes('publicErrorMessage(')) continue;
      const window = lines.slice(Math.max(0, line - 3), line + 1).join('\n');
      if (!window.includes('td036-allow:')) hits.push({ line: line + 1, kind });
    }
  }
  return hits;
}

describe('TD-036: no raw error text in client-facing code', () => {
  it('detector flags each raw pattern and passes safe or allowlisted forms', () => {
    const bad = [
      'x = e instanceof Error ? e.message : String(e);',
      'x = e instanceof Error\n  ? e.message : "a";',
      'x = `failed: ${String(err)}`;',
      'x = `failed: ${error}`;',
      'x = err?.message;',
      'x = (err as Error).message;',
      'x = e.toString();',
      'x = { message: error.message };',
    ];
    for (const src of bad) expect(findRawErrorTextSites(src).length, src).toBeGreaterThan(0);

    const good = [
      'x = publicErrorMessage(e);',
      'x = e instanceof Error ? publicErrorMessage(e) : "a";',
      'if (err.message.includes("x")) y();',
      'if (err.message === "x") y();',
      'if (err.message.startsWith("x")) y();',
      'x = redactSecretsInString(e);',
      '// td036-allow: logger only\nx = String(err);',
    ];
    for (const src of good) expect(findRawErrorTextSites(src), src).toEqual([]);
  });

  it('every raw error-text site in packages/server/src and core/src/pipeline is allowlisted', () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const f of walk(root)) {
        for (const h of findRawErrorTextSites(readFileSync(f, 'utf8'))) {
          offenders.push(`${relative(join(SERVER_SRC, '..', '..'), f)}:${h.line} [${h.kind}]`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
