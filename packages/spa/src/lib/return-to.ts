/** Where to go after login: the protected page that sent us here, if it is an in-app path. */
export function returnToPath(state: unknown): string {
  const from = (state as { from?: { pathname?: string; search?: string; hash?: string } } | null)
    ?.from;
  const pathname = from?.pathname;
  if (typeof pathname === 'string' && /^\/app(\/|$)/.test(pathname) && !pathname.startsWith('//')) {
    return `${pathname}${from?.search ?? ''}${from?.hash ?? ''}`;
  }
  return '/app/dashboard';
}

/**
 * Defense in depth before navigating to an OAuth redirect_url: only https:, or http: on a
 * loopback host (native/CLI agents). Returns the parsed URL, or null if it must not be followed.
 */
export function safeRedirectUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) {
    return url;
  }
  return null;
}
