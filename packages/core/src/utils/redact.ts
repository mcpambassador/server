/**
 * Log redaction (TD-026 / TD-028).
 *
 * pino `redact` removes secrets by key path; `redactSecretsInString` catches secrets that appear
 * inside free text (error messages, stack traces, MCP stderr); `serializeErr` makes sure an Error
 * never drags an HTTP client's request/response/config (headers, bodies) into a log line.
 */

const REDACTED = '[REDACTED]';

const MIN_EXACT_LEN = 8;

/**
 * Credential-shaped substrings in free text. Order matters: exact values and specific prefixes
 * before generic rules.
 *
 * `exactValues` are known secrets (for example a stdio MCP's config.env values, which can be a
 * user's decrypted vault credentials). Values shorter than 8 chars are ignored to avoid mangling
 * ordinary text. They are replaced before any pattern runs, so they are caught even when they do
 * not look like a credential.
 */
export function redactSecretsInString(text: string, exactValues?: readonly string[]): string {
  let out = text;
  if (exactValues && exactValues.length > 0) {
    const vals = [...new Set(exactValues)]
      .filter(v => v.length >= MIN_EXACT_LEN)
      .sort((x, y) => y.length - x.length);
    for (const v of vals) out = out.split(v).join(REDACTED);
  }
  return (
    out
      // PEM private key blocks (to the END line, or to the end of text if truncated)
      .replace(
        /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
        '***REDACTED PRIVATE KEY***'
      )
      // Ambassador credentials (amb_pk_, amb_ak_, amb_st_, amb_rt_, amb_at_, amb_ac_, ...)
      .replace(/amb_[a-z]{2}_[A-Za-z0-9_-]{16,}/g, 'amb_***REDACTED***')
      // Third-party API keys / tokens
      .replace(/sk-[a-zA-Z0-9]{20,}/g, 'sk-***REDACTED***')
      .replace(/sk_[a-z]+_[a-zA-Z0-9]{20,}/g, 'sk_***REDACTED***')
      .replace(/ghp_[a-zA-Z0-9]{36,}/g, 'ghp_***REDACTED***')
      .replace(/github_pat_[a-zA-Z0-9_]{82}/g, 'github_pat_***REDACTED***')
      // JWT-shaped strings
      .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, 'jwt.***REDACTED***')
      // Userinfo in URLs: scheme://user:pass@host
      .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]*:[^\s/?#@]*@/gi, '$1***:***@')
      // Authorization header/value: whatever the scheme (Basic, Digest, Bearer, ...), to end of line
      .replace(/(authorization["']?\s*[:=]\s*)[^\r\n]*/gi, '$1***REDACTED***')
      // Cookie / Set-Cookie: the whole header value to end of line
      .replace(/((?:set-)?cookie["']?\s*[:=]\s*)[^\r\n]*/gi, '$1***REDACTED***')
      // Bearer / Basic tokens outside a header
      .replace(/Bearer\s+[a-zA-Z0-9_\-.~+/]+=*/gi, 'Bearer ***REDACTED***')
      .replace(/\bBasic\s+[A-Za-z0-9+/]{8,}=*/g, 'Basic ***REDACTED***')
      // Credential-bearing URL query params (OAuth code/state, tokens, keys)
      .replace(
        /([?&](?:code|state|token|access_token|refresh_token|id_token|code_verifier|client_secret|api_key|apikey|key|secret|password|sessionid|session_id|_csrf|csrf)=)[^&\s"'#]+/gi,
        '$1***REDACTED***'
      )
      // Generic key=value / "key": "value" pairs
      .replace(
        /(token|password|passwd|secret|apikey|api_key|sessionid|session_id|_csrf|csrf)(["']?)[\s]*[:=][\s]*["']?[^\s"',}&]+/gi,
        '$1$2=***REDACTED***'
      )
  );
}

const MAX_CAUSE_DEPTH = 3;

interface SerializedErr {
  type: string;
  message: string;
  stack?: string;
  code?: string | number;
  cause?: SerializedErr;
}

function serializeOne(err: unknown, depth: number): SerializedErr {
  if (err === null || typeof err !== 'object') {
    return { type: typeof err, message: redactSecretsInString(String(err)) };
  }
  const e = err as Error & { code?: unknown; cause?: unknown };
  const out: SerializedErr = {
    type: e.name || e.constructor?.name || 'Error',
    message: redactSecretsInString(typeof e.message === 'string' ? e.message : String(e)),
  };
  if (typeof e.stack === 'string') out.stack = redactSecretsInString(e.stack);
  if (typeof e.code === 'string' || typeof e.code === 'number') out.code = e.code;
  if (e.cause !== undefined && depth < MAX_CAUSE_DEPTH) {
    out.cause = serializeOne(e.cause, depth + 1);
  }
  return out;
}

/**
 * pino `err` serializer: keeps name/message/code/stack (and a redacted `cause` chain), and drops
 * everything else, so HTTP-client errors cannot leak response/config/request/body/headers.
 */
export function serializeErr(err: unknown): SerializedErr {
  return serializeOne(err, 0);
}

/**
 * pino redact paths (key-based). pino matches `*.x` one level deep, so each secret key is listed
 * at the top level, one level deep, and under `req.headers` / `headers`.
 */
const SECRET_KEYS = [
  'password',
  'token',
  'secret',
  'client_secret',
  'preshared_key',
  'access_token',
  'refresh_token',
  'id_token',
  'code_verifier',
];
const SECRET_HEADERS = ['authorization', 'cookie', 'set-cookie', 'x-admin-key', 'x-session-token'];

export const REDACT_PATHS: string[] = [
  ...SECRET_HEADERS.flatMap(h => [`["${h}"]`, `*["${h}"]`, `*.headers["${h}"]`]),
  ...SECRET_KEYS.flatMap(k => [k, `*.${k}`]),
];

export const REDACT_CENSOR = REDACTED;
