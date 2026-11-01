/**
 * ADR-020 service contracts — STUBS.
 *
 * Planned modules (names fixed here so tests and callers can rely on them):
 *  - tool-service.ts    listToolsForSession / invokeToolForSession — shared by /v1/tools,
 *                       /v1/tools/invoke and /mcp (refactor lands before any new route)
 *  - token-service.ts   issueAccessToken, issueRefreshToken, verifyAccessToken, rotateRefreshToken,
 *                       revokeToken, hashToken
 *  - grant-service.ts   createGrant, listGrants, revokeGrant, revokeAllForUser
 *  - oauth-service.ts   buildAuthorizationCode, exchangeAuthorizationCode, registerClient
 *  - config.ts          resolveAgentEndpointConfig (issuer/resource URLs from PUBLIC_URL, never Host)
 */

/* eslint-disable @typescript-eslint/require-await */

import type { DatabaseClient, AgentEndpointConfig } from '@mcpambassador/core';
import { AGENT_MCP_ROUTE, OAUTH_PROTECTED_RESOURCE_MCP_ROUTE } from '@mcpambassador/contracts';
import type {
  TokenRequest,
  TokenResponse,
  ConsentRequest,
  ConsentResponse,
  ClientRegistrationRequest,
  ClientRegistrationResponse,
  RevokeRequest,
  CreateGrantRequest,
  CreateGrantResponse,
  AgentGrantSummary,
  AgentAuthFailureReason,
} from '@mcpambassador/contracts';

export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what} not implemented (ADR-020)`);
    this.name = 'NotImplementedError';
  }
}

/** Resolved, absolute URLs derived from config/PUBLIC_URL only */
export interface ResolvedAgentEndpointConfig extends AgentEndpointConfig {
  /** https://host:9443 */
  issuer: string;
  /** https://host:8443/mcp (canonical audience) */
  resource: string;
  protectedResourceMetadataUrl: string;
}

export interface AgentEndpointDeps {
  db: DatabaseClient;
  config: ResolvedAgentEndpointConfig;
}

/** Principal produced by verifying an agent access token */
export interface AgentPrincipal {
  grant_id: string;
  user_id: string;
  client_id: string | null;
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

export async function verifyAccessToken(
  _deps: AgentEndpointDeps,
  _rawToken: string
): Promise<VerifyResult> {
  throw new NotImplementedError('verifyAccessToken');
}
export async function exchangeToken(
  _deps: AgentEndpointDeps,
  _req: TokenRequest,
  _sourceIp: string
): Promise<TokenResponse> {
  throw new NotImplementedError('exchangeToken');
}
export async function approveConsent(
  _deps: AgentEndpointDeps,
  _userId: string,
  _req: ConsentRequest
): Promise<ConsentResponse> {
  throw new NotImplementedError('approveConsent');
}
export async function registerClient(
  _deps: AgentEndpointDeps,
  _req: ClientRegistrationRequest,
  _sourceIp: string
): Promise<ClientRegistrationResponse> {
  throw new NotImplementedError('registerClient');
}
export async function revokeToken(_deps: AgentEndpointDeps, _req: RevokeRequest): Promise<void> {
  throw new NotImplementedError('revokeToken');
}
export async function createGrant(
  _deps: AgentEndpointDeps,
  _userId: string,
  _req: CreateGrantRequest
): Promise<CreateGrantResponse> {
  throw new NotImplementedError('createGrant');
}
export async function listGrants(
  _deps: AgentEndpointDeps,
  _userId: string
): Promise<AgentGrantSummary[]> {
  throw new NotImplementedError('listGrants');
}
export async function revokeGrant(
  _deps: AgentEndpointDeps,
  _userId: string,
  _grantId: string
): Promise<void> {
  throw new NotImplementedError('revokeGrant');
}
