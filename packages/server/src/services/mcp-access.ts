/**
 * MCP access — the single group-grant check shared by subscribe time and call time (ADR-025 M2/M4).
 *
 * A user may use an MCP iff one of the user's groups holds an `mcp_group_access` row for it.
 * Group `status`/suspension is intentionally NOT consulted (ADR-025 M2). Call-time callers filter
 * what they return; they never mutate the subscription row, so re-granting restores access.
 */

import { eq } from 'drizzle-orm';
import {
  compatSelect,
  mcp_group_access,
  user_groups,
  type DatabaseClient,
} from '@mcpambassador/core';

/** mcp_ids the user is currently granted through any group. */
export async function grantedMcpIdsForUser(
  db: DatabaseClient,
  userId: string
): Promise<Set<string>> {
  const rows = (await compatSelect(db, { mcp_id: mcp_group_access.mcp_id })
    .from(mcp_group_access)
    .innerJoin(user_groups, eq(user_groups.group_id, mcp_group_access.group_id))
    .where(eq(user_groups.user_id, userId))) as { mcp_id: string }[];
  return new Set(rows.map(r => r.mcp_id));
}

/** True when the user is granted this MCP through at least one group. */
export async function userHasMcpAccess(
  db: DatabaseClient,
  userId: string,
  mcpId: string
): Promise<boolean> {
  return (await grantedMcpIdsForUser(db, userId)).has(mcpId);
}
