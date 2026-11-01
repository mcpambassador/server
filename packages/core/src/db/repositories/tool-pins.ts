/**
 * Tool definition pin persistence (ADR-021). Definitions are public metadata (canonical JSON).
 * scope_user_id NULL = shared MCP / all-users baseline.
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any */

import { and, eq, isNull, sql } from 'drizzle-orm';
import type { DatabaseClient } from '../client.js';
import { tool_pins, mcp_catalog } from '../../schema/index.js';
import { compatInsert, compatSelect, compatUpdate } from '../compat.js';

export type ToolPinStatusValue = 'approved' | 'pending_review' | 'rejected';

export interface ToolPinRecord {
  pin_id: string;
  mcp_id: string;
  scope_user_id: string | null;
  tool_name: string;
  status: ToolPinStatusValue;
  approved_hash: string | null;
  approved_definition: string | null;
  pending_hash: string | null;
  pending_definition: string | null;
  rejected_hash: string | null;
  /** JSON string of ToolPinFlags, or null */
  flags: string | null;
  absent: boolean;
  first_seen_at: string;
  approved_at: string | null;
  approved_by: string | null;
  updated_at: string;
}

function toRecord(r: any): ToolPinRecord {
  return {
    pin_id: r.pin_id,
    mcp_id: r.mcp_id,
    scope_user_id: r.scope_user_id ?? null,
    tool_name: r.tool_name,
    status: r.status,
    approved_hash: r.approved_hash ?? null,
    approved_definition: r.approved_definition ?? null,
    pending_hash: r.pending_hash ?? null,
    pending_definition: r.pending_definition ?? null,
    rejected_hash: r.rejected_hash ?? null,
    flags: r.flags ?? null,
    absent: Boolean(r.absent),
    first_seen_at: r.first_seen_at,
    approved_at: r.approved_at ?? null,
    approved_by: r.approved_by ?? null,
    updated_at: r.updated_at,
  };
}

const scopeCond = (scopeUserId: string | null): any =>
  scopeUserId === null ? isNull(tool_pins.scope_user_id) : eq(tool_pins.scope_user_id, scopeUserId);

/** All pins (startup load for the in-memory map). */
export async function listAllToolPins(db: DatabaseClient): Promise<ToolPinRecord[]> {
  return ((await compatSelect(db).from(tool_pins)) as any[]).map(toRecord);
}

/** All pins for one MCP in one scope. */
export async function listToolPinsForScope(
  db: DatabaseClient,
  mcpId: string,
  scopeUserId: string | null
): Promise<ToolPinRecord[]> {
  const rows = (await compatSelect(db)
    .from(tool_pins)
    .where(and(eq(tool_pins.mcp_id, mcpId), scopeCond(scopeUserId)))) as any[];
  return rows.map(toRecord);
}

/** All pins of one user across MCPs (lazy load of per-user pins). */
export async function listToolPinsForUser(
  db: DatabaseClient,
  userId: string
): Promise<ToolPinRecord[]> {
  const rows = (await compatSelect(db)
    .from(tool_pins)
    .where(eq(tool_pins.scope_user_id, userId))) as any[];
  return rows.map(toRecord);
}

export async function getToolPinById(
  db: DatabaseClient,
  pinId: string
): Promise<ToolPinRecord | null> {
  const [r] = (await compatSelect(db)
    .from(tool_pins)
    .where(eq(tool_pins.pin_id, pinId))
    .limit(1)) as any[];
  return r ? toRecord(r) : null;
}

export async function getToolPinByKey(
  db: DatabaseClient,
  mcpId: string,
  scopeUserId: string | null,
  toolName: string
): Promise<ToolPinRecord | null> {
  const [r] = (await compatSelect(db)
    .from(tool_pins)
    .where(
      and(eq(tool_pins.mcp_id, mcpId), scopeCond(scopeUserId), eq(tool_pins.tool_name, toolName))
    )
    .limit(1)) as any[];
  return r ? toRecord(r) : null;
}

export async function insertToolPin(db: DatabaseClient, rec: ToolPinRecord): Promise<void> {
  await compatInsert(db, tool_pins).values(rec);
}

/** Replace the mutable fields of a pin (identity fields stay). */
export async function updateToolPin(
  db: DatabaseClient,
  pinId: string,
  patch: Partial<Omit<ToolPinRecord, 'pin_id' | 'mcp_id' | 'scope_user_id' | 'tool_name'>>
): Promise<void> {
  await compatUpdate(db, tool_pins).set(patch).where(eq(tool_pins.pin_id, pinId));
}

/** Number of pending_review pins for one (mcp, scope): flood-cap input (D4b). */
export async function countPendingToolPins(
  db: DatabaseClient,
  mcpId: string,
  scopeUserId: string | null
): Promise<number> {
  const [r] = (await compatSelect(db, { n: sql<number>`count(*)` })
    .from(tool_pins)
    .where(
      and(
        eq(tool_pins.mcp_id, mcpId),
        scopeCond(scopeUserId),
        eq(tool_pins.status, 'pending_review')
      )
    )) as any[];
  return Number(r?.n ?? 0);
}

export async function getMcpPinPolicy(
  db: DatabaseClient,
  mcpId: string
): Promise<'review' | 'auto' | null> {
  const [r] = (await compatSelect(db)
    .from(mcp_catalog)
    .where(eq(mcp_catalog.mcp_id, mcpId))
    .limit(1)) as any[];
  return r ? ((r.pin_policy as 'review' | 'auto' | null) ?? 'review') : null;
}

export async function setMcpPinPolicy(
  db: DatabaseClient,
  mcpId: string,
  policy: 'review' | 'auto'
): Promise<void> {
  await compatUpdate(db, mcp_catalog)
    .set({ pin_policy: policy })
    .where(eq(mcp_catalog.mcp_id, mcpId));
}
