/**
 * Test-only: no test may reach the real community registry on GitHub. Server init fetches it, and
 * unauthenticated CI/dev IPs hit "HTTP 403: rate limit exceeded", which flaked unrelated tests.
 * Registry requests get an immediate 503 (the server already tolerates an unavailable registry);
 * every other request, including loopback, goes through. Tests that stub fetch themselves override this.
 */
const realFetch = globalThis.fetch;

globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
  if (/api\.github\.com\/repos\/mcpambassador\/community-registry\//.test(url)) {
    return Promise.resolve(
      new Response('registry disabled in tests', { status: 503, statusText: 'Service Unavailable' })
    );
  }
  return realFetch(input, init);
}) as typeof fetch;
