/**
 * ADR-021 D1 vector runner (verifier). Independent of the builder's runner: it checks the fixture is
 * internally consistent against a tiny reference JCS oracle, then that the pin service's canonical form
 * and hash match every vector byte for byte.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { TOOL_CANONICALIZATION } from '@mcpambassador/contracts';
import {
  canonicalizeToolDefinition,
  parseToolDefinition,
} from '../../src/services/tool-pins/canonical.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const V = JSON.parse(
  fs.readFileSync(
    path.resolve(here, '../../../contracts/fixtures/tool-definition-canonical-vectors.json'),
    'utf8'
  )
);
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** RFC 8785 reference: keys sorted by UTF-16 code units, ES number serialisation, arrays in order. */
function jcs(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(jcs).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map(k => `${JSON.stringify(k)}:${jcs(o[k])}`)
    .join(',')}}`;
}
const STRIP = new Set(TOOL_CANONICALIZATION.hashedFields as readonly string[]);
const stripped = (raw: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(raw).filter(([k]) => STRIP.has(k)));
const rawOf = (c: any): any =>
  c.definition_json !== undefined ? JSON.parse(c.definition_json) : c.definition;

describe('fixture is self-consistent (oracle)', () => {
  for (const c of V.cases) {
    it(`${c.id}: sha256 matches canonical, canonical matches reference JCS`, () => {
      expect(sha(c.canonical)).toBe(c.sha256);
      expect(jcs(stripped(rawOf(c)))).toBe(c.canonical);
    });
  }
});

describe('pin service canonical form', () => {
  for (const c of V.cases) {
    it(`${c.id}: bytes and hash`, () => {
      const p = parseToolDefinition(rawOf(c));
      expect(p.ok).toBe(true);
      if (!p.ok) return;
      const r = canonicalizeToolDefinition(p.definition);
      expect(r.canonical).toBe(c.canonical);
      expect(r.hash).toBe(c.sha256);
      expect(r.bytes).toBe(Buffer.byteLength(c.canonical, 'utf8'));
    });
  }

  it('every equal/different assertion holds across the cases', () => {
    const h = new Map<string, string>(V.cases.map((c: any) => [c.id, c.sha256]));
    for (const a of V.assertions) {
      expect(h.has(a.a) && h.has(a.b)).toBe(true);
      expect(h.get(a.a) === h.get(a.b)).toBe(a.op === 'equal');
    }
  });

  it('hash is stable for repeated and re-parsed input', () => {
    const c = V.cases[0];
    const once = canonicalizeToolDefinition((parseToolDefinition(rawOf(c)) as any).definition);
    const twice = canonicalizeToolDefinition(
      (parseToolDefinition(JSON.parse(once.canonical)) as any).definition
    );
    expect(twice.hash).toBe(once.hash);
  });
});
