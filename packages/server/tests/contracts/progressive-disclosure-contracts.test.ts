import { describe, it, expect } from 'vitest';
import {
  META_TOOL_NAMES,
  RESERVED_TOOL_PREFIX,
  TOOL_PIN_RESERVED_NAME_PREFIX,
  callToolInputSchema,
  describeToolInputSchema,
  disclosureModeSchema,
  DISCLOSURE_MODES,
  searchToolsInputSchema,
  SEARCH_TOOLS_DEFAULT_LIMIT,
  SEARCH_TOOLS_MAX_LIMIT,
  SEARCH_TOOLS_MAX_QUERY_LENGTH,
  createGrantRequestSchema,
} from '@mcpambassador/contracts';

describe('progressive disclosure contracts (ADR-022)', () => {
  it('has one source for the reserved prefix', () => {
    expect(RESERVED_TOOL_PREFIX).toBe(TOOL_PIN_RESERVED_NAME_PREFIX);
    for (const n of META_TOOL_NAMES) expect(n.startsWith(RESERVED_TOOL_PREFIX)).toBe(true);
  });

  it.each(['ambassador__call_tool', 'ambassador__describe_tool', 'ambassador__search_tools'])(
    'rejects %s as a describe/call target (no recursion)',
    name => {
      expect(describeToolInputSchema.safeParse({ name }).success).toBe(false);
      expect(callToolInputSchema.safeParse({ name }).success).toBe(false);
    }
  );

  it('accepts ordinary names and rejects empty or oversize ones', () => {
    expect(describeToolInputSchema.safeParse({ name: 'create_issue', mcp: 'github' }).success).toBe(
      true
    );
    expect(callToolInputSchema.safeParse({ name: 'x', arguments: { a: 1 } }).success).toBe(true);
    expect(callToolInputSchema.safeParse({ name: '' }).success).toBe(false);
    expect(callToolInputSchema.safeParse({ name: 'a'.repeat(257) }).success).toBe(false);
  });

  it('disclosure mode is full or progressive', () => {
    expect(disclosureModeSchema.safeParse('progressive').success).toBe(true);
    expect(disclosureModeSchema.safeParse('other').success).toBe(false);
  });

  it('disclosure modes are exactly full and progressive; grant requests accept them or omit', () => {
    expect([...DISCLOSURE_MODES]).toEqual(['full', 'progressive']);
    const base = { bound_client_id: 'c1', scopes: ['mcp:*'] };
    expect(createGrantRequestSchema.safeParse(base).success).toBe(true);
    expect(
      createGrantRequestSchema.safeParse({ ...base, disclosure_mode: 'progressive' }).success
    ).toBe(true);
    expect(createGrantRequestSchema.safeParse({ ...base, disclosure_mode: 'x' }).success).toBe(
      false
    );
  });

  it('META_TOOL_NAMES is exactly the three meta-tools, all reserved-prefixed and distinct', () => {
    expect([...META_TOOL_NAMES].sort()).toEqual([
      'ambassador__call_tool',
      'ambassador__describe_tool',
      'ambassador__search_tools',
    ]);
    expect(new Set(META_TOOL_NAMES).size).toBe(3);
  });

  describe('search_tools input caps', () => {
    it('exports 20 / 50 / 200 as default limit / max limit / max query length', () => {
      expect(SEARCH_TOOLS_DEFAULT_LIMIT).toBe(20);
      expect(SEARCH_TOOLS_MAX_LIMIT).toBe(50);
      expect(SEARCH_TOOLS_MAX_QUERY_LENGTH).toBe(200);
      expect(SEARCH_TOOLS_DEFAULT_LIMIT).toBeLessThanOrEqual(SEARCH_TOOLS_MAX_LIMIT);
    });

    it('query is required, <= 200 chars (empty allowed, 201 rejected)', () => {
      expect(searchToolsInputSchema.safeParse({}).success).toBe(false);
      expect(searchToolsInputSchema.safeParse({ query: '' }).success).toBe(true);
      expect(searchToolsInputSchema.safeParse({ query: 'q'.repeat(200) }).success).toBe(true);
      expect(searchToolsInputSchema.safeParse({ query: 'q'.repeat(201) }).success).toBe(false);
    });

    it('limit is an optional integer in 1..50 (the 20 default is applied by the handler, not the schema)', () => {
      const ok = (limit: unknown) =>
        searchToolsInputSchema.safeParse({ query: 'x', limit }).success;
      expect(ok(1)).toBe(true);
      expect(ok(50)).toBe(true);
      expect(ok(0)).toBe(false);
      expect(ok(51)).toBe(false);
      expect(ok(-1)).toBe(false);
      expect(ok(1.5)).toBe(false);
      expect(ok('5')).toBe(false);
      const none = searchToolsInputSchema.parse({ query: 'x' });
      expect(none.limit).toBeUndefined();
    });

    it('mcp filter is 1..128 chars on search, describe and call', () => {
      expect(searchToolsInputSchema.safeParse({ query: 'x', mcp: '' }).success).toBe(false);
      expect(searchToolsInputSchema.safeParse({ query: 'x', mcp: 'm'.repeat(128) }).success).toBe(
        true
      );
      expect(searchToolsInputSchema.safeParse({ query: 'x', mcp: 'm'.repeat(129) }).success).toBe(
        false
      );
      for (const sch of [describeToolInputSchema, callToolInputSchema]) {
        expect(sch.safeParse({ name: 'n', mcp: '' }).success).toBe(false);
        expect(sch.safeParse({ name: 'n', mcp: 'm'.repeat(128) }).success).toBe(true);
        expect(sch.safeParse({ name: 'n', mcp: 'm'.repeat(129) }).success).toBe(false);
      }
    });
  });
});
