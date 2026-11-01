/**
 * Bound-client lookups (ADR-020 bound-client model).
 *
 * A grant is only as alive as the Ambassador client it binds to: the client must belong to the
 * grant's user, be `active`, not key-expired, and the user must be `active`.
 */

import { grantedMcpIdsForUser } from '../mcp-access.js';
import { eq, and, inArray } from 'drizzle-orm';
import {
  clients,
  users,
  tool_profiles,
  client_mcp_subscriptions,
  mcp_catalog,
  compatSelect,
  type DatabaseClient,
} from '@mcpambassador/core';
import type { ConsentClientOption } from '@mcpambassador/contracts';

export interface BoundClientInfo {
  client_id: string;
  client_name: string;
  profile_id: string | null;
}

/** Returns the client if (and only if) it is the user's own, active, unexpired client of an active user */
export async function getActiveBoundClient(
  db: DatabaseClient,
  userId: string,
  boundClientId: string
): Promise<BoundClientInfo | null> {
  const [u] = (await compatSelect(db, { status: users.status })
    .from(users)
    .where(eq(users.user_id, userId))
    .limit(1)) as { status: string }[];
  if (!u || u.status !== 'active') return null;
  const [c] = (await compatSelect(db)
    .from(clients)
    .where(and(eq(clients.client_id, boundClientId), eq(clients.user_id, userId)))
    .limit(1)) as {
    client_id: string;
    client_name: string;
    profile_id: string | null;
    status: string;
    expires_at: string | null;
  }[];
  if (!c || c.status !== 'active') return null;
  if (c.expires_at && new Date(c.expires_at).getTime() <= Date.now()) return null;
  return { client_id: c.client_id, client_name: c.client_name, profile_id: c.profile_id ?? null };
}

export interface SubscriptionInfo {
  name: string;
  scope: string;
  description: string;
}

/** Active subscriptions of a client, as scopes `mcp:<catalog name>` */
export async function listSubscriptionScopes(
  db: DatabaseClient,
  clientId: string
): Promise<SubscriptionInfo[]> {
  const subs = (await compatSelect(db)
    .from(client_mcp_subscriptions)
    .where(
      and(
        eq(client_mcp_subscriptions.client_id, clientId),
        eq(client_mcp_subscriptions.status, 'active')
      )
    )) as { mcp_id: string }[];
  if (subs.length === 0) return [];
  // ADR-025 M2: only MCPs the client's owner is currently granted (active groups) are offered.
  const [owner] = (await compatSelect(db, { user_id: clients.user_id })
    .from(clients)
    .where(eq(clients.client_id, clientId))
    .limit(1)) as { user_id: string }[];
  if (!owner) return [];
  const granted = await grantedMcpIdsForUser(db, owner.user_id);
  const grantedSubs = subs.filter(s => granted.has(s.mcp_id));
  if (grantedSubs.length === 0) return [];
  const cat = (await compatSelect(db)
    .from(mcp_catalog)
    .where(
      inArray(
        mcp_catalog.mcp_id,
        grantedSubs.map(s => s.mcp_id)
      )
    )) as { name: string; description: string }[];
  return cat
    .map(m => ({ name: m.name, scope: `mcp:${m.name}`, description: m.description }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** All of the user's ACTIVE clients with subscriptions, for the consent screen */
export async function listConsentClients(
  db: DatabaseClient,
  userId: string
): Promise<ConsentClientOption[]> {
  const [u] = (await compatSelect(db, { status: users.status })
    .from(users)
    .where(eq(users.user_id, userId))
    .limit(1)) as { status: string }[];
  if (!u || u.status !== 'active') return [];
  const rows = (await compatSelect(db)
    .from(clients)
    .where(and(eq(clients.user_id, userId), eq(clients.status, 'active')))) as {
    client_id: string;
    client_name: string;
    profile_id: string | null;
    expires_at: string | null;
  }[];
  const live = rows.filter(r => !r.expires_at || new Date(r.expires_at).getTime() > Date.now());
  const out: ConsentClientOption[] = [];
  for (const c of live) {
    let profileName: string | null = null;
    if (c.profile_id) {
      const [p] = (await compatSelect(db, { name: tool_profiles.name })
        .from(tool_profiles)
        .where(eq(tool_profiles.profile_id, c.profile_id))
        .limit(1)) as { name: string }[];
      profileName = p?.name ?? null;
    }
    const subs = await listSubscriptionScopes(db, c.client_id);
    out.push({
      client_id: c.client_id,
      client_name: c.client_name,
      profile_name: profileName,
      subscriptions: subs.map(s => ({
        name: s.name,
        scope: s.scope,
        ...(s.description ? { description: s.description } : {}),
      })),
    });
  }
  return out.sort((a, b) => a.client_name.localeCompare(b.client_name));
}

export async function getClientNames(
  db: DatabaseClient,
  clientIds: string[]
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (clientIds.length === 0) return map;
  const rows = (await compatSelect(db, {
    id: clients.client_id,
    name: clients.client_name,
  })
    .from(clients)
    .where(inArray(clients.client_id, clientIds))) as { id: string; name: string }[];
  for (const r of rows) map.set(r.id, r.name);
  return map;
}

export async function getUsernames(
  db: DatabaseClient,
  userIds: string[]
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (userIds.length === 0) return map;
  const rows = (await compatSelect(db, { id: users.user_id, name: users.username })
    .from(users)
    .where(inArray(users.user_id, userIds))) as { id: string; name: string }[];
  for (const r of rows) map.set(r.id, r.name);
  return map;
}

/**
 * Validate granted scopes against what was requested and what the bound client subscribes to.
 * `mcp:*` is allowed only if requested; `mcp:<name>` needs the subscription AND
 * (requested explicitly OR requested `mcp:*`). Returns the normalized scopes or an error string.
 */
export function validateGrantedScopes(
  granted: string[],
  requested: string[] | null,
  subscriptions: SubscriptionInfo[]
): { ok: true; scopes: string[] } | { ok: false; error: string } {
  const uniq = [...new Set(granted)];
  if (uniq.length === 0) return { ok: false, error: 'At least one scope is required' };
  const subScopes = new Set(subscriptions.map(s => s.scope));
  const reqAll = requested === null || requested.includes('mcp:*');
  for (const s of uniq) {
    if (s === 'mcp:*') {
      if (!reqAll) return { ok: false, error: 'Scope mcp:* was not requested' };
      continue;
    }
    if (!subScopes.has(s)) {
      return { ok: false, error: `Scope ${s} is not subscribed by the selected client` };
    }
    if (!reqAll && !(requested ?? []).includes(s)) {
      return { ok: false, error: `Scope ${s} was not requested` };
    }
  }
  return { ok: true, scopes: uniq };
}
