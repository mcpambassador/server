import { describe, it, expect, vi, beforeEach } from 'vitest';

const seen: any[] = [];
vi.mock('../../src/downstream/stdio-connection.js', () => ({
  StdioMcpConnection: class {
    constructor(config: any) {
      seen.push(config);
    }
    async start() {}
    async stop() {}
    getTools() {
      return [];
    }
  },
}));
vi.mock('../../src/downstream/http-connection.js', () => ({ HttpMcpConnection: class {} }));

import { discoverTools } from '../../src/services/tool-discovery-engine.js';

const entry = (env: Record<string, string>, props: Record<string, unknown>) =>
  ({
    mcp_id: 'm1',
    name: 'alpaca',
    transport_type: 'stdio',
    requires_user_credentials: true,
    auth_type: 'static',
    config: JSON.stringify({ command: ['uvx', 'alpaca-mcp-server==2.4.0'], env }),
    credential_schema: JSON.stringify({ type: 'object', properties: props }),
  }) as any;

describe('discoverTools credential env (shared helpers)', () => {
  beforeEach(() => {
    seen.length = 0;
  });

  it('maps via env_var/field name, fills slots, keeps fixed env locked, ignores non-schema fields', async () => {
    const res = await discoverTools(
      entry(
        { ALPACA_API_KEY: '${ALPACA_API_KEY}', ALPACA_PAPER_TRADE: 'true' },
        { ALPACA_API_KEY: {}, SECRET: { env_var: 'ALPACA_SECRET_KEY' }, EMPTY: { env_var: '' } }
      ),
      { ALPACA_API_KEY: 'k', SECRET: 's', EMPTY: 'e', ALPACA_PAPER_TRADE: 'false' }
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].env).toEqual({
      ALPACA_PAPER_TRADE: 'true',
      ALPACA_API_KEY: 'k',
      ALPACA_SECRET_KEY: 's',
      EMPTY: 'e',
    });
    expect(res.warnings.some(w => w.includes("'ALPACA_PAPER_TRADE'"))).toBe(true);
  });

  it('a literal fixed value beats a schema-declared credential of the same name', async () => {
    await discoverTools(entry({ ALPACA_PAPER_TRADE: 'true' }, { ALPACA_PAPER_TRADE: {} }), {
      ALPACA_PAPER_TRADE: 'false',
    });
    expect(seen[0].env).toEqual({ ALPACA_PAPER_TRADE: 'true' });
  });
});
