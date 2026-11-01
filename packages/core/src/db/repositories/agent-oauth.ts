/**
 * Agent OAuth repositories (ADR-020).
 *
 * Tables: oauth_clients, oauth_pending_requests, oauth_auth_codes, agent_grants, agent_tokens.
 * Tokens/codes are stored as SHA-256 hashes only; raw values never reach this layer
 * except as a hash argument.
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/require-await */

import { eq, and, lt, gt, isNull, inArray } from 'drizzle-orm';
import type { DatabaseClient } from '../client.js';
import {
  oauth_clients,
  oauth_pending_requests,
  oauth_auth_codes,
  agent_grants,
  agent_tokens,
  server_settings,
} from '../../schema/index.js';
import {
  compatInsert,
  compatSelect,
  compatUpdate,
  compatDelete,
  compatTransaction,
} from '../compat.js';

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
  /** OAuth client; null = one-shot grant */
  client_id: string | null;
  /** Ambassador client the grant is bound to (permissions come from it) */
  bound_client_id: string | null;
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
  /** Set when the token (or its grant/family) was revoked; distinguishes revoked from unknown */
  revoked_at: string | null;
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
  bound_client_id: string;
  label: string | null;
  ttl_seconds: number | null;
  expires_at: string;
  used_at: string | null;
}

const now = (): string => new Date().toISOString();
const j = (v: unknown): string => JSON.stringify(v);
const parseArr = (v: string | null): string[] | null =>
  v == null ? null : (JSON.parse(v) as string[]);

// ---- row mappers ----
function toClient(r: any): OAuthClientRecord {
  return {
    client_id: r.client_id,
    client_name: r.client_name,
    redirect_uris: JSON.parse(r.redirect_uris) as string[],
    registered_via: r.registered_via,
    created_at: r.created_at,
    last_used_at: r.last_used_at ?? null,
    disabled: Boolean(r.disabled),
  };
}
function toGrant(r: any): AgentGrantRecord {
  return {
    grant_id: r.grant_id,
    user_id: r.user_id,
    client_id: r.client_id ?? null,
    bound_client_id: r.bound_client_id ?? null,
    label: r.label,
    scopes: JSON.parse(r.scopes) as string[],
    tool_allowlist: parseArr(r.tool_allowlist),
    resource: r.resource,
    created_at: r.created_at,
    expires_at: r.expires_at,
    last_used_at: r.last_used_at ?? null,
    revoked_at: r.revoked_at ?? null,
    revoked_by: r.revoked_by ?? null,
  };
}
function toPending(r: any): PendingAuthRequestRecord {
  return {
    request_id: r.request_id,
    user_id: r.user_id ?? null,
    client_id: r.client_id,
    redirect_uri: r.redirect_uri,
    code_challenge: r.code_challenge,
    requested_scopes: JSON.parse(r.requested_scopes) as string[],
    resource: r.resource,
    state: r.state ?? null,
    expires_at: r.expires_at,
    used_at: r.used_at ?? null,
  };
}
function toCode(r: any): AuthCodeRecord {
  return {
    code_hash: r.code_hash,
    user_id: r.user_id,
    client_id: r.client_id,
    redirect_uri: r.redirect_uri,
    code_challenge: r.code_challenge,
    scopes: JSON.parse(r.scopes) as string[],
    tool_allowlist: parseArr(r.tool_allowlist),
    resource: r.resource,
    bound_client_id: r.bound_client_id,
    label: r.label ?? null,
    ttl_seconds: r.ttl_seconds ?? null,
    expires_at: r.expires_at,
    used_at: r.used_at ?? null,
  };
}
function toToken(r: any): AgentTokenRecord {
  return {
    token_hash: r.token_hash,
    kind: r.kind,
    grant_id: r.grant_id,
    family_id: r.family_id ?? null,
    expires_at: r.expires_at,
    used_at: r.used_at ?? null,
    revoked_at: r.revoked_at ?? null,
    created_at: r.created_at,
  };
}

// ---- oauth_clients ----
export async function createOAuthClient(
  db: DatabaseClient,
  data: Omit<OAuthClientRecord, 'created_at' | 'last_used_at'>
): Promise<OAuthClientRecord> {
  const created_at = now();
  await compatInsert(db, oauth_clients).values({
    client_id: data.client_id,
    client_name: data.client_name,
    redirect_uris: j(data.redirect_uris),
    registered_via: data.registered_via,
    created_at,
    disabled: data.disabled,
  });
  return { ...data, created_at, last_used_at: null };
}
export async function getOAuthClient(
  db: DatabaseClient,
  clientId: string
): Promise<OAuthClientRecord | null> {
  const [r] = await compatSelect(db)
    .from(oauth_clients)
    .where(eq(oauth_clients.client_id, clientId))
    .limit(1);
  return r ? toClient(r) : null;
}
export async function listOAuthClients(db: DatabaseClient): Promise<OAuthClientRecord[]> {
  const rows = await compatSelect(db).from(oauth_clients);
  return (rows as any[]).map(toClient).sort((a, b) => a.created_at.localeCompare(b.created_at));
}
export async function countOAuthClients(db: DatabaseClient): Promise<number> {
  const rows = await compatSelect(db, { id: oauth_clients.client_id }).from(oauth_clients);
  return (rows as unknown[]).length;
}
export async function setOAuthClientDisabled(
  db: DatabaseClient,
  clientId: string,
  disabled: boolean
): Promise<void> {
  await compatUpdate(db, oauth_clients)
    .set({ disabled })
    .where(eq(oauth_clients.client_id, clientId));
}
export async function touchOAuthClient(db: DatabaseClient, clientId: string): Promise<void> {
  await compatUpdate(db, oauth_clients)
    .set({ last_used_at: now() })
    .where(eq(oauth_clients.client_id, clientId));
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
  db: DatabaseClient,
  data: PendingAuthRequestRecord
): Promise<void> {
  await compatInsert(db, oauth_pending_requests).values({
    ...data,
    requested_scopes: j(data.requested_scopes),
  });
}
export async function getPendingAuthRequest(
  db: DatabaseClient,
  requestId: string
): Promise<PendingAuthRequestRecord | null> {
  const [r] = await compatSelect(db)
    .from(oauth_pending_requests)
    .where(eq(oauth_pending_requests.request_id, requestId))
    .limit(1);
  return r ? toPending(r) : null;
}
/** Binds request to user on first open; returns false if bound to someone else (or missing/expired/used) */
export async function bindPendingAuthRequest(
  db: DatabaseClient,
  requestId: string,
  userId: string
): Promise<boolean> {
  // First opener wins via one conditional UPDATE (user_id IS NULL); then verify ownership.
  await compatUpdate(db, oauth_pending_requests)
    .set({ user_id: userId })
    .where(
      and(
        eq(oauth_pending_requests.request_id, requestId),
        isNull(oauth_pending_requests.user_id),
        gt(oauth_pending_requests.expires_at, now()),
        isNull(oauth_pending_requests.used_at)
      )
    );
  const [r] = await compatSelect(db)
    .from(oauth_pending_requests)
    .where(
      and(
        eq(oauth_pending_requests.request_id, requestId),
        gt(oauth_pending_requests.expires_at, now()),
        isNull(oauth_pending_requests.used_at)
      )
    )
    .limit(1);
  return !!r && r.user_id === userId;
}
/**
 * Single-use consume: ONE conditional UPDATE … WHERE used_at IS NULL AND expires_at > now RETURNING.
 * Concurrent callers: exactly one gets the row, the others get null (never an exception).
 */
export async function consumePendingAuthRequest(
  db: DatabaseClient,
  requestId: string
): Promise<PendingAuthRequestRecord | null> {
  const rows = await compatUpdate(db, oauth_pending_requests)
    .set({ used_at: now() })
    .where(
      and(
        eq(oauth_pending_requests.request_id, requestId),
        gt(oauth_pending_requests.expires_at, now()),
        isNull(oauth_pending_requests.used_at)
      )
    )
    .returning();
  return rows.length === 1 ? toPending(rows[0]) : null;
}

// ---- oauth_auth_codes ----
export async function createAuthCode(db: DatabaseClient, data: AuthCodeRecord): Promise<void> {
  await compatInsert(db, oauth_auth_codes).values({
    ...data,
    scopes: j(data.scopes),
    tool_allowlist: data.tool_allowlist == null ? null : j(data.tool_allowlist),
  });
}
/** Single-use consume (one conditional UPDATE … RETURNING); null if missing, expired or already used */
export async function consumeAuthCode(
  db: DatabaseClient,
  codeHash: string
): Promise<AuthCodeRecord | null> {
  const rows = await compatUpdate(db, oauth_auth_codes)
    .set({ used_at: now() })
    .where(
      and(
        eq(oauth_auth_codes.code_hash, codeHash),
        gt(oauth_auth_codes.expires_at, now()),
        isNull(oauth_auth_codes.used_at)
      )
    )
    .returning();
  return rows.length === 1 ? toCode(rows[0]) : null;
}

// ---- agent_grants ----
export async function createAgentGrant(
  db: DatabaseClient,
  data: Omit<AgentGrantRecord, 'created_at' | 'last_used_at' | 'revoked_at' | 'revoked_by'>
): Promise<AgentGrantRecord> {
  const created_at = now();
  await compatInsert(db, agent_grants).values({
    ...data,
    scopes: j(data.scopes),
    tool_allowlist: data.tool_allowlist == null ? null : j(data.tool_allowlist),
    created_at,
  });
  return { ...data, created_at, last_used_at: null, revoked_at: null, revoked_by: null };
}
export async function getAgentGrant(
  db: DatabaseClient,
  grantId: string
): Promise<AgentGrantRecord | null> {
  const [r] = await compatSelect(db)
    .from(agent_grants)
    .where(eq(agent_grants.grant_id, grantId))
    .limit(1);
  return r ? toGrant(r) : null;
}
export async function listAgentGrantsForUser(
  db: DatabaseClient,
  userId: string
): Promise<AgentGrantRecord[]> {
  const rows = await compatSelect(db).from(agent_grants).where(eq(agent_grants.user_id, userId));
  return (rows as any[]).map(toGrant).sort((a, b) => b.created_at.localeCompare(a.created_at));
}
/** Revokes grant and every token of it (no-op if already revoked) */
export async function revokeAgentGrant(
  db: DatabaseClient,
  grantId: string,
  revokedBy: string
): Promise<void> {
  const ts = now();
  await compatTransaction(db, async () => {
    await compatUpdate(db, agent_grants)
      .set({ revoked_at: ts, revoked_by: revokedBy })
      .where(and(eq(agent_grants.grant_id, grantId), isNull(agent_grants.revoked_at)));
    await compatUpdate(db, agent_tokens)
      .set({ revoked_at: ts })
      .where(and(eq(agent_tokens.grant_id, grantId), isNull(agent_tokens.revoked_at)));
  });
}
/** Returns number of grants revoked */
export async function revokeAllAgentGrantsForUser(
  db: DatabaseClient,
  userId: string,
  revokedBy: string
): Promise<number> {
  const ts = now();
  return compatTransaction(db, async () => {
    const rows = (await compatSelect(db, { id: agent_grants.grant_id })
      .from(agent_grants)
      .where(and(eq(agent_grants.user_id, userId), isNull(agent_grants.revoked_at)))) as {
      id: string;
    }[];
    if (rows.length === 0) return 0;
    const ids = rows.map(r => r.id);
    await compatUpdate(db, agent_grants)
      .set({ revoked_at: ts, revoked_by: revokedBy })
      .where(inArray(agent_grants.grant_id, ids));
    await compatUpdate(db, agent_tokens)
      .set({ revoked_at: ts })
      .where(and(inArray(agent_tokens.grant_id, ids), isNull(agent_tokens.revoked_at)));
    return ids.length;
  });
}
export async function touchAgentGrant(db: DatabaseClient, grantId: string): Promise<void> {
  await compatUpdate(db, agent_grants)
    .set({ last_used_at: now() })
    .where(eq(agent_grants.grant_id, grantId));
}

// ---- agent_tokens ----
export async function insertAgentToken(
  db: DatabaseClient,
  data: Omit<AgentTokenRecord, 'created_at' | 'used_at' | 'revoked_at'>
): Promise<void> {
  await compatInsert(db, agent_tokens).values({ ...data, created_at: now() });
}
export async function getAgentTokenByHash(
  db: DatabaseClient,
  tokenHash: string
): Promise<AgentTokenRecord | null> {
  const [r] = await compatSelect(db)
    .from(agent_tokens)
    .where(eq(agent_tokens.token_hash, tokenHash))
    .limit(1);
  return r ? toToken(r) : null;
}
/**
 * Marks a refresh token used with ONE conditional UPDATE; false if it was already used, revoked,
 * expired or missing (=> reuse detection by the caller). Exactly one concurrent caller wins.
 */
export async function markRefreshTokenUsed(
  db: DatabaseClient,
  tokenHash: string
): Promise<boolean> {
  const rows = await compatUpdate(db, agent_tokens)
    .set({ used_at: now() })
    .where(
      and(
        eq(agent_tokens.token_hash, tokenHash),
        eq(agent_tokens.kind, 'refresh'),
        isNull(agent_tokens.used_at),
        isNull(agent_tokens.revoked_at),
        gt(agent_tokens.expires_at, now())
      )
    )
    .returning();
  return rows.length === 1;
}
/** Grant ids (from the given set) that still have a live, unused refresh token */
export async function listGrantIdsWithLiveRefresh(
  db: DatabaseClient,
  grantIds: string[]
): Promise<Set<string>> {
  if (grantIds.length === 0) return new Set();
  const rows = (await compatSelect(db, { g: agent_tokens.grant_id })
    .from(agent_tokens)
    .where(
      and(
        inArray(agent_tokens.grant_id, grantIds),
        eq(agent_tokens.kind, 'refresh'),
        isNull(agent_tokens.used_at),
        isNull(agent_tokens.revoked_at),
        gt(agent_tokens.expires_at, now())
      )
    )) as { g: string }[];
  return new Set(rows.map(r => r.g));
}
/** Revokes a single token (keeps the row so verification can report `revoked`) */
export async function revokeSingleToken(db: DatabaseClient, tokenHash: string): Promise<void> {
  await compatUpdate(db, agent_tokens)
    .set({ revoked_at: now() })
    .where(and(eq(agent_tokens.token_hash, tokenHash), isNull(agent_tokens.revoked_at)));
}
/** Lists all agent grants (admin), newest first */
export async function listAllAgentGrants(db: DatabaseClient): Promise<AgentGrantRecord[]> {
  const rows = await compatSelect(db).from(agent_grants);
  return (rows as any[]).map(toGrant).sort((a, b) => b.created_at.localeCompare(a.created_at));
}
export async function deleteOAuthClient(db: DatabaseClient, clientId: string): Promise<void> {
  await compatDelete(db, oauth_clients).where(eq(oauth_clients.client_id, clientId));
}
export async function revokeTokenFamily(db: DatabaseClient, familyId: string): Promise<void> {
  await compatUpdate(db, agent_tokens)
    .set({ revoked_at: now() })
    .where(and(eq(agent_tokens.family_id, familyId), isNull(agent_tokens.revoked_at)));
}
export async function deleteAgentToken(db: DatabaseClient, tokenHash: string): Promise<void> {
  await compatDelete(db, agent_tokens).where(eq(agent_tokens.token_hash, tokenHash));
}

/** Grants stay listable (as expired) this long after expiry before being swept */
export const EXPIRED_GRANT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Sweep expired codes, pending requests, tokens, and grants expired > retention ago.
 * Returns rows removed.
 */
export async function sweepExpiredAgentRecords(db: DatabaseClient, at: Date): Promise<number> {
  const ts = at.toISOString();
  const grantCutoff = new Date(at.getTime() - EXPIRED_GRANT_RETENTION_MS).toISOString();
  return compatTransaction(db, async () => {
    let n = 0;
    const count = async (table: any, idCol: any, cond: any): Promise<void> => {
      const rows = (await compatSelect(db, { id: idCol }).from(table).where(cond)) as unknown[];
      if (rows.length) {
        await compatDelete(db, table).where(cond);
        n += rows.length;
      }
    };
    await count(
      oauth_pending_requests,
      oauth_pending_requests.request_id,
      lt(oauth_pending_requests.expires_at, ts)
    );
    await count(oauth_auth_codes, oauth_auth_codes.code_hash, lt(oauth_auth_codes.expires_at, ts));
    await count(agent_tokens, agent_tokens.token_hash, lt(agent_tokens.expires_at, ts));
    // Delete child tokens explicitly (does not rely on PRAGMA foreign_keys cascade)
    const oldGrants = (await compatSelect(db, { id: agent_grants.grant_id })
      .from(agent_grants)
      .where(lt(agent_grants.expires_at, grantCutoff))) as { id: string }[];
    if (oldGrants.length) {
      const ids = oldGrants.map(g => g.id);
      await compatDelete(db, agent_tokens).where(inArray(agent_tokens.grant_id, ids));
      await compatDelete(db, agent_grants).where(inArray(agent_grants.grant_id, ids));
      n += ids.length;
    }
    return n;
  });
}

// ---- bound-client lifecycle (revoke-and-retain) ----
/**
 * Revokes every live grant bound to the Ambassador client (and all of their tokens). Call this
 * BEFORE deleting the client; the FK then nulls bound_client_id and the revoked rows are retained.
 * Returns the affected grants (for auditing).
 */
// NOTE: not self-transactional (SQLite has no nested transactions); callers such as client delete wrap it.
export async function revokeGrantsForBoundClient(
  db: DatabaseClient,
  boundClientId: string,
  revokedBy: string
): Promise<AgentGrantRecord[]> {
  {
    const live = (await compatSelect(db)
      .from(agent_grants)
      .where(
        and(eq(agent_grants.bound_client_id, boundClientId), isNull(agent_grants.revoked_at))
      )) as any[];
    const at = now();
    for (const g of live) {
      await compatUpdate(db, agent_grants)
        .set({ revoked_at: at, revoked_by: revokedBy })
        .where(eq(agent_grants.grant_id, g.grant_id));
      await compatUpdate(db, agent_tokens)
        .set({ revoked_at: at })
        .where(and(eq(agent_tokens.grant_id, g.grant_id), isNull(agent_tokens.revoked_at)));
    }
    return live.map(toGrant);
  }
}

// ---- server_settings ----
export async function getServerSetting(db: DatabaseClient, key: string): Promise<string | null> {
  const [r] = await compatSelect(db)
    .from(server_settings)
    .where(eq(server_settings.key, key))
    .limit(1);
  return r ? (r.value as string) : null;
}
export async function setServerSetting(
  db: DatabaseClient,
  key: string,
  value: string,
  updatedBy: string | null
): Promise<void> {
  await compatInsert(db, server_settings)
    .values({ key, value, updated_at: now(), updated_by: updatedBy })
    .onConflictDoUpdate({
      target: server_settings.key,
      set: { value, updated_at: now(), updated_by: updatedBy },
    });
}
