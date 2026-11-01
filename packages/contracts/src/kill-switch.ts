/**
 * Admin kill switches (9443 admin API, `{ ok, data }` envelope).
 *
 * GET  /v1/admin/kill-switches        → data: KillSwitchSummary[]  (ACTIVE switches only, non-paginated)
 * POST /v1/admin/kill-switch/:target  → body { enabled: boolean }; target must match KILL_SWITCH_TARGET_PATTERN,
 *                                       otherwise 400
 */
import { z } from 'zod';

export const KILL_SWITCH_LIST_ROUTE = '/v1/admin/kill-switches';
export const KILL_SWITCH_TOGGLE_ROUTE = '/v1/admin/kill-switch/:target';

/** `client:<client_id>` or `mcp:<mcp name>` */
export const KILL_SWITCH_TARGET_PATTERN = /^(client|mcp):.+$/;

export const killSwitchSummarySchema = z.object({
  target: z.string().regex(KILL_SWITCH_TARGET_PATTERN),
  type: z.enum(['client', 'mcp']),
  activated_at: z.string(),
  activated_by: z.string(),
});
export type KillSwitchSummary = z.infer<typeof killSwitchSummarySchema>;
