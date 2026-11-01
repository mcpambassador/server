/**
 * TD-020 core config schema characterization (written to pass on zod 3 AND zod 4).
 * Pins the fully defaulted object, including omitted vs empty optional sections
 * (.default({}) on zod 3 vs .prefault({}) on zod 4 must be observably identical).
 */
import { describe, it, expect } from 'vitest';
import { AmbassadorConfigSchema } from '../src/config/schema.js';

const minimal = {
  server: {},
  authentication: { provider: 'ephemeral', config: {} },
  authorization: { provider: 'local', config: {} },
  audit: { provider: 'file', config: {} },
  database: { url: './data/a.db' },
  downstream_mcps: [],
};

const AGENT_DEFAULTS = {
  enabled: false,
  dynamic_client_registration: false,
  max_oauth_clients: 100,
  access_token_ttl_seconds: 900,
  default_grant_ttl_seconds: 3600,
  max_grant_ttl_seconds: 86400,
  auth_code_ttl_seconds: 60,
  refresh_tokens_enabled: true,
  allowed_origins: [],
  max_streams_per_grant: 4,
  rate_limits: {
    tool_calls_per_minute_per_grant: 60,
    tool_calls_per_minute_per_user: 600,
    token_per_minute: 10,
    register_per_hour: 5,
    authorize_per_minute: 30,
    failed_auth_per_minute: 20,
  },
};

describe('AmbassadorConfigSchema defaults', () => {
  it('minimal config: full defaulted object', () => {
    const r = AmbassadorConfigSchema.parse(minimal);
    expect(r).toEqual({
      server: { host: '0.0.0.0', port: 8443, trust_proxy: false },
      authentication: { provider: 'ephemeral', config: {} },
      authorization: { provider: 'local', config: {} },
      audit: { provider: 'file', on_failure: 'buffer', config: {} },
      database: { type: 'sqlite', url: './data/a.db' },
      downstream_mcps: [],
      agent_endpoint: AGENT_DEFAULTS,
    });
    // optional sections stay absent when omitted
    for (const k of ['registration', 'providers', 'buffer', 'session', 'user_pool']) {
      expect(k in r).toBe(false);
    }
  });

  it('agent_endpoint omitted, {} and {rate_limits:{}} all yield the same defaults', () => {
    const a = AmbassadorConfigSchema.parse(minimal).agent_endpoint;
    const b = AmbassadorConfigSchema.parse({ ...minimal, agent_endpoint: {} }).agent_endpoint;
    const c = AmbassadorConfigSchema.parse({
      ...minimal,
      agent_endpoint: { rate_limits: {} },
    }).agent_endpoint;
    expect(a).toEqual(AGENT_DEFAULTS);
    expect(b).toEqual(AGENT_DEFAULTS);
    expect(c).toEqual(AGENT_DEFAULTS);
  });

  it('partial agent_endpoint overrides merge with defaults', () => {
    const r = AmbassadorConfigSchema.parse({
      ...minimal,
      agent_endpoint: { enabled: true, rate_limits: { token_per_minute: 3 } },
    }).agent_endpoint;
    expect(r).toEqual({
      ...AGENT_DEFAULTS,
      enabled: true,
      rate_limits: { ...AGENT_DEFAULTS.rate_limits, token_per_minute: 3 },
    });
  });

  it('empty optional sections get their inner defaults', () => {
    const r = AmbassadorConfigSchema.parse({
      ...minimal,
      registration: {},
      providers: {},
      buffer: {},
      session: {},
      user_pool: {},
    });
    expect(r.registration).toEqual({
      mode: 'open',
      default_profile: 'all-tools',
      rate_limit: '10/hour',
      max_clients: 50,
      max_body_size: 4096,
    });
    expect(r.session).toEqual({
      idle_timeout_seconds: 1800,
      spindown_delay_seconds: 300,
      ttl_seconds: 28800,
      ui_ttl_seconds: 28800,
      heartbeat_expected_interval_seconds: 120,
      sweep_interval_seconds: 1800,
      evaluation_interval_seconds: 120,
    });
    expect(r.user_pool).toEqual({
      max_instances_per_user: 10,
      max_total_instances: 100,
      health_check_interval_ms: 120000,
    });
    expect(r.providers?.allowed_packages).toEqual([
      '@mcpambassador/authn-ephemeral',
      '@mcpambassador/authz-local',
      '@mcpambassador/audit-file',
    ]);
    expect(r.buffer).toMatchObject({ size: 10000, flush_interval_ms: 5000, spill_to_disk: true });
  });

  it('rejections: required sections, bad enums, ranges, record value types', () => {
    const paths = (input: unknown): string[] => {
      const r = AmbassadorConfigSchema.safeParse(input);
      if (r.success) return ['<accepted>'];
      return [...new Set(r.error.issues.map(i => i.path.join('.')))].sort();
    };
    expect(paths({})).toEqual([
      'audit',
      'authentication',
      'authorization',
      'database',
      'downstream_mcps',
      'server',
    ]);
    expect(paths({ ...minimal, server: { port: 0 } })).toEqual(['server.port']);
    expect(paths({ ...minimal, server: { trust_proxy: [] } })).toEqual(['server.trust_proxy']);
    expect(paths({ ...minimal, audit: { provider: 'f', on_failure: 'x', config: {} } })).toEqual([
      'audit.on_failure',
    ]);
    expect(paths({ ...minimal, database: { type: 'mysql', url: 'x' } })).toEqual(['database.type']);
    expect(paths({ ...minimal, authentication: { provider: 'p', config: [] } })).toEqual([
      'authentication.config',
    ]);
    expect(
      paths({ ...minimal, downstream_mcps: [{ name: 'a', transport: 'ws', env: { K: 1 } }] })
    ).toEqual(['downstream_mcps.0.env.K', 'downstream_mcps.0.transport']);
    expect(paths({ ...minimal, agent_endpoint: { issuer_url: 'nope' } })).toEqual([
      'agent_endpoint.issuer_url',
    ]);
    expect(paths({ ...minimal, agent_endpoint: { rate_limits: { token_per_minute: 0 } } })).toEqual(
      ['agent_endpoint.rate_limits.token_per_minute']
    );
    expect(paths({ ...minimal, session: { idle_timeout_seconds: 1 } })).toEqual([
      'session.idle_timeout_seconds',
    ]);
  });
});
