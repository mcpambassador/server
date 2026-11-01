/**
 * ADR-021 D3: validate tool-call arguments against the APPROVED inputSchema (not the live one).
 * Real JSON Schema (Ajv 2020-12), compiled once per approved hash. A schema Ajv cannot compile is
 * logged and skipped (the downstream still validates; the pin has already bound the definition).
 */
import Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv/dist/2020.js';
import RE2 from 're2';
import { logger } from '@mcpambassador/core';
import { stripUnsupportedPatterns } from './schema-patterns.js';

/** Defence in depth next to RE2 (S1): bounds on what reaches schema validation. */
export const MAX_ARG_STRING_CHARS = 262_144;
export const MAX_ARG_DEPTH = 32;
export const MAX_ARG_NODES = 50_000;

/**
 * S1: schema `pattern` / `patternProperties` run on RE2 (linear time), so an approved schema cannot
 * ReDoS the server with agent-supplied strings. A pattern RE2 cannot express (lookaround, backrefs) makes
 * the schema uncompilable, which is handled below like any other uncompilable schema.
 */
const regExp = Object.assign((pattern: string, flags: string) => new RE2(pattern, flags), {
  code: 'new RE2', // only used by Ajv standalone code generation, which we do not use
});

const ajv = new Ajv2020.default({
  strict: false,
  allErrors: false,
  validateFormats: false,
  code: { regExp },
});

/** Reject oversize strings, excessive depth and huge argument trees before validation. */
export function checkArgumentBounds(args: unknown): string | null {
  let nodes = 0;
  const stack: Array<[unknown, number]> = [[args, 0]];
  while (stack.length > 0) {
    const [v, depth] = stack.pop()!;
    if (++nodes > MAX_ARG_NODES) return 'Invalid arguments: too many values';
    if (typeof v === 'string') {
      if (v.length > MAX_ARG_STRING_CHARS) return 'Invalid arguments: string value too long';
    } else if (v !== null && typeof v === 'object') {
      if (depth >= MAX_ARG_DEPTH) return 'Invalid arguments: nesting too deep';
      for (const child of Array.isArray(v) ? v : Object.values(v)) stack.push([child, depth + 1]);
    }
  }
  return null;
}
const cache = new Map<string, ValidateFunction | null>();
const MAX_CACHE = 2000;

export function validateAgainstApprovedSchema(
  hash: string,
  schema: Record<string, unknown>,
  args: unknown
): { valid: true } | { valid: false; error: string } {
  const bounds = checkArgumentBounds(args);
  if (bounds) return { valid: false, error: bounds };
  let fn = cache.get(hash);
  if (fn === undefined) {
    try {
      fn = ajv.compile(stripUnsupportedPatterns(schema));
    } catch (err) {
      logger.warn(
        // td036-allow: logger-only, never returned to a client
        { err: String(err), hash: hash.slice(0, 8) },
        '[tool-pins] approved inputSchema not compilable; argument validation skipped'
      );
      fn = null;
    }
    if (cache.size >= MAX_CACHE) cache.clear();
    cache.set(hash, fn);
  }
  if (fn === null) return { valid: true };
  if (fn(args)) return { valid: true };
  const e = fn.errors?.[0];
  return {
    valid: false,
    // td036-allow: zod/ajv issue text, not an Error; no bound values
    error: `Invalid arguments: ${e ? `${e.instancePath || '/'} ${e.message ?? 'invalid'}` : 'schema mismatch'}`,
  };
}
