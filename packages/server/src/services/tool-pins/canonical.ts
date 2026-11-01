/**
 * ADR-021 D1: canonical form + hash of a tool definition.
 *
 * Canonical form = RFC 8785 (JCS) over the stripped definition (name, title, description, inputSchema,
 * outputSchema, annotations, icons; `_meta` and unknown fields removed). No Unicode normalisation or
 * trimming: any byte-level change must change the hash. The served definition is built from the stored
 * canonical JSON, so the hash covers exactly what an agent reads.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  TOOL_CANONICALIZATION,
  TOOL_NAME_LOG_MAX_LENGTH,
  toolDefinitionSchema,
  type ToolDefinition,
} from '@mcpambassador/contracts';

// `canonicalize` is CommonJS (`module.exports = fn`); load it explicitly so ESM/TS interop can't bite.
const canonicalizeJcs = createRequire(import.meta.url)('canonicalize') as (
  input: unknown
) => string | undefined;

export type ParsedToolDefinition =
  | { ok: true; definition: ToolDefinition }
  | { ok: false; reason: string };

/** Validate + strip a raw downstream tool object. Never throws. Reason never echoes values. */
export function parseToolDefinition(raw: unknown): ParsedToolDefinition {
  const parsed = toolDefinitionSchema.safeParse(raw);
  if (!parsed.success) {
    const paths = [...new Set(parsed.error.issues.map(i => i.path.join('.') || '(root)'))];
    return { ok: false, reason: `invalid fields: ${paths.join(', ')}` };
  }
  return { ok: true, definition: parsed.data };
}

export interface CanonicalTool {
  /** JCS string; this is what is stored as approved_definition / pending_definition. */
  canonical: string;
  /** lowercase hex SHA-256 of the UTF-8 bytes of `canonical`. */
  hash: string;
  /** UTF-8 byte length of `canonical`. */
  bytes: number;
  /** bytes > TOOL_CANONICALIZATION.maxCanonicalBytes */
  tooLarge: boolean;
}

export function canonicalizeToolDefinition(definition: ToolDefinition): CanonicalTool {
  const canonical = canonicalizeJcs(definition);
  if (typeof canonical !== 'string') throw new Error('tool definition is not canonicalisable');
  const bytes = Buffer.byteLength(canonical, 'utf8');
  return {
    canonical,
    hash: createHash('sha256').update(canonical, 'utf8').digest('hex'),
    bytes,
    tooLarge: bytes > TOOL_CANONICALIZATION.maxCanonicalBytes,
  };
}

/** sha256 of an already-canonical string (for verifying stored definitions). */
export function hashCanonical(canonical: string): string {
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/** D5: tool names in audit metadata and logs: control characters stripped, length-capped. */
export function sanitizeToolNameForLog(name: unknown): string {
  const s = typeof name === 'string' ? name : String(name);
  return s.replace(CONTROL_CHARS, '').slice(0, TOOL_NAME_LOG_MAX_LENGTH);
}
