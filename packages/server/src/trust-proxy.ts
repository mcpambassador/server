/** MCP_AMBASSADOR_TRUST_PROXY: "true"/"false", a hop count ("1"), or a comma-separated IP/CIDR list. */
export function parseTrustProxyEnv(v: string | undefined): boolean | number | string[] | undefined {
  if (v === undefined || v.trim() === '') return undefined;
  const t = v.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  return t
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);
}
