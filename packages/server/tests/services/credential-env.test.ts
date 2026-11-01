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

  it('submitted fields that are not schema properties are never injected', () => {
    const schema = { properties: { ALPACA_API_KEY: {} } };
    expect(
      mapStaticCredentialEnv(schema, {
        ALPACA_API_KEY: 'k',
        ALPACA_PAPER_TRADE: 'false',
        PATH: '/x',
      })
    ).toEqual({ ALPACA_API_KEY: 'k' });
  });

  it('field-name fallback is matched against the denylist case-insensitively', () => {
    const out = mapStaticCredentialEnv(
      { properties: { ld_preload: {}, Npm_Config_Registry: {} } },
      {
        ld_preload: 'x',
        Npm_Config_Registry: 'y',
      }
    );
    expect(Object.keys(out)).toHaveLength(2);
    expect(Object.keys(out).every(isBlockedEnvName)).toBe(true);
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

describe('mergeCredentialEnv placeholder slots', () => {
  it('fills an exact ${NAME} slot with the credential for NAME (Brave/Alpaca registry shape)', () => {
    const r = mergeCredentialEnv(
      {
        ALPACA_API_KEY: '${ALPACA_API_KEY}',
        ALPACA_SECRET_KEY: '${ALPACA_SECRET_KEY}',
        ALPACA_PAPER_TRADE: 'true',
      },
      { ALPACA_API_KEY: 'k', ALPACA_SECRET_KEY: 's' }
    );
    expect(r.env).toEqual({
      ALPACA_API_KEY: 'k',
      ALPACA_SECRET_KEY: 's',
      ALPACA_PAPER_TRADE: 'true',
    });
    expect(r.dropped).toEqual([]);
  });

  it('keeps literals locked even when a slot for the same MCP is filled', () => {
    const r = mergeCredentialEnv(
      { ALPACA_API_KEY: '${ALPACA_API_KEY}', ALPACA_PAPER_TRADE: 'true' },
      { ALPACA_API_KEY: 'k', ALPACA_PAPER_TRADE: 'false' }
    );
    expect(r.env.ALPACA_PAPER_TRADE).toBe('true');
    expect(r.dropped).toEqual(['ALPACA_PAPER_TRADE']);
  });

  it('a slot naming a different variable stays locked (never filled by credential A)', () => {
    const r = mergeCredentialEnv({ A: '${B}' }, { A: 'x' });
    expect(r.env).toEqual({ A: '${B}' });
    expect(r.dropped).toEqual(['A']);
  });

  it('matches slots case-insensitively', () => {
    const r = mergeCredentialEnv(
      { brave_api_key: '${BRAVE_API_KEY}', X: '${x}' },
      { BRAVE_API_KEY: 'k', x: 'v' }
    );
    expect(r.env).toEqual({ BRAVE_API_KEY: 'k', x: 'v' });
    expect(r.dropped).toEqual([]);
  });

  it('removes an unfilled slot instead of passing the literal ${X}', () => {
    const r = mergeCredentialEnv({ TOKEN: '${TOKEN}', MODE: 'ro' }, {});
    expect(r.env).toEqual({ MODE: 'ro' });
  });

  it('does not substitute inside other values (TD-050): embedded placeholders are locked literals', () => {
    const fixed = { OPENAPI_MCP_HEADERS: '{"Authorization":"Bearer ${NOTION_API_KEY}"}' };
    const r = mergeCredentialEnv(fixed, { NOTION_API_KEY: 'k', OPENAPI_MCP_HEADERS: 'evil' });
    expect(r.env.OPENAPI_MCP_HEADERS).toBe(fixed.OPENAPI_MCP_HEADERS);
    expect(r.dropped).toEqual(['OPENAPI_MCP_HEADERS']);
  });
});

describe('mapStaticCredentialEnv hardening', () => {
  it('ignores inherited keys and non-string values', () => {
    const schema = { properties: { constructor: {}, toString: {}, N: {}, S: {} } };
    const creds = { N: 5, S: 'ok' } as unknown as Record<string, string>;
    expect(mapStaticCredentialEnv(schema, creds)).toEqual({ S: 'ok' });
  });
  it('an empty env_var falls back to the field name', () => {
    expect(mapStaticCredentialEnv({ properties: { K: { env_var: '' } } }, { K: 'v' })).toEqual({
      K: 'v',
    });
  });
});
