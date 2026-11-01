/**
 * TD-020 request-schema characterization (written to pass on zod 3 AND zod 4).
 * Pins accept/reject, parsed output and failing paths for the admin and user route schemas.
 * Messages and issue codes are deliberately not asserted.
 */
import { describe, it, expect } from 'vitest';
import type { z } from 'zod';
import * as M from '../src/admin/mcp-schemas.js';
import * as A from '../src/admin/schemas.js';
import * as R from '../src/routes/schemas.js';

const U1 = '3f2b8c1e-6a4d-4e0b-9c7a-1d2e3f4a5b6c';
const U2 = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const TS = '2026-01-01T00:00:00.000Z';

type Out = { ok: true; data: unknown } | { ok: false; paths: string[] };
function run(schema: z.ZodTypeAny, input: unknown): Out {
  const r = schema.safeParse(input);
  if (r.success) return { ok: true, data: r.data };
  return {
    ok: false,
    paths: [...new Set(r.error.issues.map(i => i.path.join('.')))].sort(),
  };
}
const accepts = (schema: z.ZodTypeAny, input: unknown, expected?: unknown) => {
  const o = run(schema, input);
  expect(o.ok).toBe(true);
  if (expected !== undefined && o.ok) expect(o.data).toEqual(expected);
};
const rejects = (schema: z.ZodTypeAny, input: unknown, paths: string[]) => {
  const o = run(schema, input);
  expect(o.ok).toBe(false);
  if (!o.ok) expect(o.paths).toEqual(paths);
};

const oauth = {
  auth_url: 'https://idp.example/auth',
  token_url: 'https://idp.example/token',
  scopes: 'read write',
  client_id_env: 'GOOGLE_CLIENT_ID',
  client_secret_env: 'GOOGLE_CLIENT_SECRET',
  access_token_env_var: 'GOOGLE_ACCESS_TOKEN',
};

describe('mcp-schemas', () => {
  it('oauthConfigSchema: accepts a full config and optional extras', () => {
    accepts(M.oauthConfigSchema, oauth, oauth);
    accepts(M.oauthConfigSchema, {
      ...oauth,
      revocation_url: 'https://idp.example/revoke',
      extra_params: { prompt: 'consent' },
    });
  });
  it('oauthConfigSchema: https refine, *_CLIENT_ID, env-name pattern, record values', () => {
    rejects(M.oauthConfigSchema, { ...oauth, auth_url: 'http://idp.example/auth' }, ['auth_url']);
    rejects(M.oauthConfigSchema, { ...oauth, token_url: 'nope' }, ['token_url']);
    rejects(M.oauthConfigSchema, { ...oauth, revocation_url: 'http://x.example/r' }, [
      'revocation_url',
    ]);
    rejects(M.oauthConfigSchema, { ...oauth, client_id_env: 'GOOGLE_SECRET' }, ['client_id_env']);
    rejects(M.oauthConfigSchema, { ...oauth, client_id_env: 'google_client_id' }, [
      'client_id_env',
    ]);
    rejects(M.oauthConfigSchema, { ...oauth, client_secret_env: '1BAD' }, ['client_secret_env']);
    rejects(M.oauthConfigSchema, { ...oauth, scopes: '' }, ['scopes']);
    rejects(M.oauthConfigSchema, { ...oauth, extra_params: { a: 1 } }, ['extra_params.a']);
    rejects(M.oauthConfigSchema, {}, [
      'access_token_env_var',
      'auth_url',
      'client_id_env',
      'client_secret_env',
      'scopes',
      'token_url',
    ]);
  });
  it('oauthConfigSchema.partial(): present fields still validated, missing ones allowed', () => {
    const p = M.oauthConfigSchema.partial();
    accepts(p, {}, {});
    accepts(p, { auth_url: 'https://a.example/x' });
    rejects(p, { auth_url: 'http://a.example/x' }, ['auth_url']);
    rejects(p, { client_id_env: 'FOO' }, ['client_id_env']);
  });
  it('createMcpSchema: defaults auth_type, validates name/transport/config', () => {
    const base = { name: 'my-mcp_1', display_name: 'My MCP', transport_type: 'stdio', config: {} };
    accepts(M.createMcpSchema, base, { ...base, auth_type: 'none' });
    accepts(M.createMcpSchema, { ...base, auth_type: 'oauth2', oauth_config: oauth });
    accepts(M.createMcpSchema, { ...base, icon_url: null });
    rejects(M.createMcpSchema, { ...base, name: 'Bad Name' }, ['name']);
    rejects(M.createMcpSchema, { ...base, name: '' }, ['name']);
    rejects(M.createMcpSchema, { ...base, transport_type: 'ws' }, ['transport_type']);
    rejects(M.createMcpSchema, { ...base, config: [] }, ['config']);
    rejects(M.createMcpSchema, { ...base, config: { a: 1 }, credential_schema: 'x' }, [
      'credential_schema',
    ]);
    rejects(M.createMcpSchema, { ...base, auth_type: 'basic' }, ['auth_type']);
    rejects(M.createMcpSchema, { ...base, icon_url: 'not a url' }, ['icon_url']);
    rejects(M.createMcpSchema, { ...base, oauth_config: { ...oauth, auth_url: 'http://x' } }, [
      'oauth_config.auth_url',
    ]);
    rejects(M.createMcpSchema, {}, ['config', 'display_name', 'name', 'transport_type']);
  });
  it('createMcpSchema: unknown keys are stripped, not rejected', () => {
    const base = { name: 'a', display_name: 'A', transport_type: 'http', config: {} };
    accepts(M.createMcpSchema, { ...base, extra: 1 }, { ...base, auth_type: 'none' });
  });
  it('updateMcpSchema: everything optional, enums validated', () => {
    accepts(M.updateMcpSchema, {}, {});
    accepts(M.updateMcpSchema, { auth_type: 'static', isolation_mode: 'per_user' });
    rejects(M.updateMcpSchema, { isolation_mode: 'x' }, ['isolation_mode']);
    rejects(M.updateMcpSchema, { display_name: '' }, ['display_name']);
    rejects(M.updateMcpSchema, { oauth_config: {} }, [
      'oauth_config.access_token_env_var',
      'oauth_config.auth_url',
      'oauth_config.client_id_env',
      'oauth_config.client_secret_env',
      'oauth_config.scopes',
      'oauth_config.token_url',
    ]);
  });
  it('mcpParams / listMcpsQuery / marketplaceQuery', () => {
    accepts(M.mcpParamsSchema, { mcpId: U1 });
    rejects(M.mcpParamsSchema, { mcpId: 'x' }, ['mcpId']);
    accepts(M.listMcpsQuerySchema, {}, { limit: 25 });
    accepts(
      M.listMcpsQuerySchema,
      { limit: '10', status: 'draft' },
      { limit: 10, status: 'draft' }
    );
    rejects(M.listMcpsQuerySchema, { limit: '0' }, ['limit']);
    rejects(M.listMcpsQuerySchema, { limit: '101' }, ['limit']);
    rejects(M.listMcpsQuerySchema, { status: 'gone' }, ['status']);
    accepts(M.marketplaceQuerySchema, { cursor: 'c', limit: '5' }, { cursor: 'c', limit: 5 });
    rejects(M.marketplaceQuerySchema, { limit: '1000' }, ['limit']);
  });
});

describe('admin/schemas', () => {
  it('profiles: strict objects reject unknown keys', () => {
    accepts(
      A.createProfileSchema,
      { name: 'p', allowed_tools: ['a'] },
      { name: 'p', allowed_tools: ['a'] }
    );
    rejects(A.createProfileSchema, { name: 'p', extra: 1 }, ['']);
    rejects(A.createProfileSchema, { name: '' }, ['name']);
    rejects(A.createProfileSchema, { name: 'p', parent_profile_id: 'x' }, ['parent_profile_id']);
    rejects(A.createProfileSchema, { name: 'p', allowed_tools: [1] }, ['allowed_tools.0']);
    accepts(A.updateProfileSchema, {}, {});
    rejects(A.updateProfileSchema, { extra: 1 }, ['']);
    rejects(A.getProfileParamsSchema, { profileId: 'x' }, ['profileId']);
  });
  it('list queries: coerced limit, defaulted sort, enum sort/status', () => {
    accepts(A.listProfilesQuerySchema, {}, { sort: 'name:asc' });
    accepts(
      A.listProfilesQuerySchema,
      { limit: '7', sort: 'name:desc' },
      { limit: 7, sort: 'name:desc' }
    );
    rejects(A.listProfilesQuerySchema, { limit: 'abc' }, ['limit']);
    rejects(A.listProfilesQuerySchema, { limit: '1.5' }, ['limit']);
    rejects(A.listProfilesQuerySchema, { sort: 'bogus' }, ['sort']);
    accepts(A.listUsersQuerySchema, {}, { sort: 'display_name:asc' });
    rejects(A.listUsersQuerySchema, { status: 'deleted' }, ['status']);
    accepts(A.listClientKeysQuerySchema, {}, { sort: 'created_at:desc' });
    rejects(A.listClientKeysQuerySchema, { user_id: 'x' }, ['user_id']);
    accepts(A.listSessionsQuerySchema, {}, { sort: 'last_activity_at:desc' });
    rejects(A.listSessionsQuerySchema, { status: 'dead' }, ['status']);
    accepts(A.listAuditEventsQuerySchema, { start_time: TS, client_id: U1 });
    rejects(A.listAuditEventsQuerySchema, { start_time: 'yesterday' }, ['start_time']);
    rejects(A.listAuditEventsQuerySchema, { end_time: '2026-01-01' }, ['end_time']);
  });
  it('kill switch', () => {
    accepts(A.killSwitchSchema, { enabled: true }, { enabled: true });
    rejects(A.killSwitchSchema, { enabled: 'yes' }, ['enabled']);
    rejects(A.killSwitchSchema, { enabled: true, x: 1 }, ['']);
    accepts(A.killSwitchParamsSchema, { target: 'client:abc' });
    accepts(A.killSwitchParamsSchema, { target: 'mcp:github' });
    rejects(A.killSwitchParamsSchema, { target: 'user:abc' }, ['target']);
    rejects(A.killSwitchParamsSchema, { target: '' }, ['target']);
  });
  it('users', () => {
    accepts(A.createUserSchema, { display_name: 'A', email: 'a@b.example', status: 'active' });
    rejects(A.createUserSchema, { display_name: 'A', status: 'deactivated' }, ['status']);
    rejects(A.createUserSchema, { display_name: 'A', email: 'nope' }, ['email']);
    rejects(A.createUserSchema, { display_name: '' }, ['display_name']);
    accepts(A.updateUserSchema, { status: 'deactivated' });
    rejects(A.updateUserSchema, { id: U1 }, ['']);
    rejects(A.updateUserParamsSchema, { userId: 'x' }, ['userId']);
  });
  it('clients and sessions', () => {
    const c = { user_id: U1, profile_id: U2, client_name: 'laptop' };
    accepts(A.createClientSchema, c, c);
    accepts(A.createClientSchema, { ...c, expires_at: TS });
    rejects(A.createClientSchema, { ...c, expires_at: 'tomorrow' }, ['expires_at']);
    rejects(A.createClientSchema, { client_name: 'x' }, ['profile_id', 'user_id']);
    rejects(A.createClientSchema, { ...c, extra: 1 }, ['']);
    accepts(A.updateClientSchema, { status: 'revoked' });
    rejects(A.updateClientSchema, { status: 'deleted' }, ['status']);
    rejects(A.updateClientParamsSchema, { clientId: '1' }, ['clientId']);
    rejects(A.deleteSessionParamsSchema, { sessionId: '1' }, ['sessionId']);
    accepts(A.rotateHmacSecretResponseSchema, {
      success: true,
      sessionsInvalidated: 0,
      message: 'ok',
    });
    rejects(
      A.rotateHmacSecretResponseSchema,
      { success: true, sessionsInvalidated: -1, message: 'ok' },
      ['sessionsInvalidated']
    );
  });
});

describe('routes/schemas (user-facing)', () => {
  it('clients', () => {
    accepts(R.createClientSchema, { client_name: 'c' }, { client_name: 'c' });
    rejects(R.createClientSchema, { client_name: 'c', user_id: U1 }, ['']);
    rejects(R.createClientSchema, { client_name: 'x'.repeat(256) }, ['client_name']);
    accepts(R.updateClientSchema, { status: 'suspended' });
    rejects(R.updateClientSchema, { status: 'revoked' }, ['status']);
    rejects(R.clientIdParamsSchema, {}, ['clientId']);
  });
  it('subscriptions', () => {
    accepts(R.createSubscriptionSchema, { mcp_id: U1, selected_tools: ['a'] });
    rejects(R.createSubscriptionSchema, { mcp_id: 'x' }, ['mcp_id']);
    rejects(R.createSubscriptionSchema, { mcp_id: U1, extra: 1 }, ['']);
    accepts(R.updateSubscriptionSchema, { status: 'paused' }, { status: 'paused' });
    rejects(R.updateSubscriptionSchema, { status: 'deleted' }, ['status']);
    accepts(R.subscriptionParamsSchema, { clientId: U1, subscriptionId: U2 });
    rejects(R.subscriptionParamsSchema, { clientId: U1 }, ['subscriptionId']);
    rejects(R.clientSubscriptionParamsSchema, { clientId: 'z' }, ['clientId']);
  });
  it('credentials: string values only', () => {
    rejects(R.credentialParamsSchema, { mcpId: 'x' }, ['mcpId']);
    accepts(R.setCredentialBodySchema, { credentials: { K: 'v' } }, { credentials: { K: 'v' } });
    accepts(R.setCredentialBodySchema, { credentials: {} }, { credentials: {} });
    rejects(R.setCredentialBodySchema, { credentials: { K: 1 } }, ['credentials.K']);
    rejects(R.setCredentialBodySchema, { credentials: [] }, ['credentials']);
    rejects(R.setCredentialBodySchema, { credentials: {}, x: 1 }, ['']);
  });
});
