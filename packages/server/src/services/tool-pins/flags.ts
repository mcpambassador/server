/**
 * ADR-021 \u00a77: injection-marker heuristics. FLAG ONLY: never blocks, approves or rejects by itself.
 * Blocking flags (`reserved_name`, `invalid_definition`) are structural, not heuristic, and are
 * assigned by the pin service, not here.
 */
import {
  TOOL_PIN_FLAG_RULES_VERSION,
  TOOL_PIN_RESERVED_NAME_PREFIX,
  type ToolDefinition,
  type ToolPinFlagCode,
  type ToolPinFlags,
} from '@mcpambassador/contracts';

const LONG_DESCRIPTION_CHARS = 2000;

const INSTRUCTION_PHRASES: RegExp[] = [
  /ignore\s+(all\s+)?(the\s+)?(previous|prior|above)/i,
  /disregard\s+(all\s+)?(the\s+)?(previous|prior|above)/i,
  /do\s+not\s+(tell|inform|mention|reveal|show)\s+(this\s+to\s+)?the\s+user/i,
  /don'?t\s+(tell|inform|mention|reveal)\s+(this\s+to\s+)?the\s+user/i,
  /\b(always|must|first)\s+(call|use|invoke|run)\b/i,
  /before\s+(using|calling)\s+(this|any|other)\s+tool/i,
  /system\s+prompt/i,
  /you\s+(must|should)\s+(not\s+)?(send|forward|include|read|exfiltrate)/i,
];
const OTHER_TOOL_OR_FILE: RegExp[] = [
  /(?:~|\.\.?)?\/[\w.-]+\/[\w./-]*(?:\.ssh|\.env|id_rsa|passwd|credentials|\.aws|\.config)\b/i,
  /\b(?:\.ssh|\.env|id_rsa|\/etc\/passwd|credentials\.json)\b/i,
  /\b(?:use|call|invoke)\s+the\s+[\w-]+\s+tool\b/i,
];
// zero-width + invisible formatting
const HIDDEN_UNICODE = /[\u200b-\u200f\u2060-\u2064\ufeff\u00ad\u180e]/;
// bidi controls
const BIDI_UNICODE = /[\u202a-\u202e\u2066-\u2069]/;
const BASE64_BLOB = /[A-Za-z0-9+/]{80,}={0,2}/;
const MARKUP = /<\s*\/?\s*(important|system|instructions?|script|img|iframe)\b|<!--/i;

/** Collect description strings: the tool description plus nested schema `description`/`title` strings. */
function collectTexts(def: ToolDefinition): string[] {
  const out: string[] = [];
  if (def.title) out.push(def.title);
  if (def.description) out.push(def.description);
  const walk = (v: unknown, depth: number): void => {
    if (depth > 12 || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if ((k === 'description' || k === 'title') && typeof x === 'string') out.push(x);
      else walk(x, depth + 1);
    }
  };
  walk(def.inputSchema, 0);
  walk(def.outputSchema, 0);
  return out;
}

export function scanToolDefinition(def: ToolDefinition): ToolPinFlags {
  const codes = new Set<ToolPinFlagCode>();
  const texts = collectTexts(def);
  for (const t of texts) {
    if (INSTRUCTION_PHRASES.some(r => r.test(t))) codes.add('instruction_phrase');
    if (OTHER_TOOL_OR_FILE.some(r => r.test(t))) codes.add('references_other_tool_or_file');
    if (HIDDEN_UNICODE.test(t)) codes.add('hidden_unicode');
    if (BIDI_UNICODE.test(t)) codes.add('bidi_unicode');
    if (t.length > LONG_DESCRIPTION_CHARS) codes.add('long_description');
    if (BASE64_BLOB.test(t)) codes.add('base64_blob');
    if (MARKUP.test(t)) codes.add('markup');
  }
  // Names and icon fields can also carry invisible characters.
  const meta = [def.name, ...(def.icons ?? []).map(i => JSON.stringify(i))];
  for (const t of meta) {
    if (HIDDEN_UNICODE.test(t)) codes.add('hidden_unicode');
    if (BIDI_UNICODE.test(t)) codes.add('bidi_unicode');
  }
  return { rules_version: TOOL_PIN_FLAG_RULES_VERSION, codes: [...codes].sort() };
}

export function hasReservedName(name: string): boolean {
  return name.startsWith(TOOL_PIN_RESERVED_NAME_PREFIX);
}
