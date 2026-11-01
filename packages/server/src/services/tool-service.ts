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
} from '@mcpambassador/core';
import type { ToolDescriptor, ToolInvocationResponse } from '@mcpambassador/protocol';
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
}

/** Thrown when an admin kill switch blocks the tool's MCP or the calling client. */
export class KillSwitchError extends Error {
  constructor() {
    super('Tool disabled by kill switch');
    this.name = 'KillSwitchError';
  }
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
        description: tool.description || '',
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
  killHit?: { err?: KillSwitchError }
) {
  return async (
    toolName: string,
    args: Record<string, unknown>
  ): Promise<{ content: unknown; isError?: boolean; mcpServer?: string }> => {
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
      clientId
    );
    const allowedTool = allowedTools.find(tool => tool.name === toolName);
    if (!allowedTool || (extraFilter && !extraFilter(allowedTool))) {
      throw new AuthorizationError('Tool not subscribed for this client');
    }

    if (isKilled(deps, clientId, allowedTool)) {
      const err = new KillSwitchError();
      if (killHit) killHit.err = err;
      throw err;
    }

    const sharedTool = deps.mcpManager.getToolDescriptor(toolName);
    const userTool = deps.userPool.getToolDescriptor(userId, toolName);

    let mcpResponse;
    if (sharedTool?.source_mcp === allowedTool.source_mcp) {
      mcpResponse = await deps.mcpManager.invokeTool(mcpRequest);
    } else if (userTool?.source_mcp === allowedTool.source_mcp) {
      mcpResponse = await deps.userPool.invokeTool(userId, mcpRequest);
    } else {
      throw new AuthorizationError('Tool source does not match client subscription');
    }

    return {
      content: mcpResponse.content,
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
  restriction: AgentToolRestriction
): Promise<ToolDescriptor[]> {
  const session = buildAgentSessionContext(agent);
  const aggregated = await deps.toolRouter.getIsolationAwareToolCatalog(
    deps.db,
    agent.user_id,
    agent.bound_client_id
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
        description: tool.description || '',
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
  sourceIp: string
): Promise<ToolInvocationResponse> {
  const killHit: { err?: KillSwitchError } = {};
  const router = buildInvocationRouter(
    deps,
    agent.user_id,
    agent.bound_client_id,
    t => agentMayUseTool(restriction, t),
    killHit
  );
  const result = await deps.pipeline.invoke(
    { tool_name: call.tool, client_id: agent.bound_client_id, arguments: call.arguments },
    { headers: {}, sourceIp } satisfies AuthRequest,
    router,
    undefined,
    undefined,
    { preAuthenticatedSession: agent }
  );
  if (killHit.err) throw killHit.err;
  return result;
}
