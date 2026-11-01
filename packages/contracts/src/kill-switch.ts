/**
 * Admin kill switches (9443 admin API, `{ ok, data }` envelope).
 *
 * GET  /v1/admin/kill-switches        → data: KillSwitchSummary[]  (ACTIVE switches only, non-paginated)
 * POST /v1/admin/kill-switch/:target  → body { enabled: boolean }; target must be accepted by
 *                                       parseKillSwitchTarget, otherwise 400
 *
 * Targets: `client:<client_id>`, `mcp:<mcp name>`, `tool:<mcp_id>:<tool_name>` (ADR-025 M1). The tool
 * target is keyed on the catalog entry's mcp_id (a UUID, never the name) plus the byte-exact tool name;
 * URL-encode the target when the tool name contains `/`, `?`, `#` or `%`.
 */
import { z } from 'zod';
import { isValidPolicyToolName } from './tool-name.js';

export const KILL_SWITCH_LIST_ROUTE = '/v1/admin/kill-switches';
export const KILL_SWITCH_TOGGLE_ROUTE = '/v1/admin/kill-switch/:target';

/** `client:<client_id>`, `mcp:<mcp name>` or `tool:<mcp_id>:<tool_name>` (shape only; see parseKillSwitchTarget) */
export const KILL_SWITCH_TARGET_PATTERN = /^(?:(?:client|mcp):.+|tool:[^:]+:.+)$/;

export type KillSwitchType = 'client' | 'mcp' | 'tool';

/** Build the target key for a tool kill switch */
export function toolKillSwitchTarget(mcpId: string, toolName: string): string {
  return `tool:${mcpId}:${toolName}`;
}

/**
 * Strict target parser. Returns null for anything that is not a meaningful target (an unknown prefix or an
 * invalid tool name would otherwise be a silent no-op). The mcp_id of a tool target cannot contain ':'.
 */
export function parseKillSwitchTarget(
  target: string
):
  | { type: 'client' | 'mcp'; id: string }
  | { type: 'tool'; mcpId: string; toolName: string }
  | null {
  const m = /^(client|mcp|tool):(.+)$/s.exec(target);
  if (!m) return null;
  const type = m[1] as KillSwitchType;
  const rest = m[2]!;
  if (type !== 'tool') return { type, id: rest };
  const i = rest.indexOf(':');
  if (i <= 0) return null;
  const toolName = rest.slice(i + 1);
  return isValidPolicyToolName(toolName)
    ? { type: 'tool', mcpId: rest.slice(0, i), toolName }
    : null;
}

export const killSwitchSummarySchema = z.object({
  target: z.string().regex(KILL_SWITCH_TARGET_PATTERN),
  type: z.enum(['client', 'mcp', 'tool']),
  activated_at: z.string(),
  activated_by: z.string(),
});
export type KillSwitchSummary = z.infer<typeof killSwitchSummarySchema>;
