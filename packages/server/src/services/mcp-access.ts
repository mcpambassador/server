/**
 * MCP access — the single group-grant check shared by subscribe time and call time (ADR-025 M2/M4).
 *
 * A user may use an MCP iff one of the user's ACTIVE groups holds an `mcp_group_access` row for it.
 * A suspended (any non-active) group grants nothing (ADR-025 §3.5/M2). Call-time callers filter
 * what they return; they never mutate the subscription row, so re-granting restores access.
 */

import { and, eq } from 'drizzle-orm';
import {
  compatSelect,
  getGroupToolPolicies,
  groups,
  policiesPermitTool,
  policiesUnrestricted,
  user_groups,
  type DatabaseClient,
  type GroupToolPolicy,
} from '@mcpambassador/core';

/** mcp_ids the user is currently granted through any group. */
export async function grantedMcpIdsForUser(
  db: DatabaseClient,
  userId: string
): Promise<Set<string>> {
  // One source of truth: the same resolver the per-tool policy uses.
  return (await toolAccessForUser(db, userId)).granted;
}

/** True when the user is granted this MCP through at least one group. */
export async function userHasMcpAccess(
  db: DatabaseClient,
  userId: string,
  mcpId: string
): Promise<boolean> {
  return (await grantedMcpIdsForUser(db, userId)).has(mcpId);
}

/**
 * ADR-025 per-tool group policy. For each MCP the user is granted, the policies of ALL the user's
 * granting ACTIVE groups. A tool is offered when ANY policy offers it (union; any 'all' offers all).
 * Two queries for the whole user. `granted` is the same set `grantedMcpIdsForUser` returns.
 */
export interface UserToolAccess {
  granted: Set<string>;
  /** mcp_id -> policies; absent from the map = not granted. */
  policies: Map<string, Pick<GroupToolPolicy, 'tool_mode' | 'tools'>[]>;
  /** True when the user may use `toolName` of `mcpId` (false when the MCP is not granted). */
  permits(mcpId: string, toolName: string): boolean;
  /** True when no tool of this MCP is filtered (some granting group says 'all'). */
  unrestricted(mcpId: string): boolean;
}

export async function toolAccessForUser(
  db: DatabaseClient,
  userId: string
): Promise<UserToolAccess> {
  const groupRows = (await compatSelect(db, { group_id: user_groups.group_id })
    .from(user_groups)
    .innerJoin(groups, eq(groups.group_id, user_groups.group_id))
    .where(and(eq(user_groups.user_id, userId), eq(groups.status, 'active')))) as {
    group_id: string;
  }[];
  const all = await getGroupToolPolicies(
    db,
    groupRows.map(r => r.group_id)
  );
  const policies = new Map<string, Pick<GroupToolPolicy, 'tool_mode' | 'tools'>[]>();
  for (const p of all) {
    const list = policies.get(p.mcp_id);
    if (list) list.push(p);
    else policies.set(p.mcp_id, [p]);
  }
  return {
    granted: new Set(policies.keys()),
    policies,
    permits: (mcpId, toolName) => {
      const list = policies.get(mcpId);
      return !!list && policiesPermitTool(list, toolName);
    },
    unrestricted: mcpId => {
      const list = policies.get(mcpId);
      return !!list && policiesUnrestricted(list);
    },
  };
}
