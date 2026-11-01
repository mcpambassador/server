/**
 * Agent OAuth repositories (ADR-020) — CONTRACT STUBS.
 *
 * Tables (oauth_clients, oauth_pending_requests, agent_grants, agent_tokens, oauth_auth_codes) arrive in P3.
 * Tokens/codes are stored as SHA-256 hashes only; raw values never reach this layer
 * except as a hash argument.
 */

/* eslint-disable @typescript-eslint/require-await */

import type { DatabaseClient } from '../client.js';

export interface OAuthClientRecord {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  registered_via: 'admin' | 'dcr';
  created_at: string;
  last_used_at: string | null;
  disabled: boolean;
}

export interface AgentGrantRecord {
  grant_id: string;
  user_id: string;
  /** null = one-shot grant */
  client_id: string | null;
  label: string;
  scopes: string[];
  tool_allowlist: string[] | null;
  resource: string;
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
}

export type AgentTokenKind = 'access' | 'refresh';

export interface AgentTokenRecord {
  token_hash: string;
  kind: AgentTokenKind;
  grant_id: string;
  /** Refresh family id (refresh tokens rotate within a family) */
  family_id: string | null;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}

export interface AuthCodeRecord {
  code_hash: string;
  user_id: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scopes: string[];
  tool_allowlist: string[] | null;
  resource: string;
  label: string | null;
  ttl_seconds: number | null;
  expires_at: string;
  used_at: string | null;
}

function notImplemented(name: string): never {
  throw new Error(`agent-oauth repository: ${name} not implemented (ADR-020 P3)`);
}

// ---- oauth_clients ----
export async function createOAuthClient(
  _db: DatabaseClient,
  _data: Omit<OAuthClientRecord, 'created_at' | 'last_used_at'>
): Promise<OAuthClientRecord> {
  return notImplemented('createOAuthClient');
}
export async function getOAuthClient(
  _db: DatabaseClient,
  _clientId: string
): Promise<OAuthClientRecord | null> {
  return notImplemented('getOAuthClient');
}
export async function listOAuthClients(_db: DatabaseClient): Promise<OAuthClientRecord[]> {
  return notImplemented('listOAuthClients');
}
export async function countOAuthClients(_db: DatabaseClient): Promise<number> {
  return notImplemented('countOAuthClients');
}
export async function setOAuthClientDisabled(
  _db: DatabaseClient,
  _clientId: string,
  _disabled: boolean
): Promise<void> {
  return notImplemented('setOAuthClientDisabled');
}

export interface PendingAuthRequestRecord {
  request_id: string;
  /** Set when the user first opens consent; subsequent users get 403 */
  user_id: string | null;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  requested_scopes: string[];
  resource: string;
  state: string | null;
  expires_at: string;
  used_at: string | null;
}

// ---- pending authorize requests (oauth_pending_requests) ----
export async function createPendingAuthRequest(
  _db: DatabaseClient,
  _data: PendingAuthRequestRecord
): Promise<void> {
  return notImplemented('createPendingAuthRequest');
}
export async function getPendingAuthRequest(
  _db: DatabaseClient,
  _requestId: string
): Promise<PendingAuthRequestRecord | null> {
  return notImplemented('getPendingAuthRequest');
}
/** Binds request to user on first open; returns false if bound to someone else */
export async function bindPendingAuthRequest(
  _db: DatabaseClient,
  _requestId: string,
  _userId: string
): Promise<boolean> {
  return notImplemented('bindPendingAuthRequest');
}
/** Atomically marks used; null if missing/expired/used */
export async function consumePendingAuthRequest(
  _db: DatabaseClient,
  _requestId: string
): Promise<PendingAuthRequestRecord | null> {
  return notImplemented('consumePendingAuthRequest');
}

// ---- oauth_auth_codes ----
export async function createAuthCode(_db: DatabaseClient, _data: AuthCodeRecord): Promise<void> {
  return notImplemented('createAuthCode');
}
/** Atomically marks used; returns null if missing, expired or already used */
export async function consumeAuthCode(
  _db: DatabaseClient,
  _codeHash: string
): Promise<AuthCodeRecord | null> {
  return notImplemented('consumeAuthCode');
}

// ---- agent_grants ----
export async function createAgentGrant(
  _db: DatabaseClient,
  _data: Omit<AgentGrantRecord, 'created_at' | 'last_used_at' | 'revoked_at' | 'revoked_by'>
): Promise<AgentGrantRecord> {
  return notImplemented('createAgentGrant');
}
export async function getAgentGrant(
  _db: DatabaseClient,
  _grantId: string
): Promise<AgentGrantRecord | null> {
  return notImplemented('getAgentGrant');
}
export async function listAgentGrantsForUser(
  _db: DatabaseClient,
  _userId: string
): Promise<AgentGrantRecord[]> {
  return notImplemented('listAgentGrantsForUser');
}
/** Revokes grant and every token of it */
export async function revokeAgentGrant(
  _db: DatabaseClient,
  _grantId: string,
  _revokedBy: string
): Promise<void> {
  return notImplemented('revokeAgentGrant');
}
export async function revokeAllAgentGrantsForUser(
  _db: DatabaseClient,
  _userId: string,
  _revokedBy: string
): Promise<number> {
  return notImplemented('revokeAllAgentGrantsForUser');
}
export async function touchAgentGrant(_db: DatabaseClient, _grantId: string): Promise<void> {
  return notImplemented('touchAgentGrant');
}

// ---- agent_tokens ----
export async function insertAgentToken(
  _db: DatabaseClient,
  _data: Omit<AgentTokenRecord, 'created_at' | 'used_at'>
): Promise<void> {
  return notImplemented('insertAgentToken');
}
export async function getAgentTokenByHash(
  _db: DatabaseClient,
  _tokenHash: string
): Promise<AgentTokenRecord | null> {
  return notImplemented('getAgentTokenByHash');
}
/** Marks a refresh token used; returns false if it was already used (=> reuse detection) */
export async function markRefreshTokenUsed(
  _db: DatabaseClient,
  _tokenHash: string
): Promise<boolean> {
  return notImplemented('markRefreshTokenUsed');
}
export async function revokeTokenFamily(_db: DatabaseClient, _familyId: string): Promise<void> {
  return notImplemented('revokeTokenFamily');
}
export async function deleteAgentToken(_db: DatabaseClient, _tokenHash: string): Promise<void> {
  return notImplemented('deleteAgentToken');
}
/** Sweep expired codes/tokens/grants; returns rows removed */
export async function sweepExpiredAgentRecords(_db: DatabaseClient, _now: Date): Promise<number> {
  return notImplemented('sweepExpiredAgentRecords');
}
