import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { AmbassadorConfigSchema } from '@mcpambassador/core';
import { parseTrustProxyEnv } from '../src/trust-proxy.js';

describe('S3 trust_proxy', () => {
  it('env parser: unset/bool/hops/list', () => {
    expect(parseTrustProxyEnv(undefined)).toBeUndefined();
    expect(parseTrustProxyEnv('')).toBeUndefined();
    expect(parseTrustProxyEnv('false')).toBe(false);
    expect(parseTrustProxyEnv('true')).toBe(true);
    expect(parseTrustProxyEnv('1')).toBe(1);
    expect(parseTrustProxyEnv('100.64.0.0/10, 127.0.0.1')).toEqual(['100.64.0.0/10', '127.0.0.1']);
  });

  it('config schema: defaults to false, accepts hops and CIDR lists', () => {
    const base = (server: unknown): unknown => AmbassadorConfigSchema.safeParse({ server }).success;
    const parse = (v?: unknown): any => {
      const r = (AmbassadorConfigSchema as any).shape.server.safeParse(
        v === undefined ? {} : { trust_proxy: v }
      );
      return r;
    };
    expect(base({})).toBeDefined();
    expect(parse().data.trust_proxy).toBe(false);
    expect(parse(1).data.trust_proxy).toBe(1);
    expect(parse(['100.64.0.0/10']).data.trust_proxy).toEqual(['100.64.0.0/10']);
    expect(parse(0).success).toBe(false);
  });

  it('fastify semantics we rely on: false ignores XFF, a hop count believes it', async () => {
    for (const [tp, expected] of [
      [false, '10.0.0.5'],
      [1, '1.2.3.4'],
    ] as const) {
      const app = Fastify({ trustProxy: tp });
      app.get('/ip', async req => ({ ip: req.ip }));
      const r = await app.inject({
        method: 'GET',
        url: '/ip',
        remoteAddress: '10.0.0.5',
        headers: { 'x-forwarded-for': '1.2.3.4' },
      });
      expect(r.json().ip).toBe(expected);
      await app.close();
    }
  });
});
