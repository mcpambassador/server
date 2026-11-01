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
 * this name goes here". The credential for that name fills it. A slot for a different name
 * (`{ A: '${B}' }`) stays locked. A slot still unfilled after the merge is REMOVED so the child never
 * receives the literal `${X}` (HTTP transports then fail closed on the unresolved URL variable).
 *
 * TODO(TD-050): no substitution INSIDE other values (e.g. Notion's OPENAPI_MCP_HEADERS embeds
 * `${NOTION_API_KEY}`); such values are treated as literals and stay locked.
 *
 * Returns the dropped NAMES only (never values) so the caller can log a warning.
 */
export function mergeCredentialEnv(
  fixedEnv: Record<string, string> | undefined,
  credentialEnv: Record<string, string>
): { env: Record<string, string>; dropped: string[] } {
  const fixed = fixedEnv ?? {};
  const env: Record<string, string> = {};
  const slots = new Map<string, string>(); // lowercase name -> fixed key holding the slot
  const lockedLower = new Set<string>();
  for (const [key, value] of Object.entries(fixed)) {
    const slot = slotName(value);
    if (slot !== null && slot.toLowerCase() === key.toLowerCase()) {
      slots.set(key.toLowerCase(), key);
    } else {
      env[key] = value;
      lockedLower.add(key.toLowerCase());
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
      slots.delete(lower); // filled; the credential's own name is used
    }
    env[name] = value;
  }
  // Unfilled slots are not copied into env at all (removed).
  return { env, dropped };
}
