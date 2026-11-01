/**
 * ADR-020 Remote Agent Endpoint — route constants and request/response contracts.
 *
 * Wire shapes follow the standards (RFC 6749/7009/7591/8414/8707/9728) for the OAuth
 * endpoints, and the 9443 `{ ok, data }` envelope for SPA/user APIs (grants).
 * OAuth protocol endpoints (token/register/revoke) return RFC-style bodies and errors
 * (`{ error, error_description }`), NOT the envelope.
 */

import { z } from 'zod';

// ===== Route constants =====

/** MCP resource server routes (8443 listener) */
export const AGENT_MCP_ROUTE = '/mcp';
export const OAUTH_PROTECTED_RESOURCE_ROUTE = '/.well-known/oauth-protected-resource';
/** Path-suffixed form: /.well-known/oauth-protected-resource/mcp */
export const OAUTH_PROTECTED_RESOURCE_MCP_ROUTE = '/.well-known/oauth-protected-resource/mcp';

/** Authorization server routes (9443 listener) */
export const OAUTH_AS_METADATA_ROUTE = '/.well-known/oauth-authorization-server';
export const OAUTH_AUTHORIZE_ROUTE = '/oauth/authorize';
export const OAUTH_AUTHORIZE_CONSENT_ROUTE = '/oauth/authorize/consent';
export const OAUTH_TOKEN_ROUTE = '/oauth/token';
export const OAUTH_REGISTER_ROUTE = '/oauth/register';
export const OAUTH_REVOKE_ROUTE = '/oauth/revoke';

/** User API (session cookie + CSRF), 9443 */
export const AGENT_GRANTS_ROUTE = '/v1/users/me/agent-grants';
export const AGENT_GRANT_ROUTE = '/v1/users/me/agent-grants/:grantId';
/** Admin API, 9443 */
export const ADMIN_OAUTH_CLIENTS_ROUTE = '/v1/admin/oauth-clients';
export const ADMIN_OAUTH_CLIENT_ROUTE = '/v1/admin/oauth-clients/:clientId';
export const ADMIN_AGENT_ENDPOINT_SETTINGS_ROUTE = '/v1/admin/agent-endpoint/settings';

// ===== Token prefixes =====

export const ACCESS_TOKEN_PREFIX = 'amb_at_';
export const REFRESH_TOKEN_PREFIX = 'amb_rt_';
/** Hash-prefix length allowed in logs/audit (never log raw tokens) */
export const TOKEN_LOG_PREFIX_LENGTH = 8;

// ===== Scopes =====

/** `mcp:<subscription_name>` or `mcp:*` */
export const scopeSchema = z.string().regex(/^mcp:(\*|[A-Za-z0-9_.-]{1,128})$/);

// ===== Metadata =====

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: ['header'];
}

export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  revocation_endpoint: string;
  response_types_supported: ['code'];
  grant_types_supported: ['authorization_code', 'refresh_token'];
  code_challenge_methods_supported: ['S256'];
  token_endpoint_auth_methods_supported: ['none'];
  scopes_supported: string[];
}

// ===== Authorize (GET renders SPA consent; POST consent decides) =====

export const authorizeQuerySchema = z.object({
  response_type: z.literal('code'),
  client_id: z.string().min(1).max(128),
  redirect_uri: z.string().url().max(2048),
  code_challenge: z.string().min(43).max(128),
  code_challenge_method: z.literal('S256'),
  resource: z.string().url(),
  scope: z.string().max(2048).optional(),
  state: z.string().max(512).optional(),
});
export type AuthorizeQuery = z.infer<typeof authorizeQuerySchema>;

/** POST /oauth/authorize/consent (cookie session + CSRF) */
export const consentRequestSchema = authorizeQuerySchema.extend({
  decision: z.enum(['approve', 'deny']),
  /** Granted scopes — must be ⊆ requested ∩ user's subscriptions */
  granted_scopes: z.array(scopeSchema).max(100),
  /** Optional tool allowlist (fully qualified tool names) */
  tool_allowlist: z.array(z.string().max(256)).max(500).optional(),
  /** Grant lifetime seconds; clamped to agent_endpoint.max_grant_ttl_seconds */
  ttl_seconds: z.number().int().min(60).optional(),
  label: z.string().min(1).max(128).optional(),
});
export type ConsentRequest = z.infer<typeof consentRequestSchema>;

/** Response: envelope data; SPA navigates browser to redirect_to */
export interface ConsentResponse {
  redirect_to: string;
}

// ===== Token endpoint (application/x-www-form-urlencoded) =====

export const tokenRequestSchema = z.discriminatedUnion('grant_type', [
  z.object({
    grant_type: z.literal('authorization_code'),
    code: z.string().min(1),
    redirect_uri: z.string().url(),
    client_id: z.string().min(1),
    code_verifier: z.string().min(43).max(128),
    resource: z.string().url(),
  }),
  z.object({
    grant_type: z.literal('refresh_token'),
    refresh_token: z.string().min(1),
    client_id: z.string().min(1),
    resource: z.string().url().optional(),
  }),
]);
export type TokenRequest = z.infer<typeof tokenRequestSchema>;

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  /** Absent for one-shot grants or when refresh_tokens_enabled is false */
  refresh_token?: string;
  scope: string;
}

/** RFC 6749 §5.2 error body for oauth endpoints */
export interface OAuthErrorResponse {
  error:
    | 'invalid_request'
    | 'invalid_client'
    | 'invalid_grant'
    | 'unauthorized_client'
    | 'unsupported_grant_type'
    | 'invalid_scope'
    | 'invalid_target'
    | 'access_denied'
    | 'invalid_redirect_uri'
    | 'invalid_client_metadata'
    | 'temporarily_unavailable'
    | 'server_error';
  error_description?: string;
}

// ===== Dynamic client registration (RFC 7591) =====

export const clientRegistrationRequestSchema = z.object({
  client_name: z.string().min(1).max(128),
  redirect_uris: z.array(z.string().url().max(2048)).min(1).max(10),
  grant_types: z.array(z.enum(['authorization_code', 'refresh_token'])).optional(),
  response_types: z.array(z.literal('code')).optional(),
  token_endpoint_auth_method: z.literal('none').optional(),
  scope: z.string().max(2048).optional(),
});
export type ClientRegistrationRequest = z.infer<typeof clientRegistrationRequestSchema>;

export interface ClientRegistrationResponse {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: ['code'];
  token_endpoint_auth_method: 'none';
  client_id_issued_at: number;
}

// ===== Revocation (RFC 7009) =====

export const revokeRequestSchema = z.object({
  token: z.string().min(1),
  token_type_hint: z.enum(['access_token', 'refresh_token']).optional(),
  client_id: z.string().min(1),
});
export type RevokeRequest = z.infer<typeof revokeRequestSchema>;
// Response: 200 with empty body always (RFC 7009 §2.2), except 400 invalid_request/429.

// ===== Agent grants (user API; envelope) =====

/** POST /v1/users/me/agent-grants — one-shot grant for headless/CI; no refresh token */
export const createGrantRequestSchema = z.object({
  label: z.string().min(1).max(128),
  scopes: z.array(scopeSchema).min(1).max(100),
  tool_allowlist: z.array(z.string().max(256)).max(500).optional(),
  ttl_seconds: z.number().int().min(60).optional(),
});
export type CreateGrantRequest = z.infer<typeof createGrantRequestSchema>;

export interface CreateGrantResponse {
  grant_id: string;
  /** Returned once */
  access_token: string;
  token_type: 'Bearer';
  expires_at: string;
  resource: string;
  scopes: string[];
}

export interface AgentGrantSummary {
  grant_id: string;
  label: string;
  /** null for one-shot grants */
  client_id: string | null;
  client_name: string | null;
  scopes: string[];
  tool_allowlist: string[] | null;
  resource: string;
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  has_refresh_token: boolean;
}

/** GET list: envelope paginated of AgentGrantSummary. DELETE :grantId revokes grant + all its tokens. */
export interface RevokeGrantResponse {
  grant_id: string;
  revoked_at: string;
}

// ===== Admin: OAuth clients / settings =====

export const adminCreateClientRequestSchema = clientRegistrationRequestSchema;
export interface OAuthClientSummary {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  registered_via: 'admin' | 'dcr';
  created_at: string;
  last_used_at: string | null;
  disabled: boolean;
}
export const adminUpdateSettingsRequestSchema = z.object({
  dynamic_client_registration: z.boolean(),
});
export interface AgentEndpointSettings {
  enabled: boolean;
  dynamic_client_registration: boolean;
}

// ===== Audit =====

/** New audit event actions (event_type per existing enum; `action` carries these) */
export const AGENT_AUDIT_ACTIONS = [
  'agent_grant_created',
  'agent_grant_revoked',
  'agent_token_issued',
  'agent_token_refreshed',
  'agent_token_revoked',
  'agent_refresh_reuse_detected',
  'oauth_client_registered',
  'oauth_client_disabled',
  'agent_auth_failure',
] as const;
export type AgentAuditAction = (typeof AGENT_AUDIT_ACTIONS)[number];

export const AGENT_AUTH_FAILURE_REASONS = [
  'missing_token',
  'bad_token',
  'expired',
  'revoked',
  'bad_audience',
  'insufficient_scope',
  'bad_origin',
  'token_in_query',
] as const;
export type AgentAuthFailureReason = (typeof AGENT_AUTH_FAILURE_REASONS)[number];
