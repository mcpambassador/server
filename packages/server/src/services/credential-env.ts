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
    const value = creds[fieldName];
    if (value) out[envVarName] = value;
  }
  return out;
}

/**
 * Merge credential-derived env into an MCP's fixed config.env. TD-049 policy: FIXED ENV WINS.
 * A credential whose name (case-insensitive) collides with a fixed key is dropped, so a user
 * credential can never override an admin/registry-set value such as ALPACA_PAPER_TRADE.
 * Returns the dropped NAMES only (never values) so the caller can log a warning.
 */
export function mergeCredentialEnv(
  fixedEnv: Record<string, string> | undefined,
  credentialEnv: Record<string, string>
): { env: Record<string, string>; dropped: string[] } {
  const fixed = fixedEnv ?? {};
  const fixedLower = new Set(Object.keys(fixed).map(k => k.toLowerCase()));
  const env: Record<string, string> = { ...fixed };
  const dropped: string[] = [];
  for (const [name, value] of Object.entries(credentialEnv)) {
    if (fixedLower.has(name.toLowerCase())) dropped.push(name);
    else env[name] = value;
  }
  return { env, dropped };
}
