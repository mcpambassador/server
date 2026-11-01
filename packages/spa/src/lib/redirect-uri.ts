/**
 * Client-side mirror of `redirectUriSchema` / `isAllowedRedirectUri` from @mcpambassador/contracts
 * (ADR-020 §5b). Kept local so the zod runtime stays out of the bundle; a test checks both agree.
 * Allowed: https, or http on a loopback host (127.0.0.1, [::1], localhost; any port).
 * Rejected: fragments, userinfo, other schemes, values over 2048 chars.
 */
export const MAX_REDIRECT_URIS = 10;

export function isAllowedRedirectUri(value: string): boolean {
  if (value.length > 2048) return false;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  if (u.hash || value.includes('#')) return false;
  if (u.username || u.password) return false;
  if (u.protocol === 'https:') return true;
  if (u.protocol === 'http:') {
    return u.hostname === '127.0.0.1' || u.hostname === '[::1]' || u.hostname === 'localhost';
  }
  return false;
}

/** Split a textarea into trimmed, de-duplicated, non-empty lines. */
export function parseRedirectUris(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(Boolean)
    ),
  ];
}

/** Returns an error message, or null when the list is valid. */
export function validateRedirectUris(uris: string[]): string | null {
  if (uris.length === 0) return 'Enter at least one redirect URI.';
  if (uris.length > MAX_REDIRECT_URIS) return `At most ${MAX_REDIRECT_URIS} redirect URIs.`;
  const bad = uris.find(u => !isAllowedRedirectUri(u));
  return bad
    ? `Not allowed: ${bad} — use https, or http on localhost, 127.0.0.1 or [::1]; no fragment or credentials.`
    : null;
}

/** Port when the URI is exactly http://localhost:<port>/callback, else null. */
export function claudeCodeCallbackPort(uri: string): string | null {
  const m = /^http:\/\/localhost:(\d{1,5})\/callback$/.exec(uri);
  return m && Number(m[1]) >= 1 && Number(m[1]) <= 65535 ? m[1]! : null;
}

export function claudeCodeCommand(port: string, host: string): string {
  return `claude mcp add --transport http --callback-port ${port} ambassador https://${host}:8443/mcp`;
}
