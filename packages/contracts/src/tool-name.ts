/**
 * Tool names as used by policy surfaces (tool kill switch, ADR-025 group tool grants).
 *
 * Names are compared byte-exact: no trim, case folding or unicode normalisation. Validation is
 * deliberately NOT the narrower downstream-discovery pattern: a deny rule must be able to name any tool
 * a downstream MCP can publish, otherwise deny mode would fail open for an oddly named tool.
 * Rejected: empty, longer than 128 code points, control characters (incl. NUL), bidi controls,
 * zero-width characters, and unpaired surrogates (a name that cannot be shown or logged safely).
 */
export const POLICY_TOOL_NAME_MAX = 128;

const FORBIDDEN =
  // C0/C1 controls, zero-width (200B-200D, 2060, FEFF), bidi marks/embeddings/isolates (200E-200F, 202A-202E, 2066-2069)
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/;
const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function isValidPolicyToolName(name: unknown): name is string {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (name.length > POLICY_TOOL_NAME_MAX * 2) return false; // cheap bound before the code-point count
  if (Array.from(name).length > POLICY_TOOL_NAME_MAX) return false;
  return !FORBIDDEN.test(name) && !UNPAIRED_SURROGATE.test(name);
}
