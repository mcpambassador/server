/**
 * S1 follow-up: JSON Schema `pattern` / `patternProperties` run on RE2 (linear time). A pattern RE2 cannot
 * compile (lookaround, backreferences) is not enforced; the REST of the schema still is. Such schemas are
 * flagged `pattern_unsupported` at observe time so an admin sees it (and the baseline refuses them).
 */
import RE2 from 're2';

const MAX_DEPTH = 32;
/** Subtrees that hold data, not schema keywords. */
const DATA_KEYS = new Set(['const', 'enum', 'default', 'examples']);

export function isRe2Compilable(pattern: string): boolean {
  try {
    new RE2(pattern, 'u');
    return true;
  } catch {
    return false;
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** True if any schema keyword pattern is not RE2-compilable. */
export function hasUnsupportedPattern(schema: unknown): boolean {
  const walk = (v: unknown, depth: number): boolean => {
    if (depth > MAX_DEPTH) return false;
    if (Array.isArray(v)) return v.some(x => walk(x, depth + 1));
    if (!isObj(v)) return false;
    if (typeof v.pattern === 'string' && !isRe2Compilable(v.pattern)) return true;
    if (isObj(v.patternProperties)) {
      for (const k of Object.keys(v.patternProperties)) if (!isRe2Compilable(k)) return true;
    }
    return Object.entries(v).some(([k, x]) => !DATA_KEYS.has(k) && walk(x, depth + 1));
  };
  return walk(schema, 0);
}

/** A copy of the schema without the uncompilable pattern keywords (everything else is kept). */
export function stripUnsupportedPatterns<T>(schema: T): T {
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > MAX_DEPTH) return v;
    if (Array.isArray(v)) return v.map(x => walk(x, depth + 1));
    if (!isObj(v)) return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === 'pattern' && typeof x === 'string' && !isRe2Compilable(x)) continue;
      if (k === 'patternProperties' && isObj(x)) {
        const kept: Record<string, unknown> = {};
        for (const [pk, pv] of Object.entries(x))
          if (isRe2Compilable(pk)) kept[pk] = walk(pv, depth + 1);
        out[k] = kept;
        continue;
      }
      out[k] = DATA_KEYS.has(k) ? x : walk(x, depth + 1);
    }
    return out;
  };
  return walk(schema, 0) as T;
}
