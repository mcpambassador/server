import { describe, expect, it } from 'vitest';
import {
  MAX_ARG_DEPTH,
  MAX_ARG_STRING_CHARS,
  validateAgainstApprovedSchema,
} from '../../src/services/tool-pins/args-validator.js';

describe('args validator (S1)', () => {
  it('a catastrophic-backtracking pattern from an approved schema cannot ReDoS (RE2, linear time)', () => {
    const schema = {
      type: 'object',
      properties: { s: { type: 'string', pattern: '^(a+)+$' } },
    };
    const evil = { s: 'a'.repeat(50_000) + '!' };
    const start = Date.now();
    const r = validateAgainstApprovedSchema('h-redos', schema, evil);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(r.valid).toBe(false);
    expect(validateAgainstApprovedSchema('h-redos', schema, { s: 'aaaa' }).valid).toBe(true);
  });

  it('patterns still validate normally', () => {
    const schema = {
      type: 'object',
      properties: { id: { type: 'string', pattern: '^[a-z]{3}\\d+$' } },
    };
    expect(validateAgainstApprovedSchema('h-pat', schema, { id: 'abc12' }).valid).toBe(true);
    expect(validateAgainstApprovedSchema('h-pat', schema, { id: 'ABC' }).valid).toBe(false);
  });

  it('caps string length, depth and node count before validation', () => {
    const schema = { type: 'object' };
    expect(
      validateAgainstApprovedSchema('h-b', schema, { s: 'x'.repeat(MAX_ARG_STRING_CHARS + 1) })
        .valid
    ).toBe(false);
    expect(
      validateAgainstApprovedSchema('h-b', schema, { s: 'x'.repeat(MAX_ARG_STRING_CHARS) }).valid
    ).toBe(true);
    let deep: unknown = 'x';
    for (let i = 0; i < MAX_ARG_DEPTH + 2; i++) deep = { a: deep };
    expect(validateAgainstApprovedSchema('h-b', schema, deep).valid).toBe(false);
    expect(
      validateAgainstApprovedSchema('h-b', schema, { a: Array.from({ length: 60_000 }, () => 1) })
        .valid
    ).toBe(false);
  });
});
