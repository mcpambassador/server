import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { AmbassadorConfigSchema } from '@mcpambassador/core';
import { parseTrustProxyEnv } from '../src/trust-proxy.js';

describe('S3 trust_proxy', () => {
  it('env parser: unset/bool/list, hop counts throw', () => {
    expect(parseTrustProxyEnv(undefined)).toBeUndefined();
    expect(parseTrustProxyEnv('')).toBeUndefined();
    expect(parseTrustProxyEnv('false')).toBe(false);
    expect(parseTrustProxyEnv('true')).toBe(true);
    expect(() => parseTrustProxyEnv('1')).toThrow(/hop counts are not supported/);
    expect(() => parseTrustProxyEnv('2')).toThrow(/hop counts are not supported/);
    expect(parseTrustProxyEnv('100.64.0.0/10, 127.0.0.1')).toEqual(['100.64.0.0/10', '127.0.0.1']);
  });

  it('config schema: defaults to false, accepts bool, string and CIDR lists; rejects hop counts', () => {
    const base = (server: unknown): unknown => AmbassadorConfigSchema.safeParse({ server }).success;
    const parse = (v?: unknown): any => {
      const r = (AmbassadorConfigSchema as any).shape.server.safeParse(
        v === undefined ? {} : { trust_proxy: v }
      );
      return r;
    };
    expect(base({})).toBeDefined();
    expect(parse().data.trust_proxy).toBe(false);
    expect(parse(true).data.trust_proxy).toBe(true);
    expect(parse('10.0.0.5').data.trust_proxy).toBe('10.0.0.5');
    expect(parse(1).success).toBe(false);
    expect(parse(['100.64.0.0/10']).data.trust_proxy).toEqual(['100.64.0.0/10']);
    expect(parse(0).success).toBe(false);
  });

  it('fastify semantics we rely on: false ignores XFF, an IP/CIDR match believes it', async () => {
    for (const [tp, remote, expected] of [
      [false, '10.0.0.5', '10.0.0.5'],
      ['10.0.0.5', '10.0.0.5', '1.2.3.4'],
      ['10.0.0.0/24', '10.0.0.5', '1.2.3.4'],
      ['10.0.0.5', '10.0.9.9', '10.0.9.9'],
    ] as const) {
      const app = Fastify({ trustProxy: tp });
      app.get('/ip', async req => ({ ip: req.ip }));
      const r = await app.inject({
        method: 'GET',
        url: '/ip',
        remoteAddress: remote,
        headers: { 'x-forwarded-for': '1.2.3.4' },
      });
      expect(r.json().ip).toBe(expected);
      await app.close();
    }
  });
});
