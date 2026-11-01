/**
 * ADR-021 D3: validate tool-call arguments against the APPROVED inputSchema (not the live one).
 * Real JSON Schema (Ajv 2020-12), compiled once per approved hash. A schema Ajv cannot compile is
 * logged and skipped (the downstream still validates; the pin has already bound the definition).
 */
import Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv/dist/2020.js';
import { logger } from '@mcpambassador/core';

const ajv = new Ajv2020.default({ strict: false, allErrors: false, validateFormats: false });
const cache = new Map<string, ValidateFunction | null>();
const MAX_CACHE = 2000;

export function validateAgainstApprovedSchema(
  hash: string,
  schema: Record<string, unknown>,
  args: unknown
): { valid: true } | { valid: false; error: string } {
  let fn = cache.get(hash);
  if (fn === undefined) {
    try {
      fn = ajv.compile(schema);
    } catch (err) {
      logger.warn(
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
    error: `Invalid arguments: ${e ? `${e.instancePath || '/'} ${e.message ?? 'invalid'}` : 'schema mismatch'}`,
  };
}
