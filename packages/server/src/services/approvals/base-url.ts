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
