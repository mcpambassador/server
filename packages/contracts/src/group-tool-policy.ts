/**
 * ADR-025 / FB-032 per-tool group policy — admin API contracts (9443, `{ ok, data }` envelope).
 *
 * A group's grant of an MCP carries a `tool_mode`:
 *   all   (default) every tool of the MCP
 *   allow only the listed tools
 *   deny  every tool except the listed
 * Names are exact (no globs) and compared byte-for-byte. A user's effective tools for an MCP are the
 * UNION over the user's granting ACTIVE groups.
 *
 * GET  /v1/admin/groups/:groupId/mcps               → McpCatalogEntry[] each with `tool_mode` and `tools`
 * POST /v1/admin/groups/:groupId/mcps               → body { mcp_id, tool_mode?, tools? } (grant + rules in one transaction)
 * PUT  /v1/admin/groups/:groupId/mcps/:mcpId/tools  → body GroupToolPolicyRequest; replaces the policy atomically; 404 if the group does not grant the MCP
 * GET  /v1/admin/mcps/:mcpId/tools                  → KnownMcpToolsResponse (picker for the policy editor)
 */
import { z } from 'zod';
import { POLICY_TOOL_NAME_MAX, isValidPolicyToolName } from './tool-name.js';

export const ADMIN_GROUP_MCP_TOOLS_ROUTE = '/v1/admin/groups/:groupId/mcps/:mcpId/tools';
export const ADMIN_MCP_KNOWN_TOOLS_ROUTE = '/v1/admin/mcps/:mcpId/tools';

export const GROUP_TOOL_MODES = ['all', 'allow', 'deny'] as const;
export type GroupToolMode = (typeof GROUP_TOOL_MODES)[number];

/** Max rule names per (group, MCP) grant. */
export const GROUP_TOOL_POLICY_MAX_TOOLS = 500;

const toolsField = z
  .array(
    z.string().refine(isValidPolicyToolName, {
      message: `invalid tool name (1-${POLICY_TOOL_NAME_MAX} code points; no control, bidi or zero-width characters)`,
    })
  )
  .max(GROUP_TOOL_POLICY_MAX_TOOLS);

type PolicyShape = { tool_mode: GroupToolMode; tools: string[] };

/** `all` carries no names; `allow` and `deny` need at least one (empty allow hides the MCP; empty deny is just `all`). */
function checkModeAndTools(v: PolicyShape, ctx: z.RefinementCtx): void {
  if (v.tool_mode === 'all' && v.tools.length > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['tools'],
      message: "tools must be empty when tool_mode is 'all'",
    });
  }
  if (v.tool_mode === 'allow' && v.tools.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['tools'],
      message: "tools must not be empty when tool_mode is 'allow'",
    });
  }
  if (v.tool_mode === 'deny' && v.tools.length === 0) {
    // deny{} grants every tool, which is exactly 'all'; one spelling keeps the policy unambiguous.
    ctx.addIssue({
      code: 'custom',
      path: ['tools'],
      message: "use tool_mode 'all' to grant every tool",
    });
  }
}

/** Byte-exact de-duplication, first occurrence wins (order is irrelevant to the policy). */
const dedupe = (v: PolicyShape): PolicyShape => ({ ...v, tools: [...new Set(v.tools)] });

export const groupToolPolicyRequestSchema = z
  .object({
    tool_mode: z.enum(GROUP_TOOL_MODES),
    tools: toolsField,
  })
  .strict()
  .superRefine(checkModeAndTools)
  .transform(dedupe);
export type GroupToolPolicyRequest = z.input<typeof groupToolPolicyRequestSchema>;

/** POST /v1/admin/groups/:groupId/mcps — the optional policy defaults to `all`. */
export const assignGroupMcpRequestSchema = z
  .object({
    mcp_id: z.string().uuid(),
    tool_mode: z.enum(GROUP_TOOL_MODES).default('all'),
    tools: toolsField.default([]),
  })
  .strict()
  .superRefine(checkModeAndTools)
  .transform(v => ({ ...dedupe(v), mcp_id: v.mcp_id }));

export interface GroupToolPolicy {
  tool_mode: GroupToolMode;
  /** Exact names; `[]` for `all`. */
  tools: string[];
}

export interface KnownMcpTool {
  name: string;
  /** True for a rule name (any group) that matches no current tool: a typo or a removed tool. */
  orphan: boolean;
}

export interface KnownMcpToolsResponse {
  mcp_id: string;
  /** Known names (catalog snapshot + approved pins) followed by orphan rule names, each sorted. */
  tools: KnownMcpTool[];
}
