import { describe, expect, it } from 'vitest';
import { TOOL_PIN_INFORMATIONAL_FLAG_CODES } from '@mcpambassador/contracts';
import { scanToolDefinition } from '../../src/services/tool-pins/flags.js';
import { hasUnsupportedPattern } from '../../src/services/tool-pins/schema-patterns.js';
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

  it('an RE2-unsupported pattern is dropped, the rest of the schema is still enforced, and it is flagged', () => {
    const schema = {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', maxLength: 5, pattern: '^(?!bad)\\w+$' },
        n: { type: 'integer' },
      },
    };
    const v = (a: unknown) => validateAgainstApprovedSchema('h-unsup', schema, a).valid;
    expect(v({ name: 'ok' })).toBe(true);
    expect(v({ name: 'toolongname' })).toBe(false); // maxLength still enforced
    expect(v({})).toBe(false); // required still enforced
    expect(v({ name: 'ok', n: 'x' })).toBe(false); // type still enforced
    expect(hasUnsupportedPattern(schema)).toBe(true);
    expect(hasUnsupportedPattern({ type: 'string', pattern: '^[a-z]+$' })).toBe(false);
    expect(hasUnsupportedPattern({ patternProperties: { '(?<=a)b': {} } })).toBe(true);
    const flags = scanToolDefinition({ name: 't', inputSchema: schema } as never);
    expect(flags.codes).toContain('pattern_unsupported');
    expect(TOOL_PIN_INFORMATIONAL_FLAG_CODES as readonly string[]).not.toContain(
      'pattern_unsupported'
    );
  });

  it('an uncompilable pattern never falls back to native RegExp (backreference + catastrophic input stays fast)', () => {
    const schema = { type: 'object', properties: { s: { type: 'string', pattern: '^(a+)+\\1$' } } };
    expect(hasUnsupportedPattern(schema)).toBe(true);
    const start = Date.now();
    const r = validateAgainstApprovedSchema('h-nofallback', schema, { s: 'a'.repeat(40) + '!' });
    expect(Date.now() - start).toBeLessThan(500);
    expect(r.valid).toBe(true); // keyword dropped, not evaluated natively
  });
});
