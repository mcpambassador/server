/**
 * MCP_AMBASSADOR_TRUST_PROXY: "true"/"false" or a comma-separated IP/CIDR list.
 * A bare hop count ("1") is rejected: Fastify >= 5.12 disables hop-count-only trust because it
 * cannot validate the immediate peer and lets direct clients spoof X-Forwarded-*.
 */
export function parseTrustProxyEnv(v: string | undefined): boolean | string[] | undefined {
  if (v === undefined || v.trim() === '') return undefined;
  const t = v.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^\d+$/.test(t)) {
    throw new Error(
      'MCP_AMBASSADOR_TRUST_PROXY: hop counts are not supported; use true, false, or an IP/CIDR list'
    );
  }
  return t
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);
}
