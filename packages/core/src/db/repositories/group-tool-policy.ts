/**
 * Per-tool group policy persistence (ADR-025 / FB-032).
 *
 * A grant (`mcp_group_access` row) carries `tool_mode` ('all' | 'allow' | 'deny'); the exact tool names
 * for 'allow'/'deny' live in `mcp_group_access_tools`. Names are matched exactly, never by pin hash.
 * Every multi-row write here is ONE transaction, so a grant never exists half-configured.
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/require-await */

import { and, eq, inArray } from 'drizzle-orm';
import type { DatabaseClient } from '../client.js';
import { mcp_group_access, mcp_group_access_tools, tool_pins } from '../../schema/index.js';
import { compatSelect } from '../compat.js';

export type ToolMode = 'all' | 'allow' | 'deny';

export interface GroupToolPolicy {
  mcp_id: string;
  group_id: string;
  tool_mode: ToolMode;
  /** Exact tool names; always empty when tool_mode is 'all'. */
  tools: string[];
}

/** Does ONE group's policy offer this tool? */
export function policyPermitsTool(
  policy: Pick<GroupToolPolicy, 'tool_mode' | 'tools'>,
  toolName: string
): boolean {
  if (policy.tool_mode === 'all') return true;
  const listed = policy.tools.includes(toolName);
  return policy.tool_mode === 'allow' ? listed : !listed;
}

/**
 * Union across a user's granting ACTIVE groups (ADR-025 §3.3): a tool is offered when ANY group offers
 * it. An empty policy list offers nothing (no grant).
 */
export function policiesPermitTool(
  policies: readonly Pick<GroupToolPolicy, 'tool_mode' | 'tools'>[],
  toolName: string
): boolean {
  return policies.some(p => policyPermitsTool(p, toolName));
}

/** True when ANY policy is 'all' (union semantics): nothing needs filtering, the caller can skip it (default parity fast path). */
export function policiesUnrestricted(
  policies: readonly Pick<GroupToolPolicy, 'tool_mode'>[]
): boolean {
  return policies.some(p => p.tool_mode === 'all');
}

/**
 * Batched read: the policy of every grant held by the given groups (optionally narrowed to some MCPs).
 * Two queries regardless of how many grants.
 */
export async function getGroupToolPolicies(
  db: DatabaseClient,
  groupIds: string[],
  mcpIds?: string[]
): Promise<GroupToolPolicy[]> {
  if (groupIds.length === 0 || (mcpIds && mcpIds.length === 0)) return [];
  const grantWhere = mcpIds
    ? and(inArray(mcp_group_access.group_id, groupIds), inArray(mcp_group_access.mcp_id, mcpIds))
    : inArray(mcp_group_access.group_id, groupIds);
  const grants = (await compatSelect(db, {
    mcp_id: mcp_group_access.mcp_id,
    group_id: mcp_group_access.group_id,
    tool_mode: mcp_group_access.tool_mode,
  })
    .from(mcp_group_access)
    .where(grantWhere)) as { mcp_id: string; group_id: string; tool_mode: ToolMode }[];

  const restricted = grants.filter(g => g.tool_mode !== 'all');
  const byKey = new Map<string, string[]>();
  if (restricted.length > 0) {
    const toolWhere = mcpIds
      ? and(
          inArray(mcp_group_access_tools.group_id, groupIds),
          inArray(mcp_group_access_tools.mcp_id, mcpIds)
        )
      : inArray(mcp_group_access_tools.group_id, groupIds);
    const rows = (await compatSelect(db, {
      mcp_id: mcp_group_access_tools.mcp_id,
      group_id: mcp_group_access_tools.group_id,
      tool_name: mcp_group_access_tools.tool_name,
    })
      .from(mcp_group_access_tools)
      .where(toolWhere)) as { mcp_id: string; group_id: string; tool_name: string }[];
    for (const r of rows) {
      const k = `${r.group_id}\u0000${r.mcp_id}`;
      const list = byKey.get(k);
      if (list) list.push(r.tool_name);
      else byKey.set(k, [r.tool_name]);
    }
  }
  return grants.map(g => ({
    mcp_id: g.mcp_id,
    group_id: g.group_id,
    tool_mode: g.tool_mode,
    tools: g.tool_mode === 'all' ? [] : (byKey.get(`${g.group_id}\u0000${g.mcp_id}`) ?? []).sort(),
  }));
}

export interface SetToolPolicyInput {
  mcp_id: string;
  group_id: string;
  tool_mode: ToolMode;
  /** Already validated and de-duplicated by the caller; must be [] for 'all'. */
  tools: string[];
  actor: string;
}

export interface SetToolPolicyResult {
  /** False when the group does not grant the MCP (nothing written). */
  found: boolean;
  added: string[];
  removed: string[];
}

/**
 * Replace a grant's policy atomically: the grant-exists check, the mode update and the rule rows all
 * happen in ONE transaction. Setting 'all' deletes the rule rows in the same transaction.
 */
export async function setGroupToolPolicy(
  db: DatabaseClient,
  input: SetToolPolicyInput
): Promise<SetToolPolicyResult> {
  const d = db as any;
  const now = new Date().toISOString();
  const grantCond = and(
    eq(mcp_group_access.mcp_id, input.mcp_id),
    eq(mcp_group_access.group_id, input.group_id)
  );
  const toolCond = and(
    eq(mcp_group_access_tools.mcp_id, input.mcp_id),
    eq(mcp_group_access_tools.group_id, input.group_id)
  );
  const wanted = input.tool_mode === 'all' ? [] : input.tools;
  const rows = (names: string[]) =>
    names.map(tool_name => ({
      mcp_id: input.mcp_id,
      group_id: input.group_id,
      tool_name,
      created_at: now,
      created_by: input.actor,
    }));
  const diff = (before: string[]): SetToolPolicyResult => ({
    found: true,
    added: wanted.filter(n => !before.includes(n)).sort(),
    removed: before.filter(n => !wanted.includes(n)).sort(),
  });

  if ('execute' in d && typeof d.execute === 'function') {
    return d.transaction(async (tx: any) => {
      const [grant] = await tx.select().from(mcp_group_access).where(grantCond).limit(1);
      if (!grant) return { found: false, added: [], removed: [] };
      const before = (await tx.select().from(mcp_group_access_tools).where(toolCond)).map(
        (r: any) => r.tool_name as string
      );
      await tx.update(mcp_group_access).set({ tool_mode: input.tool_mode }).where(grantCond);
      await tx.delete(mcp_group_access_tools).where(toolCond);
      if (wanted.length > 0) await tx.insert(mcp_group_access_tools).values(rows(wanted));
      return diff(before);
    });
  }
  // better-sqlite3 transactions are synchronous
  return d.transaction((tx: any) => {
    const grant = tx.select().from(mcp_group_access).where(grantCond).limit(1).all()[0];
    if (!grant) return { found: false, added: [], removed: [] };
    const before = tx
      .select()
      .from(mcp_group_access_tools)
      .where(toolCond)
      .all()
      .map((r: any) => r.tool_name as string);
    tx.update(mcp_group_access).set({ tool_mode: input.tool_mode }).where(grantCond).run();
    tx.delete(mcp_group_access_tools).where(toolCond).run();
    if (wanted.length > 0) tx.insert(mcp_group_access_tools).values(rows(wanted)).run();
    return diff(before);
  });
}

/** Create a grant WITH its policy in one transaction (POST /groups/:id/mcps with tool_mode/tools). */
export async function grantGroupAccessWithPolicy(
  db: DatabaseClient,
  input: SetToolPolicyInput
): Promise<void> {
  const d = db as any;
  const now = new Date().toISOString();
  const wanted = input.tool_mode === 'all' ? [] : input.tools;
  const grant = {
    mcp_id: input.mcp_id,
    group_id: input.group_id,
    assigned_at: now,
    assigned_by: input.actor,
    tool_mode: input.tool_mode,
  };
  const toolRows = wanted.map(tool_name => ({
    mcp_id: input.mcp_id,
    group_id: input.group_id,
    tool_name,
    created_at: now,
    created_by: input.actor,
  }));
  if ('execute' in d && typeof d.execute === 'function') {
    await d.transaction(async (tx: any) => {
      await tx.insert(mcp_group_access).values(grant);
      if (toolRows.length > 0) await tx.insert(mcp_group_access_tools).values(toolRows);
    });
    return;
  }
  d.transaction((tx: any) => {
    tx.insert(mcp_group_access).values(grant).run();
    if (toolRows.length > 0) tx.insert(mcp_group_access_tools).values(toolRows).run();
  });
}

/** Distinct rule names (any group) written for one MCP — input to the orphan check. */
export async function listPolicyRuleNamesForMcp(
  db: DatabaseClient,
  mcpId: string
): Promise<string[]> {
  const rows = (await compatSelect(db, { tool_name: mcp_group_access_tools.tool_name })
    .from(mcp_group_access_tools)
    .where(eq(mcp_group_access_tools.mcp_id, mcpId))) as { tool_name: string }[];
  return [...new Set(rows.map(r => r.tool_name))];
}

/** Distinct tool names with an approved pin for one MCP (any scope). */
export async function listApprovedPinToolNames(
  db: DatabaseClient,
  mcpId: string
): Promise<string[]> {
  const rows = (await compatSelect(db, { tool_name: tool_pins.tool_name })
    .from(tool_pins)
    .where(and(eq(tool_pins.mcp_id, mcpId), eq(tool_pins.status, 'approved')))) as {
    tool_name: string;
  }[];
  return [...new Set(rows.map(r => r.tool_name))];
}
