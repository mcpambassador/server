/**
 * ADR-020 Remote Agent Endpoint — route constants and request/response contracts.
 *
 * Wire shapes follow the standards (RFC 6749/7009/7591/8414/8707/9728) for the OAuth
 * endpoints, and the 9443 `{ ok, data }` envelope for SPA/user APIs (grants).
 * OAuth protocol endpoints (token/register/revoke) return RFC-style bodies and errors
 * (`{ error, error_description }`), NOT the envelope.
 */

import { z } from 'zod';
import { TOOL_PIN_RESERVED_NAME_PREFIX } from './tool-pins.js';

// ===== Route constants =====

/** MCP resource server routes (8443 listener) */
export const AGENT_MCP_ROUTE = '/mcp';
export const OAUTH_PROTECTED_RESOURCE_ROUTE = '/.well-known/oauth-protected-resource';
/** Path-suffixed form: /.well-known/oauth-protected-resource/mcp */
export const OAUTH_PROTECTED_RESOURCE_MCP_ROUTE = '/.well-known/oauth-protected-resource/mcp';

/** Authorization server routes (9443 listener) */
export const OAUTH_AS_METADATA_ROUTE = '/.well-known/oauth-authorization-server';
export const OAUTH_AUTHORIZE_ROUTE = '/oauth/authorize';
/** SPA route the browser is redirected to; query: request_id */
export const SPA_CONSENT_ROUTE = '/app/oauth/consent';
/** User API (session cookie; POST also CSRF) */
export const OAUTH_CONSENT_ROUTE = '/v1/oauth/consent/:requestId';
/** Pending authorize requests: single-use, bound to opening user, ~10 min */
export const PENDING_AUTH_REQUEST_TTL_SECONDS = 600;
export const OAUTH_TOKEN_ROUTE = '/oauth/token';
export const OAUTH_REGISTER_ROUTE = '/oauth/register';
export const OAUTH_REVOKE_ROUTE = '/oauth/revoke';

/** User API (session cookie + CSRF), 9443 */
/** GET: availability/limits for the Agent access page; registered even when the endpoint is disabled */
export const USER_AGENT_ENDPOINT_ROUTE = '/v1/users/me/agent-endpoint';
export const AGENT_GRANTS_ROUTE = '/v1/users/me/agent-grants';
export const AGENT_GRANT_ROUTE = '/v1/users/me/agent-grants/:grantId';
/** Admin API, 9443 */
export const ADMIN_OAUTH_CLIENTS_ROUTE = '/v1/admin/oauth-clients';
export const ADMIN_OAUTH_CLIENT_ROUTE = '/v1/admin/oauth-clients/:clientId';
export const ADMIN_AGENT_GRANTS_ROUTE = '/v1/admin/agent-grants';
export const ADMIN_AGENT_GRANT_ROUTE = '/v1/admin/agent-grants/:grantId';
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

// ===== Authorize =====
// GET /oauth/authorize validates the request (client, redirect_uri, PKCE S256, resource, scope),
// stores a pending request and 302s to `${SPA_CONSENT_ROUTE}?request_id=…` (requires SPA login;
// the SPA login flow returns to the same URL). Invalid client/redirect_uri => HTML/JSON error, NO redirect.

/**
 * redirect_uri policy (ADR-020 §5b, v1): https, or http on a loopback host (127.0.0.1, [::1],
 * localhost; any port). No fragments. javascript:/data:/file:/custom (private-use) schemes are
 * rejected. Matched by exact string at /oauth/authorize and /oauth/token.
 */
export function isAllowedRedirectUri(value: string): boolean {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  if (u.hash || value.includes('#')) return false;
  if (u.username || u.password) return false;
  if (u.protocol === 'https:') return true;
  if (u.protocol === 'http:') {
    return u.hostname === '127.0.0.1' || u.hostname === '[::1]' || u.hostname === 'localhost';
  }
  return false;
}
export const redirectUriSchema = z.string().max(2048).refine(isAllowedRedirectUri, {
  message: 'redirect_uri must be https or http on a loopback host, without a fragment',
});

export const authorizeQuerySchema = z.object({
  response_type: z.literal('code'),
  client_id: z.string().min(1).max(128),
  redirect_uri: redirectUriSchema,
  code_challenge: z.string().min(43).max(128),
  code_challenge_method: z.literal('S256'),
  resource: z.string().url(),
  scope: z.string().max(2048).optional(),
  state: z.string().max(512).optional(),
});
export type AuthorizeQuery = z.infer<typeof authorizeQuerySchema>;

export interface ConsentClientOption {
  /** Ambassador client id (NOT the OAuth client) */
  client_id: string;
  client_name: string;
  profile_name: string | null;
  subscriptions: { name: string; scope: string; description?: string }[];
}

/** GET /v1/oauth/consent/:requestId (user session) — envelope data */
export interface ConsentDetails {
  client_name: string;
  /** true only for admin-registered clients; false for DCR clients (SPA shows "unverified" warning) */
  client_verified: boolean;
  /** Host (incl. port) the authorization code will be sent to; show it on the consent screen */
  redirect_uri_host: string;
  requested_scopes: string[];
  /**
   * The user's ACTIVE Ambassador clients. A grant binds to exactly one of them (bound-client
   * model): effective permissions = that client's subscriptions ∩ its profile's authz ∩ scopes
   * ∩ allowlist, evaluated on every call. Scopes are `mcp:<subscription name>` / `mcp:*`,
   * resolved against the chosen client's subscriptions. Empty array ⇒ user cannot consent.
   */
  clients: ConsentClientOption[];
  default_ttl_seconds: number;
  max_ttl_seconds: number;
}

// ===== Progressive tool disclosure (ADR-022, 3b) =====

/**
 * How `/mcp` `tools/list` presents tools for a grant. `full` (default) lists every permitted tool.
 * `progressive` lists only the three meta-tools (`ambassador__search_tools`, ...).
 * Stored on the grant (`NOT NULL DEFAULT 'full'`), chosen by the user at consent or one-shot
 * creation. Never an authorize parameter.
 */
export const DISCLOSURE_MODES = ['full', 'progressive'] as const;
export const disclosureModeSchema = z.enum(DISCLOSURE_MODES);
export type DisclosureMode = z.infer<typeof disclosureModeSchema>;

/** ADR-022 P1: downstream tools whose name starts with this prefix are hidden and flagged */
export const RESERVED_TOOL_PREFIX = TOOL_PIN_RESERVED_NAME_PREFIX;
/**
 * The meta-tools are served for BOTH modes: in `full` mode they are not listed by tools/list but a
 * `tools/call` of one still works (same authorization path as a direct call).
 */
export const META_TOOL_NAMES = [
  'ambassador__search_tools',
  'ambassador__describe_tool',
  'ambassador__call_tool',
] as const;
export type MetaToolName = (typeof META_TOOL_NAMES)[number];

export const SEARCH_TOOLS_DEFAULT_LIMIT = 20;
export const SEARCH_TOOLS_MAX_LIMIT = 50;
export const SEARCH_TOOLS_MAX_QUERY_LENGTH = 200;

/** P2 no recursion: a meta-tool (or any `ambassador__` name) is never a valid target of describe/call */
const notReservedName = z
  .string()
  .min(1)
  .max(256)
  .refine(n => !n.startsWith(RESERVED_TOOL_PREFIX), {
    message: `name must not start with ${RESERVED_TOOL_PREFIX}`,
  });

/** `search_tools` arguments. Matches name and description of tools the grant may call. */
export const searchToolsInputSchema = z.object({
  query: z.string().max(SEARCH_TOOLS_MAX_QUERY_LENGTH),
  /** Restrict to one MCP (its subscription name) */
  mcp: z.string().min(1).max(128).optional(),
  limit: z.number().int().min(1).max(SEARCH_TOOLS_MAX_LIMIT).optional(),
});
export type SearchToolsInput = z.infer<typeof searchToolsInputSchema>;

/** `describe_tool` arguments. `mcp` disambiguates a name served by several MCPs (ADR-022 P3). */
export const describeToolInputSchema = z.object({
  name: notReservedName,
  mcp: z.string().min(1).max(128).optional(),
});
export type DescribeToolInput = z.infer<typeof describeToolInputSchema>;

/** `call_tool` arguments. `arguments` is validated server-side against the tool's approved schema. */
export const callToolInputSchema = z.object({
  name: notReservedName,
  mcp: z.string().min(1).max(128).optional(),
  arguments: z.record(z.string(), z.unknown()).optional(),
});
export type CallToolInput = z.infer<typeof callToolInputSchema>;

/**
 * `search_tools` result entry; `summary` is the first sentence of the approved description
 * (<= 200 chars), sanitized. Derived from T(approved_definition): the description is first truncated
 * to TOOL_SERVE_DESCRIPTION_MAX_CODE_POINTS (ADR-021 D1'), the same as tools/list.
 */
export interface ToolSearchHit {
  name: string;
  mcp: string;
  summary: string;
}
export interface SearchToolsResult {
  tools: ToolSearchHit[];
}

/**
 * `describe_tool` result: the approved (pinned) definition, never the live one. `description` is
 * truncated to TOOL_SERVE_DESCRIPTION_MAX_CODE_POINTS (ADR-021 D1'); schemas are served in full.
 */
export interface DescribeToolResult {
  name: string;
  mcp: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

/** POST /v1/oauth/consent/:requestId (user session + CSRF) */
export const consentDecisionSchema = z
  .object({
    decision: z.enum(['approve', 'deny']),
    /** The user's own ACTIVE Ambassador client this grant binds to (required when approving) */
    bound_client_id: z.string().min(1).optional(),
    /** Granted scopes — must be ⊆ requested ∩ user's subscriptions (server re-checks) */
    scopes: z.array(scopeSchema).max(100),
    /** Optional tool allowlist (fully qualified tool names) */
    tool_allowlist: z.array(z.string().max(256)).max(500).optional(),
    /** Clamped to max_ttl_seconds */
    ttl_seconds: z.number().int().min(60),
    label: z.string().min(1).max(128).optional(),
    /** ADR-022: tool list presentation for this grant; defaults to `full` */
    disclosure_mode: disclosureModeSchema.optional(),
  })
  .refine(d => d.decision === 'deny' || !!d.bound_client_id, {
    message: 'bound_client_id is required when approving',
    path: ['bound_client_id'],
  })
  .refine(d => d.decision === 'deny' || d.scopes.length >= 1, {
    message: 'At least one scope is required when approving',
    path: ['scopes'],
  });
export type ConsentDecision = z.infer<typeof consentDecisionSchema>;

/** Response (envelope data); SPA navigates the browser to redirect_url (code+state, or access_denied) */
export interface ConsentDecisionResponse {
  redirect_url: string;
}
/** Errors (envelope): 404 unknown/expired/used request_id, 403 request bound to another user, 400 invalid scopes. */

// ===== Token endpoint (application/x-www-form-urlencoded) =====

export const tokenRequestSchema = z.discriminatedUnion('grant_type', [
  z.object({
    grant_type: z.literal('authorization_code'),
    code: z.string().min(1),
    redirect_uri: redirectUriSchema,
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
  redirect_uris: z.array(redirectUriSchema).min(1).max(10),
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

/**
 * POST /v1/users/me/agent-grants — one-shot grant for headless/CI; no refresh token.
 * The access token lifetime equals the grant TTL (default agent_endpoint.default_grant_ttl_seconds,
 * max agent_endpoint.max_grant_ttl_seconds); there is no renewal, create a new grant instead.
 */
export const createGrantRequestSchema = z.object({
  /** The user's own ACTIVE Ambassador client this grant binds to */
  bound_client_id: z.string().min(1),
  /** Defaults to "One-shot grant <YYYY-MM-DD>" */
  label: z.string().min(1).max(128).optional(),
  scopes: z.array(scopeSchema).min(1).max(100),
  tool_allowlist: z.array(z.string().max(256)).max(500).optional(),
  ttl_seconds: z.number().int().min(60).optional(),
  /** ADR-022: tool list presentation for this grant; defaults to `full` */
  disclosure_mode: disclosureModeSchema.optional(),
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
  /** OAuth client; null for one-shot grants */
  client_id: string | null;
  client_name: string | null;
  /**
   * Ambassador client the grant is bound to; grant is dead if that client is no longer active.
   * null once the client was deleted (revoke-and-retain: the grant row is kept, revoked).
   */
  bound_client_id: string | null;
  bound_client_name: string | null;
  scopes: string[];
  tool_allowlist: string[] | null;
  /** ADR-022 P4: always present (`full` for grants created before 3b) */
  disclosure_mode: DisclosureMode;
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
/** PATCH /v1/admin/oauth-clients/:clientId → OAuthClientSummary (disables/enables; audited oauth_client_disabled) */
export const adminPatchClientRequestSchema = z.object({ disabled: z.boolean() });
export type AdminPatchClientRequest = z.infer<typeof adminPatchClientRequestSchema>;

/**
 * GET /v1/admin/agent-grants → paginated envelope ({ok,data,pagination:{has_more,total_count,next_cursor}})
 * of AdminAgentGrantSummary. Same cursor/limit convention as other admin lists.
 * DELETE /v1/admin/agent-grants/:grantId → RevokeGrantResponse; audited with the admin identity
 * (agent_grant_revoked, actor = admin, target user in metadata).
 */
export const adminListGrantsQuerySchema = z.object({
  user_id: z.string().optional(),
  include_inactive: z.coerce.boolean().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type AdminListGrantsQuery = z.infer<typeof adminListGrantsQuerySchema>;
export interface AdminAgentGrantSummary extends AgentGrantSummary {
  user_id: string;
  username: string;
  revoked_by: string | null;
}

/** PUT /v1/admin/agent-endpoint/settings → AgentEndpointSettings (the updated settings). */
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
  'oauth_client_deleted',
  'agent_endpoint_settings_updated',
  'agent_auth_failure',
  /** ADR-022: ambassador__search_tools / ambassador__describe_tool (query length + hash only) */
  'agent_tool_discovery',
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

// ===== Agent endpoint availability (user API; envelope) =====

/**
 * GET /v1/users/me/agent-endpoint (user session) → envelope data. Registered even when the
 * endpoint is disabled (then `{enabled:false, ...}`), so the SPA can hide the Agent access page.
 */
export interface UserAgentEndpointInfo {
  enabled: boolean;
  default_grant_ttl_seconds: number;
  max_grant_ttl_seconds: number;
  refresh_tokens_enabled: boolean;
  /**
   * Canonical MCP resource URL (`resource_base_url` + `/mcp`): the URL to give
   * `claude mcp add --transport http ...`. null when the endpoint is disabled.
   */
  resource_url: string | null;
}
