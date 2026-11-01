/**
 * ADR-021 \u00a77: injection-marker heuristics. FLAG ONLY: never blocks, approves or rejects by itself.
 * Blocking flags (`reserved_name`, `invalid_definition`) are structural, not heuristic, and are
 * assigned by the pin service, not here.
 */
import {
  TOOL_PIN_FLAG_RULES_VERSION,
  TOOL_PIN_RESERVED_NAME_PREFIX,
  TOOL_SERVE_DESCRIPTION_MAX_CODE_POINTS,
  type ToolDefinition,
  type ToolPinFlagCode,
  type ToolPinFlags,
} from '@mcpambassador/contracts';

import { hasUnsupportedPattern } from './schema-patterns.js';

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
// ReDoS-safe (B1): no nested/ambiguous quantifiers. A path-ish token AND a sensitive suffix are two
// independent linear checks instead of one backtracking pattern.
const PATH_TOKEN = /(?:^|[\s"'`(=:])(?:~|\.{1,2})?\/[\w.-]+\//;
const SENSITIVE_SUFFIX = /(?:\.ssh|\.env|id_rsa|passwd|credentials|\.aws|\.config)(?![\w])/i;
const OTHER_TOOL_OR_FILE: RegExp[] = [
  /\b(?:\.ssh|\.env|id_rsa|\/etc\/passwd|credentials\.json)\b/i,
  /\b(?:use|call|invoke)\s+the\s+[\w-]+\s+tool\b/i,
];
/** Heavy (phrase/blob/markup) regexes only ever see this many leading UTF-16 units of any one text. */
export const MAX_SCAN_CHARS = 8 * 1024;
const MAX_SCAN_TEXTS = 2000;
const MAX_WALK_DEPTH = 12;
// zero-width + invisible formatting
const HIDDEN_UNICODE = /[\u200b-\u200f\u2060-\u2064\ufeff\u00ad\u180e]/;
// bidi controls
const BIDI_UNICODE = /[\u202a-\u202e\u2066-\u2069]/;
const BASE64_BLOB = /[A-Za-z0-9+/]{80,}={0,2}/;
const MARKUP = /<\s*\/?\s*(important|system|instructions?|script|img|iframe)\b|<!--/i;

/**
 * B3: every string key AND value reachable from inputSchema, outputSchema and annotations (property
 * names, enum, default, examples, const, ...), plus title/description. Bounded by depth and count.
 */
function collectTexts(def: ToolDefinition): string[] {
  const out: string[] = [];
  const push = (t: string): void => {
    if (out.length < MAX_SCAN_TEXTS) out.push(t);
  };
  if (def.title) push(def.title);
  if (def.description) push(def.description);
  const walk = (v: unknown, depth: number): void => {
    if (out.length >= MAX_SCAN_TEXTS || depth > MAX_WALK_DEPTH) return;
    if (typeof v === 'string') return push(v);
    if (v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      push(k);
      walk(x, depth + 1);
    }
  };
  walk(def.inputSchema, 0);
  walk(def.outputSchema, 0);
  walk(def.annotations, 0);
  return out;
}

function pathReference(t: string): boolean {
  return PATH_TOKEN.test(t) && SENSITIVE_SUFFIX.test(t);
}

export function scanToolDefinition(def: ToolDefinition): ToolPinFlags {
  const codes = new Set<ToolPinFlagCode>();
  const texts = collectTexts(def);
  for (const full of texts) {
    // Cheap linear checks on the full text; backtracking-capable ones on the capped prefix only.
    if (HIDDEN_UNICODE.test(full)) codes.add('hidden_unicode');
    if (BIDI_UNICODE.test(full)) codes.add('bidi_unicode');
    if (full.length > LONG_DESCRIPTION_CHARS) codes.add('long_description');
    const t = full.length > MAX_SCAN_CHARS ? full.slice(0, MAX_SCAN_CHARS) : full;
    if (INSTRUCTION_PHRASES.some(r => r.test(t))) codes.add('instruction_phrase');
    if (OTHER_TOOL_OR_FILE.some(r => r.test(t)) || pathReference(t))
      codes.add('references_other_tool_or_file');
    if (BASE64_BLOB.test(t)) codes.add('base64_blob');
    if (MARKUP.test(t)) codes.add('markup');
  }
  if (hasUnsupportedPattern(def.inputSchema)) codes.add('pattern_unsupported');
  // SEC-M9-05: agents only see the first N code points of the description.
  if (
    def.description &&
    def.description.length > TOOL_SERVE_DESCRIPTION_MAX_CODE_POINTS &&
    Array.from(def.description).length > TOOL_SERVE_DESCRIPTION_MAX_CODE_POINTS
  )
    codes.add('truncated_on_serve');
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

/** T: the description an agent is served (SEC-M9-05). Hash and admin review cover the full text. */
export function truncateDescriptionForServe(description: string): string {
  if (description.length <= TOOL_SERVE_DESCRIPTION_MAX_CODE_POINTS) return description;
  const cps = Array.from(description);
  return cps.length <= TOOL_SERVE_DESCRIPTION_MAX_CODE_POINTS
    ? description
    : cps.slice(0, TOOL_SERVE_DESCRIPTION_MAX_CODE_POINTS).join('');
}
