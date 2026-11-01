/**
 * Log redaction (TD-026 / TD-028).
 *
 * pino `redact` removes secrets by key path; `redactSecretsInString` catches secrets that appear
 * inside free text (error messages, stack traces, MCP stderr); `serializeErr` makes sure an Error
 * never drags an HTTP client's request/response/config (headers, bodies) into a log line.
 */

const REDACTED = '[REDACTED]';

/** Credential-shaped substrings in free text. Order matters: specific prefixes before generic. */
export function redactSecretsInString(text: string): string {
  return (
    text
      // Ambassador credentials
      .replace(/amb_(?:pk|ak|st|rt)_[A-Za-z0-9_-]+/g, 'amb_***REDACTED***')
      // Third-party API keys / tokens
      .replace(/sk-[a-zA-Z0-9]{20,}/g, 'sk-***REDACTED***')
      .replace(/sk_[a-z]+_[a-zA-Z0-9]{20,}/g, 'sk_***REDACTED***')
      .replace(/ghp_[a-zA-Z0-9]{36,}/g, 'ghp_***REDACTED***')
      .replace(/github_pat_[a-zA-Z0-9_]{82}/g, 'github_pat_***REDACTED***')
      // JWT-shaped strings
      .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, 'jwt.***REDACTED***')
      // Bearer tokens
      .replace(/Bearer\s+[a-zA-Z0-9_\-.~+/]+=*/gi, 'Bearer ***REDACTED***')
      // Credential-bearing URL query params (OAuth code/state, tokens, keys)
      .replace(
        /([?&](?:code|state|token|access_token|refresh_token|id_token|code_verifier|client_secret|api_key|apikey|key|secret|password)=)[^&\s"'#]+/gi,
        '$1***REDACTED***'
      )
      // Generic key=value / "key": "value" pairs
      .replace(
        /(token|password|passwd|secret|apikey|api_key|authorization|cookie)(["']?)[\s]*[:=][\s]*["']?[^\s"',}&]+/gi,
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
