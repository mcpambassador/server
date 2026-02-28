/**
 * Tool Argument Validation Tests
 *
 * Tests M6.7: Tool argument validation with schema validation,
 * ReDoS protection, and field redaction.
 */

import { describe, it, expect } from 'vitest';
import { validateToolArguments, type ToolSchema, type ArgumentRestrictions } from '../index';

describe('validateToolArguments', () => {
  // ==========================================================================
  // BASIC SCHEMA VALIDATION
  // ==========================================================================

  describe('Schema Validation', () => {
    const simpleSchema: ToolSchema = {
      name: 'test_tool',
      inputSchema: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            maxLength: 100,
          },
          count: {
            type: 'integer',
            minimum: 0,
            maximum: 100,
          },
          enabled: {
            type: 'boolean',
          },
        },
        required: ['message'],
      },
    };

    it('should accept valid arguments', () => {
      const result = validateToolArguments(
        { message: 'hello', count: 42, enabled: true },
        simpleSchema
      );

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should reject missing required argument', () => {
      const result = validateToolArguments({ count: 42 }, simpleSchema);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Missing required argument: message');
    });

    it('should reject wrong type', () => {
      const result = validateToolArguments({ message: 123 }, simpleSchema);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Type mismatch');
    });

    it('should reject integer that is not an integer', () => {
      const result = validateToolArguments({ message: 'hello', count: 42.5 }, simpleSchema);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Type mismatch');
    });

    it('should enforce string maxLength from schema', () => {
      const result = validateToolArguments({ message: 'a'.repeat(101) }, simpleSchema);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('exceeds maximum length of 100');
    });

    it('should enforce integer minimum', () => {
      const result = validateToolArguments({ message: 'hello', count: -1 }, simpleSchema);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('less than minimum');
    });

    it('should enforce integer maximum', () => {
      const result = validateToolArguments({ message: 'hello', count: 101 }, simpleSchema);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('exceeds maximum');
    });
  });

  // ==========================================================================
  // ADDITIONAL PROPERTIES
  // ==========================================================================

  describe('Additional Properties', () => {
    const strictSchema: ToolSchema = {
      name: 'strict_tool',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
        required: ['name'],
        additionalProperties: false,
      },
    };

    const permissiveSchema: ToolSchema = {
      name: 'permissive_tool',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
        required: ['name'],
        additionalProperties: true, // default
      },
    };

    it('should reject unknown arguments when additionalProperties=false', () => {
      const result = validateToolArguments({ name: 'test', extra: 'not allowed' }, strictSchema);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Unknown argument: extra');
    });

    it('should allow unknown arguments when additionalProperties=true', () => {
      const result = validateToolArguments({ name: 'test', extra: 'allowed' }, permissiveSchema);

      expect(result.valid).toBe(true);
    });
  });

  // ==========================================================================
  // STRING LENGTH LIMITS
  // ==========================================================================

  describe('String Length Limits', () => {
    const schema: ToolSchema = {
      name: 'string_tool',
      inputSchema: {
        type: 'object',
        properties: {
          data: { type: 'string' },
        },
        required: ['data'],
      },
    };

    it('should enforce default max string length (10,000)', () => {
      const result = validateToolArguments({ data: 'a'.repeat(10001) }, schema);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('exceeds maximum length of 10000');
    });

    it('should enforce custom max string length', () => {
      const restrictions: ArgumentRestrictions = {
        max_string_length: 100,
      };

      const result = validateToolArguments({ data: 'a'.repeat(101) }, schema, restrictions);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('exceeds maximum length of 100');
    });

    it('should allow strings within limit', () => {
      const restrictions: ArgumentRestrictions = {
        max_string_length: 100,
      };

      const result = validateToolArguments({ data: 'a'.repeat(100) }, schema, restrictions);

      expect(result.valid).toBe(true);
    });
  });

  // ==========================================================================
  // NESTED OBJECTS & ARRAYS
  // ==========================================================================

  describe('Nested Validation', () => {
    const nestedSchema: ToolSchema = {
      name: 'nested_tool',
      inputSchema: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'string',
              maxLength: 10,
            },
          },
          config: {
            type: 'object',
            properties: {
              timeout: { type: 'integer', minimum: 0 },
            },
          },
        },
        required: ['items'],
      },
    };

    it('should validate array items', () => {
      const result = validateToolArguments({ items: ['short', 'ok'] }, nestedSchema);

      expect(result.valid).toBe(true);
    });

    it('should reject invalid array item', () => {
      const result = validateToolArguments({ items: ['short', 'this is too long'] }, nestedSchema);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Array item 1');
      expect(result.error).toContain('exceeds maximum length');
    });

    it('should validate nested object properties', () => {
      const result = validateToolArguments(
        { items: ['ok'], config: { timeout: 30 } },
        nestedSchema
      );

      expect(result.valid).toBe(true);
    });

    it('should reject invalid nested property', () => {
      const result = validateToolArguments(
        { items: ['ok'], config: { timeout: -1 } },
        nestedSchema
      );

      expect(result.valid).toBe(false);
      expect(result.error).toContain('timeout');
      expect(result.error).toContain('less than minimum');
    });
  });

  // ==========================================================================
  // DISALLOW PATTERNS (ReDoS PROTECTION)
  // ==========================================================================

  describe('Disallow Patterns', () => {
    const schema: ToolSchema = {
      name: 'pattern_tool',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string' },
        },
        required: ['command'],
      },
    };

    it('should reject arguments matching disallow pattern', () => {
      const restrictions: ArgumentRestrictions = {
        disallow_patterns: ['\\$\\(', '`'],
      };

      const result = validateToolArguments({ command: 'echo $(whoami)' }, schema, restrictions);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('disallowed pattern');
    });

    it('should reject backtick pattern', () => {
      const restrictions: ArgumentRestrictions = {
        disallow_patterns: ['`'],
      };

      const result = validateToolArguments({ command: 'echo `whoami`' }, schema, restrictions);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('disallowed pattern');
    });

    it('should allow arguments without disallowed patterns', () => {
      const restrictions: ArgumentRestrictions = {
        disallow_patterns: ['\\$\\(', '`'],
      };

      const result = validateToolArguments({ command: 'echo hello' }, schema, restrictions);

      expect(result.valid).toBe(true);
    });

    it('should handle invalid regex gracefully (skip pattern)', () => {
      const restrictions: ArgumentRestrictions = {
        disallow_patterns: ['[invalid', 'valid'],
      };

      // Invalid regex is logged but skipped
      const result = validateToolArguments({ command: 'test valid' }, schema, restrictions);

      // Should fail because 'valid' pattern matches
      expect(result.valid).toBe(false);
    });

    it('should check nested string values', () => {
      const nestedSchema: ToolSchema = {
        name: 'nested_pattern_tool',
        inputSchema: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                command: { type: 'string' },
              },
            },
          },
          required: ['data'],
        },
      };

      const restrictions: ArgumentRestrictions = {
        disallow_patterns: ['\\$\\('],
      };

      const result = validateToolArguments(
        { data: { command: 'echo $(whoami)' } },
        nestedSchema,
        restrictions
      );

      expect(result.valid).toBe(false);
      expect(result.error).toContain('disallowed pattern');
    });
  });

  // ==========================================================================
  // FIELD REDACTION
  // ==========================================================================

  describe('Field Redaction', () => {
    const schema: ToolSchema = {
      name: 'redaction_tool',
      inputSchema: {
        type: 'object',
        properties: {
          username: { type: 'string' },
          password: { type: 'string' },
          email: { type: 'string' },
        },
        required: ['username'],
      },
    };

    it('should redact specified fields', () => {
      const restrictions: ArgumentRestrictions = {
        redact_fields: ['password', 'email'],
      };

      const result = validateToolArguments(
        {
          username: 'alice',
          password: 'secret123',
          email: 'alice@example.com',
        },
        schema,
        restrictions
      );

      expect(result.valid).toBe(true);
      expect(result.sanitizedArgs).toEqual({
        username: 'alice',
        password: '[REDACTED]',
        email: '[REDACTED]',
      });
    });

    it('should preserve non-redacted fields', () => {
      const restrictions: ArgumentRestrictions = {
        redact_fields: ['password'],
      };

      const result = validateToolArguments(
        {
          username: 'alice',
          password: 'secret123',
        },
        schema,
        restrictions
      );

      expect(result.valid).toBe(true);
      expect(result.sanitizedArgs?.username).toBe('alice');
      expect(result.sanitizedArgs?.password).toBe('[REDACTED]');
    });

    it('should not error if redact field does not exist', () => {
      const restrictions: ArgumentRestrictions = {
        redact_fields: ['nonexistent'],
      };

      const result = validateToolArguments({ username: 'alice' }, schema, restrictions);

      expect(result.valid).toBe(true);
    });
  });

  // ==========================================================================
  // ENUM VALIDATION
  // ==========================================================================

  describe('Enum Validation', () => {
    const enumSchema: ToolSchema = {
      name: 'enum_tool',
      inputSchema: {
        type: 'object',
        properties: {
          level: {
            type: 'string',
            enum: ['debug', 'info', 'warn', 'error'],
          },
        },
        required: ['level'],
      },
    };

    it('should accept valid enum value', () => {
      const result = validateToolArguments({ level: 'info' }, enumSchema);

      expect(result.valid).toBe(true);
    });

    it('should reject invalid enum value', () => {
      const result = validateToolArguments({ level: 'invalid' }, enumSchema);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('not in allowed enum');
    });
  });

  // ==========================================================================
  // UNION TYPES
  // ==========================================================================

  describe('Union Types', () => {
    const unionSchema: ToolSchema = {
      name: 'union_tool',
      inputSchema: {
        type: 'object',
        properties: {
          value: {
            type: ['string', 'number'],
          },
        },
        required: ['value'],
      },
    };

    it('should accept string in union type', () => {
      const result = validateToolArguments({ value: 'hello' }, unionSchema);

      expect(result.valid).toBe(true);
    });

    it('should accept number in union type', () => {
      const result = validateToolArguments({ value: 42 }, unionSchema);

      expect(result.valid).toBe(true);
    });

    it('should reject type not in union', () => {
      const result = validateToolArguments({ value: true }, unionSchema);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Type mismatch');
    });
  });
});
