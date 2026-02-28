/**
 * Tool Argument Validation
 *
 * Validates tool invocation arguments against downstream MCP's declared schema.
 *
 * Per Architecture §4.4:
 * - Argument names match declared schema
 * - Argument types match declared schema
 * - String length limits enforced (default: 10,000 chars)
 * - Required arguments present
 * - ReDoS protection: Linear-time RE2 regex engine (no backtracking)
 * - redact_fields support for PII stripping
 *
 * Security: F-SEC-M6-009 (tool argument validation)
 * Security: F-SEC-M6.7-001 remediation — replaced setTimeout with RE2
 */

import RE2 from 're2';

export interface ToolSchema {
  name: string;
  description?: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, SchemaProperty>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

export interface SchemaProperty {
  type: string | string[];
  description?: string;
  enum?: unknown[];
  items?: SchemaProperty;
  properties?: Record<string, SchemaProperty>;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
}

export interface ArgumentRestrictions {
  max_string_length?: number; // Default: 10,000 characters
  disallow_patterns?: string[]; // Regex patterns to reject (ReDoS protected)
  redact_fields?: string[]; // Fields to strip before routing
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
  sanitizedArgs?: Record<string, unknown>;
}

/**
 * Default maximum string length for tool arguments
 * Prevents memory exhaustion from oversized arguments
 */
const DEFAULT_MAX_STRING_LENGTH = 10000;

/**
 * RE2 regex engine provides linear-time guarantees (no catastrophic backtracking)
 * No timeout needed — RE2 runs in O(n) time where n is input length
 * F-SEC-M6.7-001 remediation: Replaced Node.js RegExp + setTimeout with Google RE2
 */

/**
 * Validate tool arguments against schema
 *
 * @param args Tool invocation arguments
 * @param schema Tool schema from downstream MCP tools/list
 * @param restrictions Optional additional restrictions from profile
 * @returns Validation result with sanitized arguments if valid
 */
export function validateToolArguments(
  args: Record<string, unknown>,
  schema: ToolSchema,
  restrictions?: ArgumentRestrictions
): ValidationResult {
  const maxStringLength = restrictions?.max_string_length ?? DEFAULT_MAX_STRING_LENGTH;

  // 1. Validate against schema
  const schemaValidation = validateAgainstSchema(args, schema, maxStringLength);
  if (!schemaValidation.valid) {
    return schemaValidation;
  }

  // 2. Apply disallow_patterns (ReDoS protected)
  if (restrictions?.disallow_patterns && restrictions.disallow_patterns.length > 0) {
    const patternValidation = validateDisallowPatterns(args, restrictions.disallow_patterns);
    if (!patternValidation.valid) {
      return patternValidation;
    }
  }

  // 3. Redact sensitive fields
  let sanitizedArgs = args;
  if (restrictions?.redact_fields && restrictions.redact_fields.length > 0) {
    sanitizedArgs = redactFields(args, restrictions.redact_fields);
  }

  return {
    valid: true,
    sanitizedArgs,
  };
}

/**
 * Validate arguments against JSON schema
 */
function validateAgainstSchema(
  args: Record<string, unknown>,
  schema: ToolSchema,
  maxStringLength: number
): ValidationResult {
  const inputSchema = schema.inputSchema;

  // Check type is object
  if (inputSchema.type !== 'object') {
    return { valid: false, error: 'Schema type must be object' };
  }

  const properties = inputSchema.properties || {};
  const required = inputSchema.required || [];
  const additionalProperties = inputSchema.additionalProperties ?? true;

  // Check required arguments present
  for (const requiredArg of required) {
    if (!(requiredArg in args)) {
      return {
        valid: false,
        error: `Missing required argument: ${requiredArg}`,
      };
    }
  }

  // Check argument names (reject unknown arguments if additionalProperties=false)
  if (!additionalProperties) {
    for (const argName of Object.keys(args)) {
      if (!(argName in properties)) {
        return {
          valid: false,
          error: `Unknown argument: ${argName}`,
        };
      }
    }
  }

  // Validate each argument type and constraints
  for (const [argName, argValue] of Object.entries(args)) {
    const propSchema = properties[argName];
    if (!propSchema) {
      // If additionalProperties=true, skip validation for unknown props
      if (additionalProperties) {
        continue;
      }
      return {
        valid: false,
        error: `Unknown argument: ${argName}`,
      };
    }

    const typeValidation = validateType(argValue, propSchema, maxStringLength);
    if (!typeValidation.valid) {
      return {
        valid: false,
        error: `Argument '${argName}': ${typeValidation.error}`,
      };
    }
  }

  return { valid: true };
}

/**
 * Validate value against schema property
 */
function validateType(
  value: unknown,
  schema: SchemaProperty,
  maxStringLength: number
): ValidationResult {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];

  // Check if value matches any allowed type
  let matchedType = false;

  for (const type of types) {
    if (type === 'string' && typeof value === 'string') {
      matchedType = true;

      // Enforce string length limits
      if (value.length > maxStringLength) {
        return {
          valid: false,
          error: `String exceeds maximum length of ${maxStringLength} characters`,
        };
      }

      if (schema.minLength !== undefined && value.length < schema.minLength) {
        return {
          valid: false,
          error: `String shorter than minimum length of ${schema.minLength}`,
        };
      }

      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        return {
          valid: false,
          error: `String exceeds maximum length of ${schema.maxLength}`,
        };
      }

      break;
    } else if (type === 'number' && typeof value === 'number') {
      matchedType = true;

      if (schema.minimum !== undefined && value < schema.minimum) {
        return {
          valid: false,
          error: `Number less than minimum of ${schema.minimum}`,
        };
      }

      if (schema.maximum !== undefined && value > schema.maximum) {
        return {
          valid: false,
          error: `Number exceeds maximum of ${schema.maximum}`,
        };
      }

      break;
    } else if (type === 'integer' && typeof value === 'number' && Number.isInteger(value)) {
      matchedType = true;

      if (schema.minimum !== undefined && value < schema.minimum) {
        return {
          valid: false,
          error: `Integer less than minimum of ${schema.minimum}`,
        };
      }

      if (schema.maximum !== undefined && value > schema.maximum) {
        return {
          valid: false,
          error: `Integer exceeds maximum of ${schema.maximum}`,
        };
      }

      break;
    } else if (type === 'boolean' && typeof value === 'boolean') {
      matchedType = true;
      break;
    } else if (type === 'null' && value === null) {
      matchedType = true;
      break;
    } else if (type === 'array' && Array.isArray(value)) {
      matchedType = true;

      // Validate array items if schema provided
      if (schema.items) {
        for (let i = 0; i < value.length; i++) {
          const itemValidation = validateType(value[i], schema.items, maxStringLength);
          if (!itemValidation.valid) {
            return {
              valid: false,
              error: `Array item ${i}: ${itemValidation.error}`,
            };
          }
        }
      }

      break;
    } else if (
      type === 'object' &&
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value)
    ) {
      matchedType = true;

      // Validate nested object properties if schema provided
      if (schema.properties) {
        for (const [propName, propValue] of Object.entries(value)) {
          const propSchema = schema.properties[propName];
          if (propSchema) {
            const propValidation = validateType(propValue, propSchema, maxStringLength);
            if (!propValidation.valid) {
              return {
                valid: false,
                error: `Property '${propName}': ${propValidation.error}`,
              };
            }
          }
        }
      }

      break;
    }
  }

  if (!matchedType) {
    return {
      valid: false,
      error: `Type mismatch: expected ${types.join(' or ')}, got ${typeof value}`,
    };
  }

  // Check enum constraint
  if (schema.enum && !schema.enum.includes(value)) {
    return {
      valid: false,
      error: `Value not in allowed enum: ${JSON.stringify(schema.enum)}`,
    };
  }

  return { valid: true };
}

/**
 * Validate arguments against disallow_patterns (ReDoS protected)
 */
function validateDisallowPatterns(
  args: Record<string, unknown>,
  patterns: string[]
): ValidationResult {
  // Flatten all string values from args (including nested)
  const flattenedStrings: string[] = [];
  flattenStrings(args, flattenedStrings);

  for (const patternStr of patterns) {
    try {
      // F-SEC-M6.7-001 remediation: Use RE2 for linear-time regex (no ReDoS possible)
      const regex = new RE2(patternStr);

      for (const str of flattenedStrings) {
        // RE2.test() runs in O(n) time — no catastrophic backtracking, no timeout needed
        const matched = regex.test(str);

        if (matched) {
          return {
            valid: false,
            error: `Argument contains disallowed pattern: ${patternStr}`,
          };
        }
      }
    } catch (err) {
      // Invalid regex - log error and skip this pattern
      console.error(`[validation] Invalid disallow_pattern: ${patternStr}`, err);
    }
  }

  return { valid: true };
}

/**
 * F-SEC-M6.7-001 remediation: testRegexWithTimeout() removed
 *
 * The previous implementation used setTimeout() which cannot interrupt
 * synchronous regex.test() execution in Node.js V8 engine. This meant
 * the ReDoS timeout provided ZERO protection.
 *
 * Replaced with RE2 engine which guarantees linear-time execution with
 * no catastrophic backtracking. No timeout mechanism is needed.
 */

/**
 * Flatten all strings from nested object (for pattern matching)
 */
function flattenStrings(obj: unknown, result: string[]): void {
  if (typeof obj === 'string') {
    result.push(obj);
  } else if (Array.isArray(obj)) {
    for (const item of obj) {
      flattenStrings(item, result);
    }
  } else if (typeof obj === 'object' && obj !== null) {
    for (const value of Object.values(obj)) {
      flattenStrings(value, result);
    }
  }
}

/**
 * Redact sensitive fields from arguments (PII protection)
 *
 * F-SEC-M6-029 remediation: Recursive redaction for nested objects and arrays
 */
function redactFields(
  args: Record<string, unknown>,
  redactFieldNames: string[]
): Record<string, unknown> {
  return redactFieldsRecursive(args, redactFieldNames) as Record<string, unknown>;
}

/**
 * Recursively redact fields in nested objects and arrays
 */
function redactFieldsRecursive(value: unknown, redactFieldNames: string[]): unknown {
  // Handle null/undefined
  if (value === null || value === undefined) {
    return value;
  }

  // Handle arrays: recursively redact each element
  if (Array.isArray(value)) {
    return value.map(item => redactFieldsRecursive(item, redactFieldNames));
  }

  // Handle objects: recursively redact nested objects and check field names
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const redacted: Record<string, unknown> = {};

    for (const [key, val] of Object.entries(obj)) {
      // Check if this field name should be redacted
      if (redactFieldNames.includes(key)) {
        redacted[key] = '[REDACTED]';
      } else {
        // Recursively process nested values
        redacted[key] = redactFieldsRecursive(val, redactFieldNames);
      }
    }

    return redacted;
  }

  // Primitive values: return as-is
  return value;
}
