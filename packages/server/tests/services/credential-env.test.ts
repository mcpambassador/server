import { describe, it, expect } from 'vitest';
import { mapStaticCredentialEnv, mergeCredentialEnv } from '../../src/services/credential-env.js';
import { isBlockedEnvName } from '../../src/services/runner-guard.js';

describe('mapStaticCredentialEnv (TD-048)', () => {
  it('registry-shaped schema with no env_var injects under the field name', () => {
    const schema = {
      type: 'object',
      properties: { ALPACA_API_KEY: { type: 'string' }, ALPACA_SECRET_KEY: { type: 'string' } },
    };
    expect(mapStaticCredentialEnv(schema, { ALPACA_API_KEY: 'k', ALPACA_SECRET_KEY: 's' })).toEqual(
      {
        ALPACA_API_KEY: 'k',
        ALPACA_SECRET_KEY: 's',
      }
    );
  });

  it('an explicit env_var still wins over the field name', () => {
    const schema = { properties: { api_key: { type: 'string', env_var: 'BRAVE_API_KEY' } } };
    expect(mapStaticCredentialEnv(schema, { api_key: 'v' })).toEqual({ BRAVE_API_KEY: 'v' });
  });

  it('skips empty/missing values and tolerates a missing schema', () => {
    const schema = { properties: { A: {}, B: {} } };
    expect(mapStaticCredentialEnv(schema, { A: '', B: 'x' })).toEqual({ B: 'x' });
    expect(mapStaticCredentialEnv(undefined, { A: 'x' })).toEqual({});
  });

  it('denylisted names are still blocked (the pool rejects them at spawn)', () => {
    const out = mapStaticCredentialEnv(
      { properties: { LD_PRELOAD: {}, NPM_CONFIG_REGISTRY: {} } },
      {
        LD_PRELOAD: 'x',
        NPM_CONFIG_REGISTRY: 'y',
      }
    );
    expect(Object.keys(out).every(isBlockedEnvName)).toBe(true);
  });
});

describe('mergeCredentialEnv (TD-049)', () => {
  it('a credential cannot override fixed env (e.g. ALPACA_PAPER_TRADE), case-insensitively', () => {
    const r = mergeCredentialEnv(
      { ALPACA_PAPER_TRADE: 'true' },
      { ALPACA_PAPER_TRADE: 'false', alpaca_paper_trade: 'false', ALPACA_API_KEY: 'k' }
    );
    expect(r.env).toEqual({ ALPACA_PAPER_TRADE: 'true', ALPACA_API_KEY: 'k' });
    expect(r.dropped.sort()).toEqual(['ALPACA_PAPER_TRADE', 'alpaca_paper_trade']);
  });

  it('merges non-colliding names and handles missing fixed env', () => {
    expect(mergeCredentialEnv(undefined, { K: 'v' })).toEqual({ env: { K: 'v' }, dropped: [] });
  });
});
