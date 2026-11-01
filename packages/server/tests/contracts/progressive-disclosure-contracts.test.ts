import { describe, it, expect } from 'vitest';
import {
  META_TOOL_NAMES,
  RESERVED_TOOL_PREFIX,
  TOOL_PIN_RESERVED_NAME_PREFIX,
  callToolInputSchema,
  describeToolInputSchema,
  disclosureModeSchema,
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
});
