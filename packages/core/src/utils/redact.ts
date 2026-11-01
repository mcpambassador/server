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
      // Userinfo with no password: a long token used as the user (https://<token>@host)
      .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@:]{16,}@/gi, '$1***@')
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

const PEM_BEGIN_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/;
const PEM_END_RE = /-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/;
const PEM_MARKER = '***REDACTED PRIVATE KEY***';

/**
 * Stateful, per-connection scrubber for a text stream arriving in arbitrary chunks (MCP stderr).
 * A chunk boundary can split a secret, so output is line-buffered: complete lines are scrubbed
 * and returned, the trailing partial line waits for more data. The buffer is flushed (scrubbed)
 * when it exceeds `maxBuffer`: the line is emitted scrubbed with a " …[line truncated]" suffix and
 * the rest of that line is dropped up to the next newline (no overlap, nothing unscrubbed kept).
 * `flush()` scrubs what is left (call at stream end/close).
 * A PEM private key spanning lines is redacted until its END marker.
 * Callers should read the stream as utf8 text (`setEncoding('utf8')`) so multibyte characters are
 * not split across chunks.
 */
export class StreamRedactor {
  private buf = '';
  private inPem = false;
  private discarding = false;

  constructor(
    private readonly exactValues: readonly string[] = [],
    private readonly maxBuffer = 8192
  ) {}

  /** Feed a chunk; returns the scrubbed lines (no trailing newlines). */
  push(chunk: string): string[] {
    const out: string[] = [];
    let rest = chunk;
    while (rest.length > 0) {
      const nl = rest.indexOf('\n');
      if (this.discarding) {
        if (nl < 0) return out;
        this.discarding = false;
        rest = rest.slice(nl + 1);
        continue;
      }
      const seg = nl < 0 ? rest : rest.slice(0, nl);
      if (this.buf.length + seg.length > this.maxBuffer) {
        out.push(this.truncated(this.buf + seg));
        this.buf = '';
        this.discarding = nl < 0;
      } else if (nl < 0) {
        this.buf += seg;
        return out;
      } else {
        out.push(this.line(this.buf + seg));
        this.buf = '';
      }
      rest = nl < 0 ? '' : rest.slice(nl + 1);
    }
    return out;
  }

  /** Scrub and return whatever partial line is left (call when the stream ends). */
  flush(): string[] {
    this.discarding = false;
    if (this.buf.length === 0) return [];
    const l = this.line(this.buf);
    this.buf = '';
    return [l];
  }

  /** Cut an over-long line at the cap, backing off to a word boundary so no token is half-kept */
  private truncated(raw: string): string {
    let cut = raw.slice(0, this.maxBuffer);
    const back = cut.slice(-128).search(/\s\S*$/);
    if (back >= 0 && cut.length > 128) cut = cut.slice(0, cut.length - 128 + back);
    return this.line(cut) + ' …[line truncated]';
  }

  private line(raw: string): string {
    const l = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (this.inPem) {
      if (PEM_END_RE.test(l)) this.inPem = false;
      return PEM_MARKER;
    }
    if (PEM_BEGIN_RE.test(l) && !PEM_END_RE.test(l)) {
      this.inPem = true;
      return PEM_MARKER;
    }
    return redactSecretsInString(l, this.exactValues);
  }
}

const MAX_CAUSE_DEPTH = 3;

interface SerializedErr {
  type: string;
  message: string;
  stack?: string;
  code?: string | number;
  cause?: SerializedErr;
}

/**
 * drizzle-orm >=0.44 wraps driver errors in DrizzleQueryError, whose message is
 * "Failed query: <SQL>\nparams: <every bound value>" (hashes, blobs, emails, tokens). The driver's
 * original error is in `.cause`.
 */
export function isDbQueryError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const e = err as { name?: unknown; message?: unknown; query?: unknown; params?: unknown };
  return (
    e.name === 'DrizzleQueryError' ||
    (typeof e.message === 'string' && e.message.startsWith('Failed query:')) ||
    (typeof e.query === 'string' && 'params' in e)
  );
}

/**
 * Message safe to hand to agents, HTTP clients and persistent audit metadata: a generic string for
 * database errors (their message embeds bound parameter values), `err.message` otherwise.
 */
export function publicErrorMessage(err: unknown): string {
  if (isDbQueryError(err)) return 'Database error';
  return err instanceof Error ? err.message : String(err);
}

/** SQL text of a DB query error without params (message is "Failed query: <SQL>\nparams: ..."). */
function queryErrorSql(err: { message?: unknown; query?: unknown }): string {
  if (typeof err.query === 'string') return redactSecretsInString(err.query);
  const msg = typeof err.message === 'string' ? err.message : '';
  return redactSecretsInString(msg.replace(/^Failed query:\s*/, '').split(/\nparams:/)[0] ?? '');
}

function serializeOne(err: unknown, depth: number): SerializedErr {
  if (err === null || typeof err !== 'object') {
    return { type: typeof err, message: redactSecretsInString(String(err)) };
  }
  const e = err as Error & { code?: unknown; cause?: unknown };
  const dbErr = isDbQueryError(err);
  const out: SerializedErr = {
    type: e.name || e.constructor?.name || 'Error',
    // DB query errors: SQL only, bound params are dropped
    message: dbErr
      ? `Failed query: ${queryErrorSql(e as { message?: unknown; query?: unknown })}`
      : redactSecretsInString(typeof e.message === 'string' ? e.message : String(e)),
  };
  // the stack's first line repeats the message (with params), so drop it for DB errors
  if (typeof e.stack === 'string') {
    out.stack = redactSecretsInString(
      dbErr
        ? e.stack
            .split('\n')
            .filter(l => /^\s+at /.test(l))
            .join('\n')
        : e.stack
    );
  }
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
