/**
 * ADR-023: approval links come from config (PUBLIC_URL), never from the request Host header.
 * An empty or whitespace publicUrl counts as unset (docker compose passes `PUBLIC_URL: ${PUBLIC_URL:-}`).
 */
export function resolveApprovalUiBaseUrl(
  publicUrl: string | undefined,
  serverName: string | undefined,
  adminPort: number | string
): string {
  return (publicUrl?.trim() || `https://${serverName || 'localhost'}:${adminPort}`).replace(
    /\/+$/,
    ''
  );
}

/**
 * ADR-020: OAuth issuer and /mcp base URL, from config/PUBLIC_URL, never the request Host.
 * Empty or whitespace values count as unset, so a compose-empty PUBLIC_URL cannot yield `issuer: ""`.
 */
export function resolveAgentPublicUrls(opts: {
  issuerUrl?: string;
  resourceBaseUrl?: string;
  publicUrl?: string;
  serverName?: string;
  adminPort: number | string;
  port: number | string;
}): { issuer: string; agentBaseUrl: string } {
  const strip = (u: string): string => u.replace(/\/+$/, '');
  const name = opts.serverName || 'localhost';
  return {
    issuer: strip(
      opts.issuerUrl?.trim() || opts.publicUrl?.trim() || `https://${name}:${opts.adminPort}`
    ),
    agentBaseUrl: strip(opts.resourceBaseUrl?.trim() || `https://${name}:${opts.port}`),
  };
}
