/**
 * Request-log serializer that never records query strings (they can carry tokens, e.g. a misdirected
 * ?access_token=… or OAuth `code`/`state`). Path only; the rest mirrors Fastify's default req shape.
 */
export function redactQueryUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  const q = url.indexOf('?');
  return q === -1 ? url : `${url.slice(0, q)}?[redacted]`;
}

export const requestLogSerializers = {
  req(request: {
    method?: string;
    url?: string;
    hostname?: string;
    ip?: string;
    socket?: { remotePort?: number };
  }) {
    return {
      method: request.method,
      url: redactQueryUrl(request.url),
      host: request.hostname,
      remoteAddress: request.ip,
      remotePort: request.socket?.remotePort,
    };
  },
};
