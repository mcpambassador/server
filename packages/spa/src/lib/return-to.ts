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
