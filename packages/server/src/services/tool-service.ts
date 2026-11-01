/**
 * Tool service — shared tool discovery and invocation logic.
 *
 * Extracted from the `/v1/tools` and `/v1/tools/invoke` route handlers (ADR-020) so
 * the remote agent endpoint (`/mcp`) goes through exactly the same catalog filtering,
 * authorization, routing and audit path as the stdio-client HTTP API.
 */

import {
  AuthorizationError,
  buildAgentSessionContext,
  type AgentSession,
  type AuthorizationProvider,
  type AuthRequest,
  type DatabaseClient,
  type Pipeline,
  type PipelineToolInvocationRequest,
  type SessionContext,
  ValidationError,
} from '@mcpambassador/core';
import { validateAgainstApprovedSchema } from './tool-pins/args-validator.js';
import { truncateDescriptionForServe } from './tool-pins/flags.js';
import type {
  ToolApprovalResult,
  ToolDescriptor,
  ToolInvocationResponse,
} from '@mcpambassador/protocol';
import { runApprovalGate, type GateGrantContext } from './approvals/gate.js';
import type { ApprovalService } from './approvals/service.js';
import type { SharedMcpManager, ToolRouter, UserMcpPool } from '../downstream/index.js';

export interface ToolServiceDeps {
  db: DatabaseClient;
  authz: AuthorizationProvider;
  pipeline: Pipeline;
  toolRouter: ToolRouter;
  mcpManager: SharedMcpManager;
  userPool: UserMcpPool;
  /** Admin kill switches (keys `mcp:<name>` / `client:<id>`); enforced on every invocation path */
  killSwitch?: { isActive(type: string, target: string): boolean };
  /** ADR-023 approval gate. Absent only where approvals are not initialised (some unit tests). */
  approvals?: { service: ApprovalService; uiBaseUrl: string };
}

/** Thrown when an admin kill switch blocks the tool's MCP or the calling client. */
export class KillSwitchError extends Error {
  constructor() {
    super('Tool disabled by kill switch');
    this.name = 'KillSwitchError';
  }
}

/**
 * ADR-023: downstream output must never carry the Ambassador namespace. Removes every `ambassador/*`
 * key from any `_meta` object at any depth (embedded resources included) in content blocks. Applied
 * in the router, so `/mcp` and `/v1/tools/invoke` get identical output.
 */
export function stripAmbassadorMeta(value: unknown, depth = 0): unknown {
  if (depth > 32 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(v => stripAmbassadorMeta(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === '_meta' && v && typeof v === 'object' && !Array.isArray(v)) {
      const kept: Record<string, unknown> = {};
      for (const [mk, mv] of Object.entries(v as Record<string, unknown>)) {
        if (!mk.startsWith('ambassador/')) kept[mk] = stripAmbassadorMeta(mv, depth + 1);
      }
      out[k] = kept;
    } else {
      out[k] = stripAmbassadorMeta(v, depth + 1);
    }
  }
  return out;
}

/** KS-1/KS-2: a client or MCP is killed */
function isKilled(
  deps: ToolServiceDeps,
  clientId: string,
  tool?: { source_mcp?: string }
): boolean {
  const ks = deps.killSwitch;
  if (!ks) return false;
  if (ks.isActive('client', clientId)) return true;
  return !!tool?.source_mcp && ks.isActive('mcp', tool.source_mcp);
}

/** Thrown when an authenticated session has no matching DB record (DB inconsistency). */
export class SessionStateError extends Error {
  constructor() {
    super('Session state inconsistent');
    this.name = 'SessionStateError';
  }
}

/** Thrown when a session lacks a client binding. */
export class SessionBindingError extends Error {
  constructor() {
    super('Session missing client binding');
    this.name = 'SessionBindingError';
  }
}

/** Resolve the owning user of a session (SEC-M17-004: fail if the record is missing). */
export async function resolveSessionUserId(
  db: DatabaseClient,
  session: SessionContext
): Promise<string> {
  const rec = await db.query.user_sessions.findFirst({
    where: (sessions, { eq }) => eq(sessions.session_id, session.session_id),
  });
  if (!rec) throw new SessionStateError();
  return rec.user_id ?? '';
}

function requireClientId(session: SessionContext): string {
  if (!session.client_id || typeof session.client_id !== 'string') {
    throw new SessionBindingError();
  }
  return session.client_id;
}

/**
 * Tools the session may see: the isolation-aware catalog for (user, client) filtered by
 * the authorization provider's decision for each tool.
 */
export async function listPermittedTools(
  deps: ToolServiceDeps,
  session: SessionContext,
  userId: string
): Promise<ToolDescriptor[]> {
  const clientId = requireClientId(session);
  const aggregated = await deps.toolRouter.getIsolationAwareToolCatalog(deps.db, userId, clientId);

  const allowed: ToolDescriptor[] = [];
  for (const tool of aggregated) {
    if (isKilled(deps, clientId, tool)) continue; // KS-2
    const decision = await deps.authz.authorize(session, {
      tool_name: tool.name,
      tool_arguments: {}, // Not needed for catalog check
    });
    if (decision.decision === 'permit') {
      allowed.push({
        name: tool.name,
        description: truncateDescriptionForServe(tool.description || ''),
        input_schema: tool.inputSchema,
        metadata: { mcp_server: tool.source_mcp },
      });
    }
  }
  return allowed;
}

/**
 * Build the pipeline router: re-checks the (user, client) subscription at call time and
 * routes to the exact MCP source that was allowed (prevents name-collision bypass between
 * a shared and a per-user MCP exposing the same tool name).
 */
export function buildInvocationRouter(
  deps: ToolServiceDeps,
  userId: string,
  clientId: string,
  /** Extra per-call restriction (agent scopes/allowlist); false = not permitted */
  extraFilter?: (tool: { name: string; source_mcp?: string }) => boolean,
  /** Receives the KillSwitchError when the router blocks a call (the pipeline swallows routing errors) */
  killHit?: { err?: KillSwitchError },
  /** ADR-022 P3: call exactly this MCP's tool (resolved by the caller); keeps same-named tools apart */
  sourceMcp?: string,
  /** ADR-023: the calling grant (agent path). Omitted = a connection with no grant (stdio client). */
  gateCtx?: GateGrantContext
) {
  return async (
    toolName: string,
    args: Record<string, unknown>
  ): Promise<{
    content: unknown;
    isError?: boolean;
    mcpServer?: string;
    /** Set ONLY by the gate; the pipeline copies it to metadata.approval (never from downstream) */
    approval?: ToolApprovalResult;
  }> => {
    const mcpRequest = { tool_name: toolName, arguments: args };

    // KS-1: one enforcement point for every router caller — client switch first (cheap)
    if (isKilled(deps, clientId)) {
      const err = new KillSwitchError();
      if (killHit) killHit.err = err;
      throw err;
    }

    const allowedTools = await deps.toolRouter.getIsolationAwareToolCatalog(
      deps.db,
      userId,
      clientId,
      { keepShadowed: sourceMcp !== undefined }
    );
    const allowedTool = allowedTools.find(
      tool => tool.name === toolName && (sourceMcp === undefined || tool.source_mcp === sourceMcp)
    );
    if (!allowedTool || (extraFilter && !extraFilter(allowedTool))) {
      throw new AuthorizationError('Tool not subscribed for this client');
    }

    if (isKilled(deps, clientId, allowedTool)) {
      const err = new KillSwitchError();
      if (killHit) killHit.err = err;
      throw err;
    }

    // Resolve WHERE the call goes first (these checks throw), so the approval is only consumed once
    // nothing else can refuse the call.
    let invoke: () => Promise<{ content: unknown; isError?: boolean }>;
    if (allowedTool.pinned_hash) {
      // ADR-021 D2/D3: route to the exact approved (mcp, scope) source and validate the arguments
      // against the APPROVED inputSchema, not whatever the downstream currently advertises.
      const check = validateAgainstApprovedSchema(
        allowedTool.pinned_hash,
        allowedTool.inputSchema,
        args
      );
      if (!check.valid) throw new ValidationError(check.error);
      invoke = () => deps.toolRouter.invokeOnSource(userId, allowedTool.source_mcp, mcpRequest);
    } else {
      const sharedTool = deps.mcpManager.getToolDescriptor(toolName);
      const userTool = deps.userPool.getToolDescriptor(userId, toolName);
      if (sharedTool?.source_mcp === allowedTool.source_mcp) {
        invoke = () => deps.mcpManager.invokeTool(mcpRequest);
      } else if (userTool?.source_mcp === allowedTool.source_mcp) {
        invoke = () => deps.userPool.invokeTool(userId, mcpRequest);
      } else {
        throw new AuthorizationError('Tool source does not match client subscription');
      }
    }

    // ADR-023: AFTER kill switches, scope and schema checks (a killed tool never creates a request),
    // immediately before the downstream call. `args` is the exact object that is routed.
    if (deps.approvals) {
      const gate = await runApprovalGate(
        { db: deps.db, approvals: deps.approvals.service, uiBaseUrl: deps.approvals.uiBaseUrl },
        {
          ctx: gateCtx ?? null,
          tool: allowedTool,
          args,
        }
      );
      if (!gate.proceed) {
        // Fixed, server-built outcome: no downstream content is read, spread or forwarded here.
        return {
          content: [],
          isError: true,
          mcpServer: allowedTool.source_mcp,
          approval: gate.approval,
        };
      }
    }

    const mcpResponse = await invoke();

    return {
      content: stripAmbassadorMeta(mcpResponse.content),
      isError: mcpResponse.isError,
      mcpServer: allowedTool.source_mcp,
    };
  };
}

/**
 * Invoke a tool through the AAA pipeline (authn → authz → validation → route → audit).
 * Throws AuthenticationError / AuthorizationError / ValidationError from the pipeline.
 */
export async function invokeTool(
  deps: ToolServiceDeps,
  session: SessionContext,
  userId: string,
  call: { tool: string; arguments: Record<string, unknown> },
  authRequest: AuthRequest
): Promise<ToolInvocationResponse> {
  const clientId = requireClientId(session);
  const pipelineRequest: PipelineToolInvocationRequest = {
    tool_name: call.tool,
    client_id: clientId,
    arguments: call.arguments,
  };
  const killHit: { err?: KillSwitchError } = {};
  const router = buildInvocationRouter(deps, userId, clientId, undefined, killHit);
  const result = await deps.pipeline.invoke(pipelineRequest, authRequest, router);
  if (killHit.err) throw killHit.err; // surfaces as 403; the pipeline already audited the blocked call
  return result;
}

// ===== Remote agent variants (ADR-020) =====

/** Restriction applied on top of the bound client's permissions for an agent grant */
export interface AgentToolRestriction {
  scopes: string[];
  /** Exact tool names; null = no allowlist */
  tool_allowlist: string[] | null;
}

/** scope `mcp:*` or `mcp:<source_mcp>` */
export function agentScopeAllows(scopes: string[], tool: { source_mcp?: string }): boolean {
  return (
    scopes.includes('mcp:*') ||
    (tool.source_mcp !== undefined && scopes.includes(`mcp:${tool.source_mcp}`))
  );
}

/** Scope, then the optional tool allowlist */
export function agentMayUseTool(
  r: AgentToolRestriction,
  tool: { name: string; source_mcp?: string }
): boolean {
  if (!agentScopeAllows(r.scopes, tool)) return false;
  return r.tool_allowlist === null || r.tool_allowlist.includes(tool.name);
}

/**
 * Tools an agent grant may see = scopes ∩ bound client's live permissions (catalog + authz) ∩
 * allowlist. The catalog is recomputed on every call; nothing is cached.
 */
export async function listAgentTools(
  deps: ToolServiceDeps,
  agent: AgentSession,
  restriction: AgentToolRestriction,
  /** keepShadowed: same-named tools of different MCPs stay separate (ADR-022 P3 resolver) */
  opts: { keepShadowed?: boolean } = {}
): Promise<ToolDescriptor[]> {
  const session = buildAgentSessionContext(agent);
  const aggregated = await deps.toolRouter.getIsolationAwareToolCatalog(
    deps.db,
    agent.user_id,
    agent.bound_client_id,
    opts
  );
  const allowed: ToolDescriptor[] = [];
  for (const tool of aggregated) {
    if (!agentMayUseTool(restriction, tool)) continue;
    if (isKilled(deps, agent.bound_client_id, tool)) continue; // KS-2
    const decision = await deps.authz.authorize(session, {
      tool_name: tool.name,
      tool_arguments: {},
    });
    if (decision.decision === 'permit') {
      allowed.push({
        name: tool.name,
        description: truncateDescriptionForServe(tool.description || ''),
        input_schema: tool.inputSchema,
        metadata: { mcp_server: tool.source_mcp },
      });
    }
  }
  return allowed;
}

/**
 * Invoke a tool for an agent grant. Goes through the same pipeline (authz, validation, routing,
 * audit) with the pre-authenticated agent session; scopes/allowlist are re-checked at routing time.
 * `agent` must come from validateAgentToken, never from request data.
 */
export async function invokeAgentTool(
  deps: ToolServiceDeps,
  agent: AgentSession,
  restriction: AgentToolRestriction,
  call: { tool: string; arguments: Record<string, unknown> },
  sourceIp: string,
  /** ADR-022: exact MCP (P3) and extra audit metadata (`via`, `disclosure_mode`) */
  extra: {
    sourceMcp?: string;
    auditMetadata?: Record<string, unknown>;
    /** `_meta["ambassador/approval_id"]` from the agent's request (status polling) */
    approvalId?: string;
  } = {}
): Promise<ToolInvocationResponse> {
  const killHit: { err?: KillSwitchError } = {};
  const gateCtx: GateGrantContext = {
    grantId: agent.grant_id,
    userId: agent.user_id,
    boundClientId: agent.bound_client_id,
    disclosureMode: extra.auditMetadata?.disclosure_mode === 'progressive' ? 'progressive' : 'full',
    via: typeof extra.auditMetadata?.via === 'string' ? extra.auditMetadata.via : null,
    ...(extra.approvalId !== undefined ? { approvalId: extra.approvalId } : {}),
  };
  const router = buildInvocationRouter(
    deps,
    agent.user_id,
    agent.bound_client_id,
    t => agentMayUseTool(restriction, t),
    killHit,
    extra.sourceMcp,
    gateCtx
  );
  const result = await deps.pipeline.invoke(
    { tool_name: call.tool, client_id: agent.bound_client_id, arguments: call.arguments },
    { headers: {}, sourceIp } satisfies AuthRequest,
    router,
    undefined,
    undefined,
    {
      preAuthenticatedSession: agent,
      ...(extra.auditMetadata ? { auditMetadata: extra.auditMetadata } : {}),
    }
  );
  if (killHit.err) throw killHit.err;
  return result;
}
