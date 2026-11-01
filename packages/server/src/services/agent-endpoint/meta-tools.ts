/**
 * ADR-022 progressive tool disclosure: the three `ambassador__` meta-tools.
 *
 * They are thin adapters over listAgentTools / invokeAgentTool (scope ∩ bound client ∩ authz ∩ allowlist
 * ∩ pins ∩ kill switches), never a second authorization path. Search and describe read only the tools the
 * grant may call, so a hidden, pending, revoked or out-of-scope tool is indistinguishable from a
 * nonexistent one. Definitions here are server-authored (not downstream text, not pinned).
 */
import { createHash } from 'node:crypto';
import {
  APPROVAL_META_KEY,
  APPROVAL_STATUS_TEXT,
  APPROVAL_UNAVAILABLE_REASON_TEXT,
  META_TOOL_NAMES,
  RESERVED_TOOL_PREFIX,
  SEARCH_TOOLS_DEFAULT_LIMIT,
  SEARCH_TOOLS_MAX_LIMIT,
  SEARCH_TOOLS_MAX_QUERY_LENGTH,
  callToolInputSchema,
  describeToolInputSchema,
  searchToolsInputSchema,
  type DescribeToolResult,
  type DisclosureMode,
  type MetaToolName,
  type SearchToolsResult,
  type ToolSearchHit,
} from '@mcpambassador/contracts';
import type { ToolApprovalResult, ToolDescriptor } from '@mcpambassador/protocol';
import { stripControlAndInvisible } from '../tool-pins/canonical.js';
import {
  KillSwitchError,
  invokeAgentTool,
  listAgentTools,
  type AgentToolRestriction,
  type ToolServiceDeps,
} from '../tool-service.js';
import {
  AuthorizationError,
  ValidationError,
  logger,
  type AgentSession,
} from '@mcpambassador/core';

export const META_TOOL_SEARCH = 'ambassador__search_tools' satisfies MetaToolName;
export const META_TOOL_DESCRIBE = 'ambassador__describe_tool' satisfies MetaToolName;
export const META_TOOL_CALL = 'ambassador__call_tool' satisfies MetaToolName;

/** Shown to the agent for any name that does not resolve: the same text whatever the reason */
export const UNKNOWN_TOOL_TEXT = 'Unknown tool';
const SUMMARY_MAX_CHARS = 200;
const MAX_NAME_LENGTH = 256;
/** Cap on the serialized search/describe response so one call cannot flood the agent's context */
const MAX_RESPONSE_BYTES = 64 * 1024;

export function isMetaToolName(name: unknown): name is MetaToolName {
  return typeof name === 'string' && (META_TOOL_NAMES as readonly string[]).includes(name);
}

/** Fixed definitions advertised by tools/list in `progressive` mode */
export const META_TOOL_DEFINITIONS: ReadonlyArray<{
  name: MetaToolName;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}> = [
  {
    name: META_TOOL_SEARCH,
    description:
      'Search the tools you can use by keyword (matches tool names and descriptions). ' +
      'Returns name, mcp and a one-line summary for each match. Use ambassador__describe_tool for the full schema.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          maxLength: SEARCH_TOOLS_MAX_QUERY_LENGTH,
          description: 'Words to look for; empty lists tools',
        },
        mcp: { type: 'string', description: 'Only tools from this MCP' },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: SEARCH_TOOLS_MAX_LIMIT,
          description: `Max results (default ${SEARCH_TOOLS_DEFAULT_LIMIT})`,
        },
      },
      required: ['query'],
    },
  },
  {
    name: META_TOOL_DESCRIBE,
    description:
      'Get the full description and input schema of one tool. Pass mcp when a name exists in several MCPs.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Tool name from ambassador__search_tools' },
        mcp: { type: 'string', description: 'MCP name, to disambiguate' },
      },
      required: ['name'],
    },
  },
  {
    name: META_TOOL_CALL,
    description:
      'Call a tool by name with its arguments (validated server-side against its schema). ' +
      'Pass mcp when a name exists in several MCPs.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Tool name' },
        mcp: { type: 'string', description: 'MCP name, to disambiguate' },
        arguments: { type: 'object', description: 'Arguments for the tool' },
      },
      required: ['name'],
    },
  },
];

export type MetaToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  /** ADR-023 gate outcome only: `{ "ambassador/approval": ApprovalToolResult }` */
  _meta?: Record<string, unknown>;
  structuredContent?: Record<string, unknown>;
};

/**
 * ADR-023: the result of a gated call is pure server output: exactly one server-authored text block
 * built from fixed templates (no tool name, arguments, MCP name or client label), plus the same
 * object in `_meta["ambassador/approval"]` and `structuredContent`, with isError: true.
 */
export function approvalResult(a: ToolApprovalResult): MetaToolResult {
  let t: string = APPROVAL_STATUS_TEXT[a.status];
  if (a.status === 'approval_unavailable') {
    t += ` ${APPROVAL_UNAVAILABLE_REASON_TEXT[a.reason]}`;
  } else if (a.status === 'approval_required') {
    t += ` Approval ID: ${a.approval_id}. Expires: ${a.expires_at}. Retry in ${a.retry_after_seconds} seconds. Review: ${a.approval_url}`;
  } else if (a.status === 'approval_denied') {
    if (a.approval_id) t += ` Approval ID: ${a.approval_id}.`;
    if (a.retry_after_seconds > 0) t += ` Do not retry for ${a.retry_after_seconds} seconds.`;
  } else {
    t += ` Approval ID: ${a.approval_id}.`;
  }
  return {
    content: [{ type: 'text', text: t }],
    isError: true,
    _meta: { [APPROVAL_META_KEY]: a },
    structuredContent: { ...a },
  };
}

const text = (msg: string, isError = false): MetaToolResult => ({
  content: [{ type: 'text', text: msg }],
  ...(isError ? { isError: true } : {}),
});
const unknownTool = (): MetaToolResult => text(UNKNOWN_TOOL_TEXT, true);

export interface MetaToolContext {
  deps: ToolServiceDeps;
  agent: AgentSession;
  restriction: AgentToolRestriction;
  mode: DisclosureMode;
  sourceIp: string;
  /** `_meta["ambassador/approval_id"]` the agent sent (read before the namespace is dropped) */
  approvalId?: string;
  /** audit `agent_tool_discovery` (never throws) */
  auditDiscovery(metadata: Record<string, unknown>): Promise<void>;
}

type Resolved =
  | { ok: true; tool: ToolDescriptor; mcp: string }
  | { ok: false; kind: 'unknown' }
  | { ok: false; kind: 'ambiguous'; mcps: string[] };

/**
 * ADR-022 P3: the one resolver. Candidates come only from tools this grant may call (keepShadowed keeps
 * same-named tools of different MCPs apart; the default catalog is first-wins).
 */
async function resolveTool(
  ctx: MetaToolContext,
  name: string,
  mcp: string | undefined
): Promise<Resolved> {
  const tools = await listAgentTools(ctx.deps, ctx.agent, ctx.restriction, { keepShadowed: true });
  const cands = tools.filter(
    t => t.name === name && (mcp === undefined || t.metadata?.mcp_server === mcp)
  );
  if (cands.length === 0) return { ok: false, kind: 'unknown' };
  if (cands.length > 1) {
    return {
      ok: false,
      kind: 'ambiguous',
      mcps: cands.map(c => c.metadata?.mcp_server ?? '').filter(Boolean),
    };
  }
  const tool = cands[0]!;
  return { ok: true, tool, mcp: tool.metadata?.mcp_server ?? '' };
}

function ambiguous(mcps: string[]): MetaToolResult {
  const names = mcps.map(m => stripControlAndInvisible(m)).join(', ');
  return text(`ambiguous: specify mcp (candidates: ${names})`, true);
}

/** First sentence of the (already truncated) approved description, capped and sanitized */
export function summarize(description: string): string {
  const clean = stripControlAndInvisible(description).replace(/\s+/g, ' ').trim();
  const m = /^(.+?[.!?])(\s|$)/.exec(clean);
  const first = m?.[1] ?? clean;
  return Array.from(first).slice(0, SUMMARY_MAX_CHARS).join('');
}

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean);
}

/** Case-insensitive match over name and description: every query token must appear as a substring */
function matches(tool: ToolDescriptor, qTokens: string[]): boolean {
  if (qTokens.length === 0) return true;
  const hay = `${tool.name} ${tool.description ?? ''}`.toLowerCase();
  return qTokens.every(t => hay.includes(t));
}

const hashOf = (s: string): string =>
  createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);

/** N1: the name to offer in a search hit, or null when sanitizing would change it (it would not resolve) */
export function searchHitName(name: string): string | null {
  return stripControlAndInvisible(name) === name ? name : null;
}

export function capResponse(obj: { tools: ToolSearchHit[] }): SearchToolsResult {
  const out: ToolSearchHit[] = [];
  let size = 2;
  for (const h of obj.tools) {
    size += Buffer.byteLength(JSON.stringify(h), 'utf8') + 1;
    if (size > MAX_RESPONSE_BYTES) break;
    out.push(h);
  }
  return { tools: out };
}

async function search(ctx: MetaToolContext, args: unknown): Promise<MetaToolResult> {
  const parsed = searchToolsInputSchema.safeParse(args ?? {});
  if (!parsed.success) return text('Invalid arguments', true);
  const { query, mcp } = parsed.data;
  // The schema leaves limit undefined; the default is applied here (and capped at the max)
  const limit = Math.min(parsed.data.limit ?? SEARCH_TOOLS_DEFAULT_LIMIT, SEARCH_TOOLS_MAX_LIMIT);
  const all = await listAgentTools(ctx.deps, ctx.agent, ctx.restriction, { keepShadowed: true });
  const qTokens = tokens(query);
  const hits: ToolSearchHit[] = [];
  for (const t of all) {
    if (hits.length >= limit) break;
    if (t.name.startsWith(RESERVED_TOOL_PREFIX)) continue;
    // Never hand out a name that would not resolve when sent back (sanitizing must not alter it)
    if (searchHitName(t.name) === null) continue;
    const owner = t.metadata?.mcp_server ?? '';
    if (mcp !== undefined && owner !== mcp) continue;
    if (!matches(t, qTokens)) continue;
    hits.push({
      name: stripControlAndInvisible(t.name),
      mcp: stripControlAndInvisible(owner),
      summary: summarize(t.description ?? ''),
    });
  }
  const result = capResponse({ tools: hits });
  await ctx.auditDiscovery({
    tool: META_TOOL_SEARCH,
    query_length: query.length,
    query_hash: hashOf(query),
    result_count: result.tools.length,
  });
  logger.debug({ query }, '[agent-mcp] search_tools query');
  return text(JSON.stringify(result));
}

/** A `name` that is not a valid, non-reserved string is "unknown tool", like any missing tool */
function nameIssue(error: { issues: Array<{ path: PropertyKey[] }> }): boolean {
  return error.issues.some(i => i.path[0] === 'name');
}

async function describe(ctx: MetaToolContext, args: unknown): Promise<MetaToolResult> {
  const parsed = describeToolInputSchema.safeParse(args ?? {});
  if (!parsed.success)
    return nameIssue(parsed.error) ? unknownTool() : text('Invalid arguments', true);
  const { name, mcp } = parsed.data;
  const r = await resolveTool(ctx, name, mcp);
  await ctx.auditDiscovery({
    tool: META_TOOL_DESCRIBE,
    query_length: name.length,
    query_hash: hashOf(name),
    result_count: r.ok ? 1 : 0,
  });
  if (!r.ok) return r.kind === 'ambiguous' ? ambiguous(r.mcps) : unknownTool();
  const result: DescribeToolResult = {
    name: r.tool.name,
    mcp: r.mcp,
    // already T(approved_definition): cut to 500 code points by the catalog (ADR-021 D1')
    description: r.tool.description ?? '',
    inputSchema: r.tool.input_schema ?? { type: 'object' },
  };
  return text(JSON.stringify(result));
}

/** Maps invocation failures to the same results as a direct tools/call */
export async function runToolCall(
  ctx: Pick<MetaToolContext, 'deps' | 'agent' | 'restriction' | 'mode' | 'sourceIp' | 'approvalId'>,
  name: string,
  args: Record<string, unknown>,
  extra: { sourceMcp?: string; via?: MetaToolName }
): Promise<MetaToolResult> {
  try {
    const response = await invokeAgentTool(
      ctx.deps,
      ctx.agent,
      ctx.restriction,
      { tool: name, arguments: args },
      ctx.sourceIp,
      {
        ...(extra.sourceMcp !== undefined ? { sourceMcp: extra.sourceMcp } : {}),
        ...(ctx.approvalId !== undefined ? { approvalId: ctx.approvalId } : {}),
        auditMetadata: {
          disclosure_mode: ctx.mode,
          ...(extra.via ? { via: extra.via } : {}),
        },
      }
    );
    // Gate outcome first: it is set only by the pipeline from the router's own field
    if (response.metadata?.approval) return approvalResult(response.metadata.approval);
    const err = response.metadata?.error;
    if (err) return text(typeof err === 'string' ? err : 'Tool invocation failed', true);
    const result = response.result;
    const content = Array.isArray(result)
      ? (result as MetaToolResult['content'])
      : [{ type: 'text' as const, text: JSON.stringify(result ?? null) }];
    return { content, ...(response.metadata?.is_error === true ? { isError: true } : {}) };
  } catch (e) {
    if (e instanceof KillSwitchError) return text(e.message, true);
    if (e instanceof AuthorizationError) return text('Tool not permitted', true);
    if (e instanceof ValidationError) return text(e.message, true);
    logger.error(`[agent-mcp] tools/call failed: ${String(e)}`);
    return text('Tool invocation failed', true);
  }
}

async function callTool(ctx: MetaToolContext, args: unknown): Promise<MetaToolResult> {
  const parsed = callToolInputSchema.safeParse(args ?? {});
  if (!parsed.success)
    return nameIssue(parsed.error) ? unknownTool() : text('Invalid arguments', true);
  const { name, mcp } = parsed.data;
  const r = await resolveTool(ctx, name, mcp);
  if (!r.ok) return r.kind === 'ambiguous' ? ambiguous(r.mcps) : unknownTool();
  return runToolCall(ctx, name, parsed.data.arguments ?? {}, {
    sourceMcp: r.mcp,
    via: META_TOOL_CALL,
  });
}

/** Dispatch a meta-tool by (reserved) name. Never recurses into another meta-tool. */
export async function handleMetaTool(
  ctx: MetaToolContext,
  name: MetaToolName,
  args: unknown
): Promise<MetaToolResult> {
  switch (name) {
    case META_TOOL_SEARCH:
      return search(ctx, args);
    case META_TOOL_DESCRIBE:
      return describe(ctx, args);
    case META_TOOL_CALL:
      return callTool(ctx, args);
  }
}

/**
 * Names a tools/call body asks for, unwrapped exactly one level (P2): `ambassador__call_tool` yields the
 * inner `arguments.name` (and `mcp`); a non-string, empty, over-long or reserved inner name yields nothing
 * (the call then answers "Unknown tool"). Meta-tool names themselves yield nothing.
 */
export function targetsOfToolCall(
  params: unknown
): Array<{ name: string; mcp?: string; wrapped: boolean }> {
  if (!params || typeof params !== 'object') return [];
  const p = params as { name?: unknown; arguments?: unknown };
  if (typeof p.name !== 'string') return [];
  if (p.name === META_TOOL_CALL) {
    const a = p.arguments;
    if (!a || typeof a !== 'object') return [];
    const inner = (a as { name?: unknown; mcp?: unknown }).name;
    const mcp = (a as { mcp?: unknown }).mcp;
    if (
      typeof inner !== 'string' ||
      inner.length === 0 ||
      inner.length > MAX_NAME_LENGTH ||
      inner.startsWith(RESERVED_TOOL_PREFIX)
    )
      return [];
    return [{ name: inner, wrapped: true, ...(typeof mcp === 'string' ? { mcp } : {}) }];
  }
  if (isMetaToolName(p.name)) return [];
  return [{ name: p.name, wrapped: false }];
}
