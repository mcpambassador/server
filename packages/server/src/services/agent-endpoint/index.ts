/**
 * ADR-020 agent endpoint services: built-in OAuth authorization server + agent grants.
 *
 * Security invariants (reviewer checklist):
 *  - raw tokens/codes are never stored or logged (SHA-256 hash only; log `logPrefix`)
 *  - issuer/resource URLs come from config, never the Host header
 *  - auth codes and refresh tokens are single-use; refresh reuse revokes the whole family
 *  - a grant is bound to ONE of the user's Ambassador clients; if that client (or the user)
 *    stops being active the grant is dead on the next verification
 *  - the refresh token lifetime never exceeds the grant's expires_at
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseClient, AgentEndpointConfig, AuditProvider } from '@mcpambassador/core';
import {
  createOAuthClient,
  getOAuthClient,
  listOAuthClients,
  countOAuthClients,
  setOAuthClientDisabled,
  deleteOAuthClient,
  touchOAuthClient,
  createPendingAuthRequest,
  getPendingAuthRequest,
  bindPendingAuthRequest,
  consumePendingAuthRequest,
  createAuthCode,
  consumeAuthCode,
  getAuthCodeAnyState,
  createAgentGrant,
  getAgentGrant,
  listAgentGrantsForUser,
  listAllAgentGrants,
  listGrantIdsForOAuthClient,
  revokeGrantsForOAuthClient,
  compatTransaction,
  revokeAgentGrant,
  revokeGrantsForBoundClient,
  touchAgentGrant,
  getServerSetting,
  setServerSetting,
  insertAgentToken,
  getAgentTokenByHash,
  markRefreshTokenUsed,
  revokeTokenFamily,
  revokeSingleToken,
  listGrantIdsWithLiveRefresh,
  type AgentGrantRecord,
  type OAuthClientRecord,
  logger,
} from '@mcpambassador/core';
import {
  AGENT_MCP_ROUTE,
  OAUTH_PROTECTED_RESOURCE_MCP_ROUTE,
  ACCESS_TOKEN_PREFIX,
  REFRESH_TOKEN_PREFIX,
  PENDING_AUTH_REQUEST_TTL_SECONDS,
  type AuthorizeQuery,
  type TokenRequest,
  type TokenResponse,
  type ConsentDecision,
  type ConsentDecisionResponse,
  type ConsentDetails,
  type ClientRegistrationRequest,
  type ClientRegistrationResponse,
  type RevokeRequest,
  type CreateGrantRequest,
  type CreateGrantResponse,
  type AgentGrantSummary,
  type AdminAgentGrantSummary,
  type OAuthClientSummary,
  type AgentEndpointSettings,
  type OAuthErrorResponse,
  type AgentAuthFailureReason,
  type AgentAuditAction,
  isAllowedRedirectUri,
} from '@mcpambassador/contracts';
import { generateOpaqueId, generateToken, hashToken, logPrefix, verifyPkceS256 } from './crypto.js';
import { RateLimiter } from './rate-limiter.js';
import { AgentStreamRegistry } from './streams.js';
import {
  getActiveBoundClient,
  listSubscriptionScopes,
  listConsentClients,
  getClientNames,
  getUsernames,
  validateGrantedScopes,
} from './bound-client.js';

export { hashToken, logPrefix } from './crypto.js';
export { AgentStreamRegistry } from './streams.js';

/** Resolved, absolute URLs derived from config/PUBLIC_URL only */
export interface ResolvedAgentEndpointConfig extends AgentEndpointConfig {
  /** https://host:9443 */
  issuer: string;
  /** https://host:8443/mcp (canonical audience) */
  resource: string;
  protectedResourceMetadataUrl: string;
}

/** Mutable runtime settings (admin-togglable); initialised from config, reset on restart */
export interface AgentEndpointRuntime {
  dynamic_client_registration: boolean;
}

export interface AgentEndpointDeps {
  db: DatabaseClient;
  config: ResolvedAgentEndpointConfig;
  audit: AuditProvider;
  runtime: AgentEndpointRuntime;
  limiter: RateLimiter;
  /** In-flight /mcp requests (concurrency cap + abort on revoke) */
  streams: AgentStreamRegistry;
}

export function createAgentEndpointDeps(
  db: DatabaseClient,
  config: ResolvedAgentEndpointConfig,
  audit: AuditProvider
): AgentEndpointDeps {
  return {
    db,
    config,
    audit,
    runtime: { dynamic_client_registration: config.dynamic_client_registration },
    limiter: new RateLimiter(),
    streams: new AgentStreamRegistry(),
  };
}

/** RFC 6749-style error for the OAuth protocol endpoints */
export class OAuthError extends Error {
  constructor(
    public readonly error: OAuthErrorResponse['error'],
    description: string,
    public readonly status: number = 400
  ) {
    super(description);
    this.name = 'OAuthError';
  }
  toBody(): OAuthErrorResponse {
    return { error: this.error, error_description: this.message };
  }
}

/** Envelope-API error (consent, grants, admin) */
export class AgentApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'AgentApiError';
  }
}

/** Principal produced by verifying an agent access token */
export interface AgentPrincipal {
  grant_id: string;
  user_id: string;
  /** Ambassador client the grant is bound to (permissions come from it) */
  bound_client_id: string;
  /** OAuth client; null for one-shot grants */
  oauth_client_id: string | null;
  scopes: string[];
  tool_allowlist: string[] | null;
  expires_at: string;
}

export type VerifyResult =
  | { ok: true; principal: AgentPrincipal }
  | { ok: false; reason: AgentAuthFailureReason };

export function resolveAgentEndpointConfig(
  config: AgentEndpointConfig,
  publicUrls: { issuer: string; agentBaseUrl: string }
): ResolvedAgentEndpointConfig {
  const resource = `${publicUrls.agentBaseUrl}${AGENT_MCP_ROUTE}`;
  return {
    ...config,
    issuer: publicUrls.issuer,
    resource,
    protectedResourceMetadataUrl: `${publicUrls.agentBaseUrl}${OAUTH_PROTECTED_RESOURCE_MCP_ROUTE}`,
  };
}

// ===== Audit =====

export interface AgentAuditContext {
  user_id?: string;
  /** Ambassador client the grant is bound to */
  bound_client_id?: string;
  source_ip?: string;
  severity?: 'info' | 'warn' | 'error';
  metadata?: Record<string, unknown>;
}

export async function emitAgentAudit(
  deps: Pick<AgentEndpointDeps, 'audit'>,
  action: AgentAuditAction,
  ctx: AgentAuditContext
): Promise<void> {
  try {
    await deps.audit.emit({
      event_id: randomUUID(),
      timestamp: new Date().toISOString(),
      event_type: action === 'agent_auth_failure' ? 'auth_failure' : 'admin_action',
      severity: ctx.severity ?? 'info',
      ...(ctx.user_id ? { user_id: ctx.user_id } : {}),
      ...(ctx.bound_client_id ? { client_id: ctx.bound_client_id } : {}),
      source_ip: ctx.source_ip ?? 'unknown',
      action,
      metadata: {
        ...(ctx.bound_client_id ? { bound_client_id: ctx.bound_client_id } : {}),
        auth_via: 'agent_oauth',
        ...ctx.metadata,
      },
    });
  } catch (err) {
    // Audit failure must not break the OAuth flow, but must be visible
    logger.error(`[AgentEndpoint] audit emit failed for ${action}: ${String(err)}`);
  }
}

// ===== Helpers =====

const isoIn = (seconds: number, from: number = Date.now()): string =>
  new Date(from + seconds * 1000).toISOString();

function clampTtl(deps: AgentEndpointDeps, requested: number | undefined): number {
  const c = deps.config;
  return Math.min(requested ?? c.default_grant_ttl_seconds, c.max_grant_ttl_seconds);
}

export function parseScopeString(scope: string | undefined): string[] {
  if (!scope) return ['mcp:*'];
  const parts = [...new Set(scope.split(/\s+/).filter(Boolean))];
  return parts.length ? parts : ['mcp:*'];
}

/** Drops C0 control chars and DEL (client names are rendered in the consent UI and audit log) */
function stripControlChars(v: string): string {
  return [...v].filter(ch => ch.charCodeAt(0) > 0x1f && ch.charCodeAt(0) !== 0x7f).join('');
}

const SCOPE_RE = /^mcp:(\*|[A-Za-z0-9_.-]{1,128})$/;

/** Redirect URIs: https or loopback http only (ADR-020 §5b); single source of truth lives in contracts */
export const isAcceptableRedirectUri = isAllowedRedirectUri;

function toGrantSummary(
  g: AgentGrantRecord,
  oauthNames: Map<string, string>,
  boundNames: Map<string, string>,
  liveRefresh: Set<string>
): AgentGrantSummary {
  return {
    grant_id: g.grant_id,
    label: g.label,
    client_id: g.client_id,
    client_name: g.client_id ? (oauthNames.get(g.client_id) ?? null) : null,
    bound_client_id: g.bound_client_id,
    bound_client_name: g.bound_client_id ? (boundNames.get(g.bound_client_id) ?? null) : null,
    scopes: g.scopes,
    tool_allowlist: g.tool_allowlist,
    disclosure_mode: 'full', // placeholder until 3b server PR (ADR-022 P4)
    resource: g.resource,
    created_at: g.created_at,
    expires_at: g.expires_at,
    last_used_at: g.last_used_at,
    revoked_at: g.revoked_at,
    has_refresh_token: liveRefresh.has(g.grant_id),
  };
}

async function summarize(
  deps: AgentEndpointDeps,
  grants: AgentGrantRecord[]
): Promise<AgentGrantSummary[]> {
  const oauthIds = [...new Set(grants.map(g => g.client_id).filter((x): x is string => !!x))];
  const oauthNames = new Map<string, string>();
  for (const id of oauthIds) {
    const c = await getOAuthClient(deps.db, id);
    if (c) oauthNames.set(id, c.client_name);
  }
  const boundNames = await getClientNames(deps.db, [
    ...new Set(grants.map(g => g.bound_client_id).filter((x): x is string => !!x)),
  ]);
  const live = await listGrantIdsWithLiveRefresh(
    deps.db,
    grants.map(g => g.grant_id)
  );
  return grants.map(g => toGrantSummary(g, oauthNames, boundNames, live));
}

// ===== Token issuance =====

async function issueAccessToken(
  deps: AgentEndpointDeps,
  grant: AgentGrantRecord,
  familyId: string | null
): Promise<{ raw: string; expiresIn: number }> {
  const grantRemaining = Math.floor((new Date(grant.expires_at).getTime() - Date.now()) / 1000);
  const expiresIn = Math.max(1, Math.min(deps.config.access_token_ttl_seconds, grantRemaining));
  const raw = generateToken(ACCESS_TOKEN_PREFIX);
  await insertAgentToken(deps.db, {
    token_hash: hashToken(raw),
    kind: 'access',
    grant_id: grant.grant_id,
    family_id: familyId,
    expires_at: isoIn(expiresIn),
  });
  return { raw, expiresIn };
}

async function issueRefreshToken(
  deps: AgentEndpointDeps,
  grant: AgentGrantRecord,
  familyId: string
): Promise<string> {
  const raw = generateToken(REFRESH_TOKEN_PREFIX);
  // Refresh lifetime is capped by the grant's own expiry
  await insertAgentToken(deps.db, {
    token_hash: hashToken(raw),
    kind: 'refresh',
    grant_id: grant.grant_id,
    family_id: familyId,
    expires_at: grant.expires_at,
  });
  return raw;
}

// ===== Verification (used by /mcp in P5) =====

/**
 * The single token validator for /mcp (S2). Every request re-reads token, grant, bound client and
 * user from the DB (no cache): token not revoked/expired; grant not revoked/expired; audience is
 * the canonical /mcp resource; OAuth client enabled; bound client present, active, unexpired and
 * owned by grant.user_id; user active. A null bound_client_id (client deleted) is a dead grant.
 */
export async function validateAgentToken(
  deps: AgentEndpointDeps,
  rawToken: string
): Promise<VerifyResult> {
  if (!rawToken.startsWith(ACCESS_TOKEN_PREFIX)) return { ok: false, reason: 'bad_token' };
  const tok = await getAgentTokenByHash(deps.db, hashToken(rawToken));
  if (!tok || tok.kind !== 'access') return { ok: false, reason: 'bad_token' };
  if (tok.revoked_at) return { ok: false, reason: 'revoked' };
  if (new Date(tok.expires_at).getTime() <= Date.now()) return { ok: false, reason: 'expired' };
  const grant = await getAgentGrant(deps.db, tok.grant_id);
  if (!grant) return { ok: false, reason: 'bad_token' };
  if (grant.revoked_at) return { ok: false, reason: 'revoked' };
  if (new Date(grant.expires_at).getTime() <= Date.now()) return { ok: false, reason: 'expired' };
  if (grant.resource !== deps.config.resource) return { ok: false, reason: 'bad_audience' };
  // Only one-shot grants may lack an OAuth client. An 'oauth' grant whose client was deleted
  // (client_id nulled by the FK) is dead, not one-shot.
  if (grant.kind !== 'one_shot') {
    if (!grant.client_id) return { ok: false, reason: 'revoked' };
    const oc = await getOAuthClient(deps.db, grant.client_id);
    if (!oc || oc.disabled) return { ok: false, reason: 'revoked' };
  }
  // Bound-client model: dead as soon as the client/user stops being active
  if (!grant.bound_client_id) return { ok: false, reason: 'revoked' };
  const bound = await getActiveBoundClient(deps.db, grant.user_id, grant.bound_client_id);
  if (!bound) return { ok: false, reason: 'revoked' };
  return {
    ok: true,
    principal: {
      grant_id: grant.grant_id,
      user_id: grant.user_id,
      bound_client_id: grant.bound_client_id ?? undefined,
      oauth_client_id: grant.client_id,
      scopes: grant.scopes,
      tool_allowlist: grant.tool_allowlist,
      expires_at: grant.expires_at,
    },
  };
}

/** @deprecated alias kept for callers; use validateAgentToken */
export const verifyAccessToken = validateAgentToken;

/** Best-effort last_used bookkeeping (never throws) */
export async function touchGrant(deps: AgentEndpointDeps, grantId: string): Promise<void> {
  try {
    await touchAgentGrant(deps.db, grantId);
  } catch {
    /* ignore */
  }
}

// ===== Metadata =====

export function buildAuthorizationServerMetadata(deps: AgentEndpointDeps): Record<string, unknown> {
  const iss = deps.config.issuer;
  return {
    issuer: iss,
    authorization_endpoint: `${iss}/oauth/authorize`,
    token_endpoint: `${iss}/oauth/token`,
    ...(deps.runtime.dynamic_client_registration
      ? { registration_endpoint: `${iss}/oauth/register` }
      : {}),
    revocation_endpoint: `${iss}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: deps.config.refresh_tokens_enabled
      ? ['authorization_code', 'refresh_token']
      : ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['mcp:*'],
  };
}

// ===== /oauth/authorize =====

export interface AuthorizeResult {
  /** SPA consent route URL (relative) with the request id */
  requestId: string;
}

export async function startAuthorization(
  deps: AgentEndpointDeps,
  q: AuthorizeQuery
): Promise<AuthorizeResult> {
  // client + redirect_uri problems must NOT redirect (RFC 6749 §4.1.2.1)
  const client = await getOAuthClient(deps.db, q.client_id);
  if (!client || client.disabled) throw new OAuthError('invalid_client', 'Unknown client');
  if (!client.redirect_uris.includes(q.redirect_uri)) {
    throw new OAuthError('invalid_request', 'redirect_uri is not registered for this client');
  }
  if (q.resource !== deps.config.resource) {
    throw new OAuthError('invalid_target', 'resource does not match this server');
  }
  const scopes = parseScopeString(q.scope);
  if (scopes.some(s => !SCOPE_RE.test(s))) throw new OAuthError('invalid_scope', 'Malformed scope');
  const requestId = generateOpaqueId();
  await createPendingAuthRequest(deps.db, {
    request_id: requestId,
    user_id: null,
    client_id: client.client_id,
    redirect_uri: q.redirect_uri,
    code_challenge: q.code_challenge,
    requested_scopes: scopes,
    resource: q.resource,
    state: q.state ?? null,
    expires_at: isoIn(PENDING_AUTH_REQUEST_TTL_SECONDS),
    used_at: null,
  });
  return { requestId };
}

// ===== Consent =====

async function bindOrFail(deps: AgentEndpointDeps, userId: string, requestId: string) {
  const pending = await getPendingAuthRequest(deps.db, requestId);
  if (!pending || pending.used_at || new Date(pending.expires_at).getTime() <= Date.now()) {
    throw new AgentApiError(404, 'not_found', 'Authorization request not found or expired');
  }
  if (!(await bindPendingAuthRequest(deps.db, requestId, userId))) {
    throw new AgentApiError(403, 'forbidden', 'This authorization request belongs to another user');
  }
  return pending;
}

export async function getConsentDetails(
  deps: AgentEndpointDeps,
  userId: string,
  requestId: string
): Promise<ConsentDetails> {
  const pending = await bindOrFail(deps, userId, requestId);
  const oc = await getOAuthClient(deps.db, pending.client_id);
  if (!oc || oc.disabled) {
    throw new AgentApiError(404, 'not_found', 'Authorization request not found or expired');
  }
  return {
    client_name: oc.client_name,
    client_verified: oc.registered_via === 'admin',
    redirect_uri_host: new URL(pending.redirect_uri).host,
    requested_scopes: pending.requested_scopes,
    clients: await listConsentClients(deps.db, userId),
    default_ttl_seconds: deps.config.default_grant_ttl_seconds,
    max_ttl_seconds: deps.config.max_grant_ttl_seconds,
  };
}

function redirectWith(base: string, params: Record<string, string | undefined>): string {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}

export async function decideConsent(
  deps: AgentEndpointDeps,
  userId: string,
  requestId: string,
  req: ConsentDecision,
  sourceIp: string = 'unknown'
): Promise<ConsentDecisionResponse> {
  const pending = await bindOrFail(deps, userId, requestId);
  const oc = await getOAuthClient(deps.db, pending.client_id);
  if (!oc || oc.disabled) {
    throw new AgentApiError(404, 'not_found', 'Authorization request not found or expired');
  }

  if (req.decision === 'deny') {
    if (!(await consumePendingAuthRequest(deps.db, requestId))) {
      throw new AgentApiError(404, 'not_found', 'Authorization request not found or expired');
    }
    return {
      redirect_url: redirectWith(pending.redirect_uri, {
        error: 'access_denied',
        state: pending.state ?? undefined,
      }),
    };
  }

  // Validate everything BEFORE consuming so a fixable mistake doesn't burn the request
  const bound = await getActiveBoundClient(deps.db, userId, req.bound_client_id ?? '');
  if (!bound) {
    throw new AgentApiError(
      400,
      'validation_error',
      'bound_client_id must be one of your active clients'
    );
  }
  const subs = await listSubscriptionScopes(deps.db, bound.client_id);
  const v = validateGrantedScopes(req.scopes, pending.requested_scopes, subs);
  if (!v.ok) throw new AgentApiError(400, 'validation_error', v.error);

  if (!(await consumePendingAuthRequest(deps.db, requestId))) {
    throw new AgentApiError(404, 'not_found', 'Authorization request not found or expired');
  }
  const code = generateToken('amb_ac_');
  await createAuthCode(deps.db, {
    code_hash: hashToken(code),
    user_id: userId,
    client_id: pending.client_id,
    redirect_uri: pending.redirect_uri,
    code_challenge: pending.code_challenge,
    scopes: v.scopes,
    tool_allowlist: req.tool_allowlist?.length ? req.tool_allowlist : null,
    resource: pending.resource,
    bound_client_id: bound.client_id,
    label: req.label ?? oc.client_name,
    ttl_seconds: clampTtl(deps, req.ttl_seconds),
    expires_at: isoIn(deps.config.auth_code_ttl_seconds),
    used_at: null,
  });
  await emitAgentAudit(deps, 'agent_token_issued', {
    user_id: userId,
    bound_client_id: bound.client_id,
    source_ip: sourceIp,
    metadata: {
      stage: 'authorization_code',
      oauth_client_id: pending.client_id,
      scopes: v.scopes,
      token_prefix: logPrefix(code),
    },
  });
  return {
    redirect_url: redirectWith(pending.redirect_uri, {
      code,
      state: pending.state ?? undefined,
    }),
  };
}

// ===== /oauth/token =====

export async function exchangeToken(
  deps: AgentEndpointDeps,
  req: TokenRequest,
  sourceIp: string
): Promise<TokenResponse> {
  if (
    !deps.limiter.allow(
      `token:${sourceIp}:${req.client_id}`,
      deps.config.rate_limits.token_per_minute,
      60_000
    )
  ) {
    throw new OAuthError('temporarily_unavailable', 'Rate limit exceeded', 429);
  }
  const client = await getOAuthClient(deps.db, req.client_id);
  if (!client || client.disabled) throw new OAuthError('invalid_client', 'Unknown client', 401);

  if (req.grant_type === 'authorization_code') return exchangeCode(deps, req, client, sourceIp);
  return exchangeRefresh(deps, req, client, sourceIp);
}

async function exchangeCode(
  deps: AgentEndpointDeps,
  req: Extract<TokenRequest, { grant_type: 'authorization_code' }>,
  client: OAuthClientRecord,
  sourceIp: string
): Promise<TokenResponse> {
  const grantId = randomUUID();
  const code = await consumeAuthCode(deps.db, hashToken(req.code), grantId);
  const bad = (why: string): OAuthError => {
    void emitAgentAudit(deps, 'agent_auth_failure', {
      source_ip: sourceIp,
      severity: 'warn',
      metadata: { stage: 'code_exchange', reason: why, oauth_client_id: client.client_id },
    });
    return new OAuthError('invalid_grant', 'Invalid or expired authorization code');
  };
  if (!code) {
    // RFC 6749 §4.1.2: a replayed code revokes what it already produced.
    const prior = await getAuthCodeAnyState(deps.db, hashToken(req.code));
    if (prior?.used_at && prior.grant_id && prior.client_id === client.client_id) {
      await revokeAgentGrant(deps.db, prior.grant_id, 'system:auth_code_reuse');
      deps.streams.closeGrant(prior.grant_id);
      await emitAgentAudit(deps, 'agent_grant_revoked', {
        user_id: prior.user_id,
        bound_client_id: prior.bound_client_id,
        source_ip: sourceIp,
        severity: 'warn',
        metadata: {
          agent_grant_id: prior.grant_id,
          revoked_by: 'system:auth_code_reuse',
          reason: 'auth_code_reuse',
          oauth_client_id: client.client_id,
        },
      });
      throw bad('code_reuse_revoked_grant');
    }
    throw bad('unknown_or_used_code');
  }
  if (code.client_id !== client.client_id) throw bad('client_mismatch');
  if (code.redirect_uri !== req.redirect_uri) throw bad('redirect_mismatch');
  if (!verifyPkceS256(req.code_verifier, code.code_challenge)) throw bad('pkce_failed');
  if (req.resource !== code.resource || req.resource !== deps.config.resource) {
    throw new OAuthError('invalid_target', 'resource does not match the authorization');
  }
  const bound = await getActiveBoundClient(deps.db, code.user_id, code.bound_client_id);
  if (!bound) throw bad('bound_client_inactive');

  const ttl = Math.min(
    code.ttl_seconds ?? deps.config.default_grant_ttl_seconds,
    deps.config.max_grant_ttl_seconds
  );
  const grant = await createAgentGrant(deps.db, {
    grant_id: grantId,
    user_id: code.user_id,
    client_id: client.client_id,
    kind: 'oauth',
    bound_client_id: code.bound_client_id,
    label: code.label ?? client.client_name,
    scopes: code.scopes,
    tool_allowlist: code.tool_allowlist,
    resource: code.resource,
    expires_at: isoIn(ttl),
  });
  const family = randomUUID();
  const at = await issueAccessToken(deps, grant, family);
  const rt = deps.config.refresh_tokens_enabled
    ? await issueRefreshToken(deps, grant, family)
    : undefined;
  await touchOAuthClient(deps.db, client.client_id);
  await emitAgentAudit(deps, 'agent_grant_created', {
    user_id: grant.user_id,
    bound_client_id: grant.bound_client_id ?? undefined,
    source_ip: sourceIp,
    metadata: {
      agent_grant_id: grant.grant_id,
      oauth_client_id: client.client_id,
      scopes: grant.scopes,
      expires_at: grant.expires_at,
      refresh: !!rt,
    },
  });
  return {
    access_token: at.raw,
    token_type: 'Bearer',
    expires_in: at.expiresIn,
    ...(rt ? { refresh_token: rt } : {}),
    scope: grant.scopes.join(' '),
  };
}

async function exchangeRefresh(
  deps: AgentEndpointDeps,
  req: Extract<TokenRequest, { grant_type: 'refresh_token' }>,
  client: OAuthClientRecord,
  sourceIp: string
): Promise<TokenResponse> {
  if (!deps.config.refresh_tokens_enabled) {
    throw new OAuthError('unauthorized_client', 'Refresh tokens are disabled');
  }
  const invalid = (): OAuthError => new OAuthError('invalid_grant', 'Invalid refresh token');
  const hash = hashToken(req.refresh_token);
  const tok = await getAgentTokenByHash(deps.db, hash);
  if (!tok || tok.kind !== 'refresh') throw invalid();
  const grant = await getAgentGrant(deps.db, tok.grant_id);
  if (!grant || grant.client_id !== client.client_id) throw invalid();

  // Reuse of an already-rotated (or revoked) token => compromise: kill the whole family
  if (tok.used_at || tok.revoked_at) {
    if (tok.family_id) await revokeTokenFamily(deps.db, tok.family_id);
    await emitAgentAudit(deps, 'agent_refresh_reuse_detected', {
      user_id: grant.user_id,
      bound_client_id: grant.bound_client_id ?? undefined,
      source_ip: sourceIp,
      severity: 'warn',
      metadata: {
        agent_grant_id: grant.grant_id,
        oauth_client_id: client.client_id,
        token_prefix: logPrefix(req.refresh_token),
      },
    });
    throw invalid();
  }
  if (grant.revoked_at || new Date(grant.expires_at).getTime() <= Date.now()) throw invalid();
  if (new Date(tok.expires_at).getTime() <= Date.now()) throw invalid();
  if (req.resource && req.resource !== grant.resource) {
    throw new OAuthError('invalid_target', 'resource does not match the grant');
  }
  const bound = grant.bound_client_id
    ? await getActiveBoundClient(deps.db, grant.user_id, grant.bound_client_id)
    : null;
  if (!bound) throw invalid();

  // Atomic single use: a concurrent second use loses and is treated as reuse
  if (!(await markRefreshTokenUsed(deps.db, hash))) {
    if (tok.family_id) await revokeTokenFamily(deps.db, tok.family_id);
    await emitAgentAudit(deps, 'agent_refresh_reuse_detected', {
      user_id: grant.user_id,
      bound_client_id: grant.bound_client_id ?? undefined,
      source_ip: sourceIp,
      severity: 'warn',
      metadata: { agent_grant_id: grant.grant_id, race: true },
    });
    throw invalid();
  }
  const family = tok.family_id ?? randomUUID();
  const at = await issueAccessToken(deps, grant, family);
  const rt = await issueRefreshToken(deps, grant, family);
  await touchOAuthClient(deps.db, client.client_id);
  await emitAgentAudit(deps, 'agent_token_refreshed', {
    user_id: grant.user_id,
    bound_client_id: grant.bound_client_id ?? undefined,
    source_ip: sourceIp,
    metadata: {
      agent_grant_id: grant.grant_id,
      oauth_client_id: client.client_id,
      token_prefix: logPrefix(at.raw),
    },
  });
  return {
    access_token: at.raw,
    token_type: 'Bearer',
    expires_in: at.expiresIn,
    refresh_token: rt,
    scope: grant.scopes.join(' '),
  };
}

// ===== Dynamic / admin client registration =====

async function createClientRecord(
  deps: AgentEndpointDeps,
  req: ClientRegistrationRequest,
  via: 'admin' | 'dcr'
): Promise<OAuthClientRecord> {
  if (req.grant_types && !req.grant_types.includes('authorization_code')) {
    throw new OAuthError('invalid_client_metadata', 'authorization_code grant type is required');
  }
  for (const uri of req.redirect_uris) {
    if (!isAcceptableRedirectUri(uri)) {
      throw new OAuthError('invalid_redirect_uri', `Unacceptable redirect_uri: ${uri}`);
    }
  }
  // The cap bounds unauthenticated DCR; admin-registered clients don't count toward it.
  if (via === 'dcr' && (await countOAuthClients(deps.db, 'dcr')) >= deps.config.max_oauth_clients) {
    throw new OAuthError('temporarily_unavailable', 'Client registration limit reached', 503);
  }
  return createOAuthClient(deps.db, {
    client_id: randomUUID(),
    client_name: stripControlChars(req.client_name).trim() || 'Unnamed client',
    redirect_uris: [...new Set(req.redirect_uris)],
    registered_via: via,
    disabled: false,
  });
}

export async function registerClient(
  deps: AgentEndpointDeps,
  req: ClientRegistrationRequest,
  sourceIp: string
): Promise<ClientRegistrationResponse> {
  if (!deps.runtime.dynamic_client_registration) {
    throw new OAuthError('access_denied', 'Dynamic client registration is disabled', 403);
  }
  if (
    !deps.limiter.allow(
      `register:${sourceIp}`,
      deps.config.rate_limits.register_per_hour,
      3_600_000
    )
  ) {
    throw new OAuthError('temporarily_unavailable', 'Rate limit exceeded', 429);
  }
  const c = await createClientRecord(deps, req, 'dcr');
  await emitAgentAudit(deps, 'oauth_client_registered', {
    source_ip: sourceIp,
    metadata: { oauth_client_id: c.client_id, client_name: c.client_name, via: 'dcr' },
  });
  return {
    client_id: c.client_id,
    client_name: c.client_name,
    redirect_uris: c.redirect_uris,
    grant_types: deps.config.refresh_tokens_enabled
      ? ['authorization_code', 'refresh_token']
      : ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    client_id_issued_at: Math.floor(new Date(c.created_at).getTime() / 1000),
  };
}

// ===== Revocation (RFC 7009) =====

export async function revokeToken(
  deps: AgentEndpointDeps,
  req: RevokeRequest,
  sourceIp: string = 'unknown'
): Promise<void> {
  const hash = hashToken(req.token);
  const tok = await getAgentTokenByHash(deps.db, hash);
  if (!tok) return; // RFC 7009: unknown tokens are not an error
  const grant = await getAgentGrant(deps.db, tok.grant_id);
  // Only the client the token was issued to may revoke it
  if (!grant || grant.client_id !== req.client_id) return;
  if (tok.kind === 'refresh' && tok.family_id) await revokeTokenFamily(deps.db, tok.family_id);
  else await revokeSingleToken(deps.db, hash);
  deps.streams.closeGrant(grant.grant_id);
  await emitAgentAudit(deps, 'agent_token_revoked', {
    user_id: grant.user_id,
    bound_client_id: grant.bound_client_id ?? undefined,
    source_ip: sourceIp,
    metadata: {
      agent_grant_id: grant.grant_id,
      kind: tok.kind,
      token_prefix: logPrefix(req.token),
    },
  });
}

// ===== One-shot grants (user API) =====

export async function createGrant(
  deps: AgentEndpointDeps,
  userId: string,
  req: CreateGrantRequest,
  sourceIp: string = 'unknown'
): Promise<CreateGrantResponse> {
  const bound = await getActiveBoundClient(deps.db, userId, req.bound_client_id);
  if (!bound) {
    throw new AgentApiError(
      400,
      'validation_error',
      'bound_client_id must be one of your active clients'
    );
  }
  const subs = await listSubscriptionScopes(deps.db, bound.client_id);
  const v = validateGrantedScopes(req.scopes, null, subs);
  if (!v.ok) throw new AgentApiError(400, 'validation_error', v.error);
  const grant = await createAgentGrant(deps.db, {
    grant_id: randomUUID(),
    user_id: userId,
    client_id: null,
    kind: 'one_shot',
    bound_client_id: bound.client_id,
    label: req.label ?? `One-shot grant ${new Date().toISOString().slice(0, 10)}`,
    scopes: v.scopes,
    tool_allowlist: req.tool_allowlist?.length ? req.tool_allowlist : null,
    resource: deps.config.resource,
    expires_at: isoIn(clampTtl(deps, req.ttl_seconds)),
  });
  // One-shot: no refresh token; the access token lives as long as the grant (capped)
  const raw = generateToken(ACCESS_TOKEN_PREFIX);
  await insertAgentToken(deps.db, {
    token_hash: hashToken(raw),
    kind: 'access',
    grant_id: grant.grant_id,
    family_id: null,
    expires_at: grant.expires_at,
  });
  await emitAgentAudit(deps, 'agent_grant_created', {
    user_id: userId,
    bound_client_id: bound.client_id,
    source_ip: sourceIp,
    metadata: {
      agent_grant_id: grant.grant_id,
      one_shot: true,
      scopes: grant.scopes,
      expires_at: grant.expires_at,
    },
  });
  return {
    grant_id: grant.grant_id,
    access_token: raw,
    token_type: 'Bearer',
    expires_at: grant.expires_at,
    resource: grant.resource,
    scopes: grant.scopes,
  };
}

export async function listGrants(
  deps: AgentEndpointDeps,
  userId: string
): Promise<AgentGrantSummary[]> {
  return summarize(deps, await listAgentGrantsForUser(deps.db, userId));
}

/** Revokes a grant. Users may only revoke their own; admins any (audited with the admin identity). */
export async function revokeGrant(
  deps: AgentEndpointDeps,
  actor: { user_id: string; admin: boolean },
  grantId: string,
  sourceIp: string = 'unknown'
): Promise<{ grant_id: string; revoked_at: string }> {
  const grant = await getAgentGrant(deps.db, grantId);
  // Do not reveal other users' grants to non-admins
  if (!grant || (!actor.admin && grant.user_id !== actor.user_id)) {
    throw new AgentApiError(404, 'not_found', 'Grant not found');
  }
  if (!grant.revoked_at) {
    await revokeAgentGrant(deps.db, grantId, actor.user_id);
    deps.streams.closeGrant(grantId);
    await emitAgentAudit(deps, 'agent_grant_revoked', {
      user_id: actor.user_id,
      bound_client_id: grant.bound_client_id ?? undefined,
      source_ip: sourceIp,
      metadata: {
        agent_grant_id: grantId,
        target_user_id: grant.user_id,
        by_admin: actor.admin && grant.user_id !== actor.user_id,
      },
    });
  }
  const after = await getAgentGrant(deps.db, grantId);
  return { grant_id: grantId, revoked_at: after?.revoked_at ?? new Date().toISOString() };
}

// ===== Admin =====

const toClientSummary = (c: OAuthClientRecord): OAuthClientSummary => ({
  client_id: c.client_id,
  client_name: c.client_name,
  redirect_uris: c.redirect_uris,
  registered_via: c.registered_via,
  created_at: c.created_at,
  last_used_at: c.last_used_at,
  disabled: c.disabled,
});

export async function adminListClients(deps: AgentEndpointDeps): Promise<OAuthClientSummary[]> {
  return (await listOAuthClients(deps.db)).map(toClientSummary);
}

export async function adminCreateClient(
  deps: AgentEndpointDeps,
  adminUserId: string,
  req: ClientRegistrationRequest,
  sourceIp: string
): Promise<OAuthClientSummary> {
  let c: OAuthClientRecord;
  try {
    c = await createClientRecord(deps, req, 'admin');
  } catch (e) {
    if (e instanceof OAuthError) {
      throw new AgentApiError(e.status === 503 ? 409 : 400, 'validation_error', e.message);
    }
    throw e;
  }
  await emitAgentAudit(deps, 'oauth_client_registered', {
    user_id: adminUserId,
    source_ip: sourceIp,
    metadata: { oauth_client_id: c.client_id, client_name: c.client_name, via: 'admin' },
  });
  return toClientSummary(c);
}

export async function adminSetClientDisabled(
  deps: AgentEndpointDeps,
  adminUserId: string,
  clientId: string,
  disabled: boolean,
  sourceIp: string
): Promise<OAuthClientSummary> {
  const c = await getOAuthClient(deps.db, clientId);
  if (!c) throw new AgentApiError(404, 'not_found', 'OAuth client not found');
  await setOAuthClientDisabled(deps.db, clientId, disabled);
  if (disabled) {
    // validateAgentToken already refuses a disabled client; also cut streams that are open now.
    // Grants are kept (not revoked) so re-enabling restores access.
    for (const id of await listGrantIdsForOAuthClient(deps.db, clientId)) {
      deps.streams.closeGrant(id);
    }
  }
  await emitAgentAudit(deps, 'oauth_client_disabled', {
    user_id: adminUserId,
    source_ip: sourceIp,
    metadata: { oauth_client_id: clientId, disabled },
  });
  return toClientSummary({ ...c, disabled });
}

/**
 * Deleting a client: disable it first (no new tokens/requests), then revoke-and-retain every grant
 * issued to it and delete the client in one transaction (no grant can be created or missed in
 * between, and none is left live with a nulled client_id). Streams are closed and each grant is
 * audited as agent_grant_revoked after the commit.
 */
export async function adminDeleteClient(
  deps: AgentEndpointDeps,
  adminUserId: string,
  clientId: string,
  sourceIp: string
): Promise<void> {
  const c = await getOAuthClient(deps.db, clientId);
  if (!c) throw new AgentApiError(404, 'not_found', 'OAuth client not found');
  await setOAuthClientDisabled(deps.db, clientId, true);
  const revoked = await compatTransaction(deps.db, async () => {
    const grants = await revokeGrantsForOAuthClient(deps.db, clientId, adminUserId);
    await deleteOAuthClient(deps.db, clientId);
    return grants;
  });
  for (const g of revoked) {
    deps.streams.closeGrant(g.grant_id);
    await emitAgentAudit(deps, 'agent_grant_revoked', {
      user_id: g.user_id,
      bound_client_id: g.bound_client_id ?? undefined,
      source_ip: sourceIp,
      metadata: {
        agent_grant_id: g.grant_id,
        revoked_by: adminUserId,
        reason: 'oauth_client_deleted',
        oauth_client_id: clientId,
      },
    });
  }
  await emitAgentAudit(deps, 'oauth_client_deleted', {
    user_id: adminUserId,
    source_ip: sourceIp,
    metadata: { oauth_client_id: clientId, grants_revoked: revoked.length },
  });
}

export async function adminListGrants(
  deps: AgentEndpointDeps,
  q: { user_id?: string; include_inactive?: boolean; cursor?: string; limit: number }
): Promise<{ items: AdminAgentGrantSummary[]; total: number; next_cursor: string | null }> {
  const now = Date.now();
  let all = await listAllAgentGrants(deps.db);
  if (q.user_id) all = all.filter(g => g.user_id === q.user_id);
  if (!q.include_inactive) {
    all = all.filter(g => !g.revoked_at && new Date(g.expires_at).getTime() > now);
  }
  const offset = Math.max(0, Number.parseInt(q.cursor ?? '0', 10) || 0);
  const page = all.slice(offset, offset + q.limit);
  const summaries = await summarize(deps, page);
  const names = await getUsernames(deps.db, [...new Set(page.map(g => g.user_id))]);
  const items = summaries.map((s, i) => ({
    ...s,
    user_id: page[i]!.user_id,
    username: names.get(page[i]!.user_id) ?? '(deleted user)',
    revoked_by: page[i]!.revoked_by,
  }));
  const next = offset + q.limit < all.length ? String(offset + q.limit) : null;
  return { items, total: all.length, next_cursor: next };
}

export function getSettings(deps: AgentEndpointDeps): AgentEndpointSettings {
  return {
    enabled: deps.config.enabled,
    dynamic_client_registration: deps.runtime.dynamic_client_registration,
  };
}

const SETTING_DCR = 'agent_endpoint.dynamic_client_registration';

/**
 * Applies admin-changed settings persisted in server_settings over the config defaults.
 * Call once at startup after createAgentEndpointDeps(). DB value wins once an admin has set it.
 */
export async function loadPersistedSettings(deps: AgentEndpointDeps): Promise<void> {
  const v = await getServerSetting(deps.db, SETTING_DCR);
  if (v === 'true' || v === 'false') deps.runtime.dynamic_client_registration = v === 'true';
}

export async function updateSettings(
  deps: AgentEndpointDeps,
  adminUserId: string,
  patch: { dynamic_client_registration: boolean },
  sourceIp: string
): Promise<AgentEndpointSettings> {
  const previous = deps.runtime.dynamic_client_registration;
  // Persist first: the DB value wins over the config default from now on (survives restarts)
  await setServerSetting(
    deps.db,
    SETTING_DCR,
    patch.dynamic_client_registration ? 'true' : 'false',
    adminUserId
  );
  deps.runtime.dynamic_client_registration = patch.dynamic_client_registration;
  await emitAgentAudit(deps, 'agent_endpoint_settings_updated', {
    user_id: adminUserId,
    source_ip: sourceIp,
    metadata: {
      setting: 'dynamic_client_registration',
      value: patch.dynamic_client_registration,
      previous,
    },
  });
  return getSettings(deps);
}

/**
 * S5: revoke (and retain) every agent grant bound to a client that was suspended / revoked by
 * an admin or its owner, close their live /mcp streams, and audit each as agent_grant_revoked.
 */
export async function revokeClientGrantsWithAudit(
  deps: {
    db: DatabaseClient;
    audit?: AuditProvider;
    onGrantsRevoked?: (grantIds: string[]) => void;
  },
  clientId: string,
  actor: string,
  sourceIp: string,
  reason: string
): Promise<number> {
  const revoked = await revokeGrantsForBoundClient(deps.db, clientId, actor);
  deps.onGrantsRevoked?.(revoked.map(g => g.grant_id));
  if (deps.audit) {
    for (const g of revoked) {
      await emitAgentAudit({ audit: deps.audit }, 'agent_grant_revoked', {
        user_id: g.user_id,
        bound_client_id: clientId,
        source_ip: sourceIp,
        metadata: { agent_grant_id: g.grant_id, revoked_by: actor, reason },
      });
    }
  }
  return revoked.length;
}
