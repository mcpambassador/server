import { describe, it, expect } from 'vitest';
import { isAgentEndpointPath } from '../src/spa-handler.js';

describe('isAgentEndpointPath (ADR-020 SPA fallback exclusion)', () => {
  it.each([
    '/mcp',
    '/mcp?x=1',
    '/mcp/',
    '/oauth/authorize?client_id=a',
    '/oauth/token',
    '/oauth/register',
    '/oauth/revoke',
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/mcp',
    '/.well-known/oauth-authorization-server',
  ])('matches %s', u => expect(isAgentEndpointPath(u)).toBe(true));

  it.each([
    '/app/oauth/consent',
    '/app/dashboard',
    '/login',
    '/mcps',
    '/mcp-foo',
    '/oauthx',
    '/v1/oauth/consent/abc',
    '/',
  ])('does not match %s', u => expect(isAgentEndpointPath(u)).toBe(false));
});
