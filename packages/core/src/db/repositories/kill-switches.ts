/**
 * Kill switch persistence (TD-022). Row present = active.
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await */

import { eq } from 'drizzle-orm';
import type { DatabaseClient } from '../client.js';
import { kill_switches } from '../../schema/index.js';
import { compatInsert, compatSelect, compatDelete } from '../compat.js';

export interface KillSwitchRecord {
  target: string;
  type: 'client' | 'mcp';
  activated_at: string;
  activated_by: string;
}

export async function listKillSwitches(db: DatabaseClient): Promise<KillSwitchRecord[]> {
  const rows = (await compatSelect(db).from(kill_switches)) as any[];
  return rows.map(r => ({
    target: r.target,
    type: r.type,
    activated_at: r.activated_at,
    activated_by: r.activated_by,
  }));
}

/** Idempotent: re-activating keeps the original activation record */
export async function upsertKillSwitch(db: DatabaseClient, rec: KillSwitchRecord): Promise<void> {
  await compatInsert(db, kill_switches).values(rec).onConflictDoNothing();
}

export async function deleteKillSwitch(db: DatabaseClient, target: string): Promise<void> {
  await compatDelete(db, kill_switches).where(eq(kill_switches.target, target));
}
