/**
 * Credential -> environment mapping helpers (TD-048, TD-049).
 *
 * Pure and dependency-free so both the credential loader (server.ts) and the per-user pool can
 * use them and tests can exercise them directly.
 */

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Map a user's static credential values to env var names using the MCP's credential_schema.
 * The env name is the property's explicit `env_var`, else the property key itself (registry
 * entries name the property after the env var the MCP reads). Empty values are skipped.
 * Name validity (TD-039 denylist) is enforced at spawn time, not here.
 */
export function mapStaticCredentialEnv(
  schema: unknown,
  creds: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {};
  const props = isObj(schema) && isObj(schema['properties']) ? schema['properties'] : null;
  if (!props) return out;
  for (const [fieldName, fieldDef] of Object.entries(props)) {
    const explicit = isObj(fieldDef) ? fieldDef['env_var'] : undefined;
    const envVarName = typeof explicit === 'string' && explicit !== '' ? explicit : fieldName;
    // Own, string-valued entries only (no prototype keys, no objects/numbers)
    const value = Object.hasOwn(creds, fieldName) ? creds[fieldName] : undefined;
    if (typeof value === 'string' && value !== '') out[envVarName] = value;
  }
  return out;
}

/** A fixed value that is exactly `${NAME}` (whole string), returning NAME; else null. */
function slotName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = /^\$\{([A-Za-z0-9_]+)\}$/.exec(value);
  return m ? (m[1] as string) : null;
}

/**
 * Merge credential-derived env into an MCP's fixed config.env.
 *
 * TD-049 policy: FIXED ENV WINS. A credential whose name (case-insensitive) collides with a fixed
 * key is dropped, so a user credential can never override a registry/admin value such as
 * ALPACA_PAPER_TRADE='true'.
 *
 * Exception, the placeholder SLOT: a fixed value that is exactly `${NAME}` where NAME equals its own
 * key (case-insensitive), e.g. `{ BRAVE_API_KEY: '${BRAVE_API_KEY}' }`, means "the credential for
 * this name goes here". The credential for that name fills it, under the slot's key (TD-051). A slot for a different name
 * (`{ A: '${B}' }`) stays locked. A slot still unfilled after the merge is REMOVED so the child never
 * receives the literal `${X}` (HTTP transports then fail closed on the unresolved URL variable).
 *
 * Composite values (TD-050): a fixed value that EMBEDS `${NAME}` placeholders inside other text
 * (e.g. Notion's OPENAPI_MCP_HEADERS = '{"Authorization": "Bearer ${NOTION_API_KEY}", ...}') gets
 * each placeholder replaced by the user's credential for NAME, in ONE pass (a credential value is
 * never re-expanded). Rules, all fail-closed (the whole variable is removed and its KEY reported in
 * `rejected`, never a value):
 *  - the template comes from the entry's own fixed env, never from user input;
 *  - NAME must be one of the supplied credentials (callers build `credentialEnv` from the MCP's
 *    declared credential_schema properties), matched case-insensitively;
 *  - the credential value must match EMBED_VALUE_RE (an allowlist: API keys/tokens incl. base64), so
 *    it cannot break out of JSON/quoted text and rewrite sibling fields;
 *  - keys that look like URL/host/endpoint/proxy variables are never substituted (kept literal and
 *    locked, as before), so a credential can never choose where a request goes.
 * A whole-value `${NAME}` is the slot case above, not a composite.
 *
 * Returns the dropped NAMES (collisions) and rejected KEYS (composite failures), never values.
 */
const PLACEHOLDER_RE = /\$\{([A-Za-z0-9_]+)\}/g;
/** Allowlist for a credential value embedded inside other text. */
const EMBED_VALUE_RE = /^[A-Za-z0-9._~+/=:-]{1,4096}$/;
const URL_LIKE_KEY_RE = /(URL|URI|HOST|ENDPOINT|PROXY)/i;

export function mergeCredentialEnv(
  fixedEnv: Record<string, string> | undefined,
  credentialEnv: Record<string, string>
): { env: Record<string, string>; dropped: string[]; rejected: string[] } {
  const fixed = fixedEnv ?? {};
  const credByLower = new Map<string, string>();
  for (const [n, v] of Object.entries(credentialEnv)) credByLower.set(n.toLowerCase(), v);
  const rejected: string[] = [];
  const env: Record<string, string> = {};
  const slots = new Map<string, string>(); // lowercase name -> fixed key holding the slot
  const lockedLower = new Set<string>();
  for (const [key, value] of Object.entries(fixed)) {
    const slot = slotName(value);
    if (slot !== null && slot.toLowerCase() === key.toLowerCase()) {
      slots.set(key.toLowerCase(), key);
    } else {
      lockedLower.add(key.toLowerCase());
      const embedded =
        slot === null && typeof value === 'string' && !URL_LIKE_KEY_RE.test(key)
          ? [...value.matchAll(PLACEHOLDER_RE)]
          : [];
      if (embedded.length === 0) {
        env[key] = value;
        continue;
      }
      let ok = true;
      const filled = value.replace(PLACEHOLDER_RE, (_m, name: string) => {
        const cred = credByLower.get(name.toLowerCase());
        if (cred === undefined || !EMBED_VALUE_RE.test(cred)) {
          ok = false;
          return '';
        }
        return cred;
      });
      if (ok) env[key] = filled;
      else rejected.push(key);
    }
  }
  const dropped: string[] = [];
  for (const [name, value] of Object.entries(credentialEnv)) {
    const lower = name.toLowerCase();
    if (lockedLower.has(lower)) {
      dropped.push(name);
      continue;
    }
    const slotKey = slots.get(lower);
    if (slotKey !== undefined) {
      slots.delete(lower); // filled
      env[slotKey] = value; // TD-051: the slot's key wins, so the child sees the name the entry expects
    } else {
      env[name] = value;
    }
  }
  // Unfilled slots are not copied into env at all (removed).
  return { env, dropped, rejected };
}
