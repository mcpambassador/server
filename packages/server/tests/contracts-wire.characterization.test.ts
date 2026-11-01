/**
 * TD-020 wire-contract characterization (written on zod 3, must stay green on zod 4).
 * Records, per exported contracts schema, whether each probe input is accepted (with the parsed
 * output) or rejected (with the sorted failing paths). Messages and issue codes are deliberately
 * NOT recorded: they are allowed to change; accept/reject, outputs and paths are the contract.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import * as C from '@mcpambassador/contracts';

const H64 = 'a'.repeat(64);
const VERIFIER = 'v'.repeat(43);
const URL_ = 'https://ambassador.example/mcp';
const RU = 'https://app.example/cb';
const GENERIC: unknown[] = [undefined, null, '', 'x', 0, 1, -1, 1.5, true, [], {}, { a: 1 }];

type Probe = [string, unknown];
const probes: Record<string, { schema: z.ZodTypeAny; inputs: Probe[] }> = {};
function add(name: string, schema: z.ZodTypeAny, extra: unknown[] = []): void {
  probes[name] = {
    schema,
    inputs: [...GENERIC, ...extra].map((v, i) => [`#${i}`, v] as Probe),
  };
}

add('scope', C.scopeSchema, [
  'mcp:*',
  'mcp:github',
  'mcp:',
  'mcp:a b',
  'tool:x',
  'mcp:' + 'a'.repeat(129),
]);
add('redirectUri', C.redirectUriSchema, [
  RU,
  'http://localhost:3000/cb',
  'http://127.0.0.1/cb',
  'http://evil.example/cb',
  'https://a.example/cb#frag',
  'ftp://a/b',
  'not a url',
  'https://' + 'a'.repeat(2100),
]);
add('authorizeQuery', C.authorizeQuerySchema, [
  {
    response_type: 'code',
    client_id: 'c',
    redirect_uri: RU,
    code_challenge: VERIFIER,
    code_challenge_method: 'S256',
    resource: URL_,
  },
  {
    response_type: 'code',
    client_id: 'c',
    redirect_uri: RU,
    code_challenge: VERIFIER,
    code_challenge_method: 'S256',
    resource: URL_,
    scope: 'mcp:*',
    state: 's',
    extra: 1,
  },
  {
    response_type: 'token',
    client_id: 'c',
    redirect_uri: RU,
    code_challenge: VERIFIER,
    code_challenge_method: 'plain',
    resource: 'nope',
  },
  {
    response_type: 'code',
    client_id: '',
    redirect_uri: 'http://evil/x',
    code_challenge: 'short',
    code_challenge_method: 'S256',
    resource: URL_,
  },
]);
add('disclosureMode', C.disclosureModeSchema, ['full', 'progressive', 'other', 'FULL']);
add('searchToolsInput', C.searchToolsInputSchema, [
  { query: '' },
  { query: 'x'.repeat(200) },
  { query: 'x'.repeat(201) },
  { query: 'a', mcp: '' },
  { query: 'a', limit: 0 },
  { query: 'a', limit: 50 },
  { query: 'a', limit: 51 },
  { query: 'a', limit: 2.5 },
  { query: 'a', limit: '5' },
  { query: 1 },
]);
add('describeToolInput', C.describeToolInputSchema, [
  { name: 'tool' },
  { name: '' },
  { name: 'ambassador__x' },
  { name: 'x'.repeat(257) },
  { name: 'a', mcp: 'm' },
  { name: 'a', mcp: '' },
]);
add('callToolInput', C.callToolInputSchema, [
  { name: 'tool' },
  { name: 'ambassador__call_tool' },
  { name: 'a', arguments: { k: [1, { z: null }] } },
  { name: 'a', arguments: [] },
  { name: 'a', arguments: 'x' },
  { name: 'a', mcp: 'm', arguments: {} },
]);
add('consentDecision', C.consentDecisionSchema, [
  { decision: 'deny', scopes: [], ttl_seconds: 60 },
  { decision: 'approve', scopes: ['mcp:*'], ttl_seconds: 3600, bound_client_id: 'c1' },
  { decision: 'approve', scopes: ['mcp:*'], ttl_seconds: 3600 },
  { decision: 'approve', scopes: [], ttl_seconds: 3600, bound_client_id: 'c1' },
  { decision: 'maybe', scopes: ['mcp:*'], ttl_seconds: 59 },
  { decision: 'approve', scopes: ['bad'], ttl_seconds: 60.5, bound_client_id: '' },
  {
    decision: 'approve',
    scopes: ['mcp:a'],
    ttl_seconds: 60,
    bound_client_id: 'c',
    tool_allowlist: ['t'],
    label: 'l',
    disclosure_mode: 'progressive',
  },
  {
    decision: 'approve',
    scopes: ['mcp:a'],
    ttl_seconds: 60,
    bound_client_id: 'c',
    disclosure_mode: 'weird',
  },
]);
add('tokenRequest', C.tokenRequestSchema, [
  {
    grant_type: 'authorization_code',
    code: 'c',
    redirect_uri: RU,
    client_id: 'c',
    code_verifier: VERIFIER,
    resource: URL_,
  },
  {
    grant_type: 'authorization_code',
    code: '',
    redirect_uri: 'http://evil/x',
    client_id: '',
    code_verifier: 'short',
    resource: 'x',
  },
  { grant_type: 'refresh_token', refresh_token: 'r', client_id: 'c' },
  { grant_type: 'refresh_token', refresh_token: 'r', client_id: 'c', resource: URL_, extra: true },
  { grant_type: 'refresh_token', refresh_token: '', client_id: 'c', resource: 'nope' },
  { grant_type: 'password', username: 'u' },
  { code: 'c' },
]);
add('clientRegistrationRequest', C.clientRegistrationRequestSchema, [
  { client_name: 'n', redirect_uris: [RU] },
  {
    client_name: 'n',
    redirect_uris: [RU],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: 'mcp:*',
  },
  { client_name: 'n', redirect_uris: [] },
  { client_name: 'n', redirect_uris: Array(11).fill(RU) },
  {
    client_name: '',
    redirect_uris: ['http://evil/x'],
    grant_types: ['implicit'],
    response_types: ['token'],
    token_endpoint_auth_method: 'client_secret_basic',
  },
]);
add('revokeRequest', C.revokeRequestSchema, [
  { token: 't', client_id: 'c' },
  { token: 't', client_id: 'c', token_type_hint: 'refresh_token' },
  { token: 't', client_id: 'c', token_type_hint: 'bad' },
  { token: '', client_id: '' },
]);
add('createGrantRequest', C.createGrantRequestSchema, [
  { bound_client_id: 'c', scopes: ['mcp:*'] },
  { bound_client_id: 'c', scopes: ['mcp:*'], ttl_seconds: 59 },
  {
    bound_client_id: 'c',
    scopes: ['mcp:*'],
    ttl_seconds: 60,
    label: 'l',
    tool_allowlist: ['t'],
    disclosure_mode: 'full',
  },
  { bound_client_id: '', scopes: [] },
  { bound_client_id: 'c', scopes: Array(101).fill('mcp:*') },
]);
add('adminCreateClientRequest', C.adminCreateClientRequestSchema, [
  { client_name: 'n', redirect_uris: [RU] },
]);
add('adminPatchClientRequest', C.adminPatchClientRequestSchema, [
  { disabled: true },
  { disabled: 'true' },
  { disabled: 1 },
]);
add('adminListGrantsQuery', C.adminListGrantsQuerySchema, [
  { limit: '10' },
  { limit: 10 },
  { limit: '0' },
  { limit: '201' },
  { limit: 'abc' },
  { limit: '' },
  { limit: null },
  { include_inactive: 'true' },
  { include_inactive: 'false' },
  { include_inactive: '' },
  { include_inactive: 0 },
  { user_id: 'u', cursor: 'c', limit: '200' },
  { limit: undefined },
]);
add('adminUpdateSettingsRequest', C.adminUpdateSettingsRequestSchema, [
  { dynamic_client_registration: false },
  { dynamic_client_registration: 'x' },
]);
add('pinPolicy', C.pinPolicySchema, ['review', 'auto', 'x']);
add('toolPinStatus', C.toolPinStatusSchema, ['approved', 'pending_review', 'rejected', 'x']);
add('toolPinFlags', C.toolPinFlagsSchema, [
  { rules_version: 1, codes: [] },
  { rules_version: 1.5, codes: ['nope'] },
]);
add('toolDefinition', C.toolDefinitionSchema, [
  { name: 't' },
  { name: 't', extra: 1, inputSchema: { type: 'object' }, icons: [{ src: 'x' }] },
  { name: '' },
  { name: 't', icons: ['x'] },
  { name: 't', annotations: [] },
]);
const pin = {
  pin_id: 'p',
  mcp_id: 'm',
  mcp_name: 'n',
  scope_user_id: null,
  tool_name: 't',
  status: 'approved',
  approved_hash: H64,
  pending_hash: null,
  flags: { rules_version: 1, codes: [] },
  absent: false,
  baseline_unreviewed: false,
  first_seen_at: 'a',
  approved_at: null,
  approved_by: null,
  updated_at: 'b',
};
add('toolPinSummary', C.toolPinSummarySchema, [
  pin,
  { ...pin, status: 'x', flags: undefined },
  { ...pin, extra: 1 },
]);
add('toolPinDetail', C.toolPinDetailSchema, [
  { ...pin, approved_definition: { name: 't' }, pending_definition: null },
  { ...pin, approved_definition: undefined },
]);
add('toolPinQueueSummary', C.toolPinQueueSummarySchema, [
  {
    pending_count: 0,
    baseline_unreviewed_count: 0,
    held_mcps: [{ mcp_id: 'm', scope_user_id: null }],
  },
  { pending_count: 1.5, baseline_unreviewed_count: 0, held_mcps: [{}] },
]);
add('toolPinListQuery', C.toolPinListQuerySchema, [
  {},
  { limit: '5' },
  { limit: '0' },
  { limit: '201' },
  { limit: 'x' },
  { limit: '' },
  { status: 'approved', scope: 'shared', baseline: 'unreviewed', serving: 'true' },
  { scope: 'other', baseline: 'x', serving: 'false', status: 'bad' },
]);
add('toolPinDecisionRequest', C.toolPinDecisionRequestSchema, [
  { expected_hash: H64 },
  { expected_hash: H64, apply_to: 'all_users', reason: 'r' },
  { expected_hash: 'A'.repeat(64) },
  { expected_hash: 'abc' },
  { expected_hash: H64, apply_to: 'x', reason: 'r'.repeat(501) },
]);
add('toolPinConfirmBaselineRequest', C.toolPinConfirmBaselineRequestSchema, [
  { expected_hash: H64 },
  { expected_hash: 'x' },
]);
add('toolPinRevokeRequest', C.toolPinRevokeRequestSchema, [
  { expected_hash: H64, reason: 'r' },
  { expected_hash: 'x' },
]);
add('toolPinRevokeResponse', C.toolPinRevokeResponseSchema, [
  { ...pin, approved_definition: null, pending_definition: null, revoked_pin_ids: ['a'] },
  { ...pin },
]);
add('setPinPolicyRequest', C.setPinPolicyRequestSchema, [
  { pin_policy: 'auto' },
  { pin_policy: 'x' },
]);
add('killSwitchSummary', C.killSwitchSummarySchema, [
  { target: 'client:abc', type: 'client', activated_at: 'a', activated_by: 'u' },
  { target: 'bad', type: 'other', activated_at: 'a', activated_by: 'u' },
]);
add('successEnvelope(string)', C.successEnvelopeSchema(z.string()), [
  { ok: true, data: 'x' },
  { ok: true, data: 1 },
  { ok: false, data: 'x' },
]);
add('paginatedEnvelope(number)', C.paginatedEnvelopeSchema(z.number()), [
  { ok: true, data: [1], pagination: { has_more: false, total_count: 1 } },
  { ok: true, data: [1], pagination: { has_more: false, total_count: -1, next_cursor: null } },
  { ok: true, data: ['x'], pagination: { has_more: 'no', total_count: 1.5, next_cursor: 5 } },
]);
add('errorEnvelope', C.errorEnvelopeSchema, [
  { ok: false, error: { code: 'c', message: 'm' } },
  { ok: false, error: { code: 'c', message: 'm', details: [1, 'x'] } },
  { ok: false, error: { code: 1 } },
  { ok: true },
]);
add('apiResponse(string)', C.apiResponseSchema(z.string()), [
  { ok: true, data: 'x' },
  { ok: false, error: { code: 'c', message: 'm' } },
  { ok: 'maybe' },
  { data: 'x' },
]);

const outcome = (schema: z.ZodTypeAny, input: unknown): unknown => {
  const r = schema.safeParse(input);
  return r.success
    ? { ok: true, data: r.data === undefined ? '__undefined__' : r.data }
    : { ok: false, paths: [...new Set(r.error.issues.map(i => i.path.join('.')))].sort() };
};

describe('contracts wire behavior (accept/reject, parsed output, failing paths)', () => {
  it('covers every exported schema', () => {
    const exported = Object.keys(C).filter(k => k.endsWith('Schema'));
    expect(exported.length).toBeGreaterThan(30);
    expect(Object.keys(probes).length).toBeGreaterThanOrEqual(exported.length - 6);
  });
  for (const [name, { schema, inputs }] of Object.entries(probes)) {
    it(name, () => {
      expect(inputs.map(([id, v]) => [id, outcome(schema, v)])).toMatchSnapshot();
    });
  }
});
