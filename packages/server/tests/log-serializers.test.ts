import { describe, it, expect } from 'vitest';
import { redactQueryUrl, requestLogSerializers } from '../src/log-serializers.js';

describe('request log serializer', () => {
  it('redacts query strings, keeps the path', () => {
    expect(redactQueryUrl('/mcp?access_token=amb_at_secret&x=1')).toBe('/mcp?[redacted]');
    expect(redactQueryUrl('/oauth/authorize')).toBe('/oauth/authorize');
    const out = requestLogSerializers.req({
      method: 'GET',
      url: '/mcp?access_token=s',
      ip: '1.1.1.1',
    });
    expect(JSON.stringify(out)).not.toContain('secret');
    expect(JSON.stringify(out)).not.toContain('access_token');
    expect(out.url).toBe('/mcp?[redacted]');
  });
});
