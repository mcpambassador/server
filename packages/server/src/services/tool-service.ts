/**
 * Tool service — shared tool discovery and invocation logic.
 *
 * Extracted from the `/v1/tools` and `/v1/tools/invoke` route handlers (ADR-020) so
 * the remote agent endpoint (`/mcp`) goes through exactly the same catalog filtering,
 * authorization, routing and audit path as the stdio-client HTTP API.
 */

import {
  AuthorizationError,
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
export function buildInvocationRouter(deps: ToolServiceDeps, userId: string, clientId: string) {
  return async (
    toolName: string,
    args: Record<string, unknown>
  ): Promise<{ content: unknown; isError?: boolean; mcpServer?: string }> => {
    const mcpRequest = { tool_name: toolName, arguments: args };

    const allowedTools = await deps.toolRouter.getIsolationAwareToolCatalog(
      deps.db,
      userId,
      clientId
    );
    const allowedTool = allowedTools.find(tool => tool.name === toolName);
    if (!allowedTool) {
      throw new AuthorizationError('Tool not subscribed for this client');
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
  const router = buildInvocationRouter(deps, userId, clientId);
  return deps.pipeline.invoke(pipelineRequest, authRequest, router);
}
