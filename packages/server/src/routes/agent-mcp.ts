/**
 * ADR-020 MCP resource server (8443): Streamable HTTP, stateless, JSON responses.
 * Registered only when agent_endpoint.enabled; otherwise the paths 404.
 *
 * Security properties:
 * - Every request re-validates the bearer token via validateAgentToken (no cache).
 * - Cookies never apply (registerCookieFreeGuard); tokens in the query string are rejected.
 * - Tool listing/calling = grant scopes ∩ bound client's live permissions ∩ allowlist, through the
 *   same catalog/authz/pipeline path as the stdio client. The AgentSession handed to the pipeline is
 *   built here from the validated token only, never from request data.
 * - The MCP SDK is isolated to this file.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import {
  AuthorizationError,
  ValidationError,
  logger,
  type AgentSession,
} from '@mcpambassador/core';
import type { AgentAuthFailureReason } from '@mcpambassador/contracts';
import {
  AGENT_MCP_ROUTE,
  OAUTH_PROTECTED_RESOURCE_ROUTE,
  OAUTH_PROTECTED_RESOURCE_MCP_ROUTE,
} from '@mcpambassador/contracts';
import {
  emitAgentAudit,
  touchGrant,
  validateAgentToken,
  type AgentEndpointDeps,
  type AgentPrincipal,
} from '../services/agent-endpoint/index.js';
import {
  invokeAgentTool,
  listAgentTools,
  type AgentToolRestriction,
  type ToolServiceDeps,
} from '../services/tool-service.js';
import type { UserMcpPool } from '../downstream/index.js';
import { registerCookieFreeGuard } from './agent-oauth.js';

/** Server-side capabilities the /mcp route needs beyond the OAuth deps */
export interface AgentMcpHost {
  toolDeps: ToolServiceDeps;
  /** Pool whose activity clock is bumped so agent use keeps per-user MCPs alive (S6) */
  userPool: UserMcpPool;
  /** Spawn the user's per-user MCPs if they are not running (idempotent) */
  ensureUserMcps(userId: string): Promise<void>;
}

const SERVER_INFO = { name: 'mcp-ambassador', version: '1.0.0' } as const;

/** Methods present in a JSON-RPC body (object or batch) */
function rpcMethods(body: unknown): string[] {
  const one = (m: unknown): string[] =>
    m && typeof m === 'object' && typeof (m as { method?: unknown }).method === 'string'
      ? [(m as { method: string }).method]
      : [];
  return Array.isArray(body) ? body.flatMap(one) : one(body);
}

function bearerFrom(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m ? (m[1] ?? null) : null;
}

const QUERY_TOKEN_RE = /[?&](access_token|token|bearer_token|api_key)=/i;

function jsonRpcError(code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', error: { code, message }, id: null };
}

export async function registerAgentMcpRoutes(
  app: FastifyInstance,
  deps: AgentEndpointDeps,
  host: AgentMcpHost
): Promise<void> {
  // S5: cookie sessions never apply on /mcp
  registerCookieFreeGuard(app);

  const { config } = deps;
  const rl = config.rate_limits;

  // ----- Protected resource metadata (RFC 9728) -----
  const metadata = (): Record<string, unknown> => ({
    resource: config.resource,
    authorization_servers: [config.issuer],
    scopes_supported: ['mcp:*'],
    bearer_methods_supported: ['header'],
    resource_name: 'MCP Ambassador',
  });
  const sendMetadata = (_req: FastifyRequest, reply: FastifyReply): FastifyReply =>
    reply.header('Cache-Control', 'public, max-age=300').send(metadata());
  app.get(OAUTH_PROTECTED_RESOURCE_ROUTE, sendMetadata);
  app.get(OAUTH_PROTECTED_RESOURCE_MCP_ROUTE, sendMetadata);

  // ----- Auth -----
  const challenge = (error?: 'invalid_token' | 'insufficient_scope'): string =>
    `Bearer resource_metadata="${config.protectedResourceMetadataUrl}"` +
    (error ? `, error="${error}"` : '');

  async function fail(
    req: FastifyRequest,
    reply: FastifyReply,
    reason: AgentAuthFailureReason,
    principal?: AgentPrincipal
  ): Promise<FastifyReply> {
    await emitAgentAudit(deps, 'agent_auth_failure', {
      ...(principal
        ? { user_id: principal.user_id, bound_client_id: principal.bound_client_id }
        : {}),
      source_ip: req.ip,
      severity: 'warn',
      metadata: { reason, ...(principal ? { agent_grant_id: principal.grant_id } : {}) },
    });
    if (reason === 'bad_origin') {
      return reply.status(403).send(jsonRpcError(-32000, 'Origin not allowed'));
    }
    if (reason === 'token_in_query') {
      return reply.status(400).send(jsonRpcError(-32000, 'Tokens must not be sent in the URL'));
    }
    if (reason === 'insufficient_scope') {
      return reply
        .status(403)
        .header('WWW-Authenticate', challenge('insufficient_scope'))
        .send(jsonRpcError(-32000, 'Insufficient scope'));
    }
    // Failed-auth throttle per IP (counts failures only)
    if (!deps.limiter.allow(`mcp_fail:${req.ip}`, rl.failed_auth_per_minute, 60_000)) {
      return reply
        .status(429)
        .header('Retry-After', '60')
        .send(jsonRpcError(-32000, 'Too many failed authentication attempts'));
    }
    return reply
      .status(401)
      .header(
        'WWW-Authenticate',
        challenge(reason === 'missing_token' ? undefined : 'invalid_token')
      )
      .send(jsonRpcError(-32001, 'Unauthorized'));
  }

  /** Runs on every /mcp method. Returns the principal, or null after having replied. */
  async function authenticate(
    req: FastifyRequest,
    reply: FastifyReply
  ): Promise<AgentPrincipal | null> {
    // Browser contexts: exact-match Origin allowlist (DNS-rebinding / CSRF defence)
    const origin = req.headers.origin;
    if (typeof origin === 'string' && !config.allowed_origins.includes(origin)) {
      await fail(req, reply, 'bad_origin');
      return null;
    }
    if (QUERY_TOKEN_RE.test(req.url)) {
      await fail(req, reply, 'token_in_query');
      return null;
    }
    const token = bearerFrom(req);
    if (!token) {
      await fail(req, reply, 'missing_token');
      return null;
    }
    const result = await validateAgentToken(deps, token);
    if (!result.ok) {
      await fail(req, reply, result.reason);
      return null;
    }
    const p = result.principal;
    if (!p.scopes.some(s => s === 'mcp:*' || s.startsWith('mcp:'))) {
      await fail(req, reply, 'insufficient_scope', p);
      return null;
    }
    return p;
  }

  const toAgentSession = (p: AgentPrincipal): AgentSession => ({
    user_id: p.user_id,
    bound_client_id: p.bound_client_id,
    grant_id: p.grant_id,
    scopes: p.scopes,
  });
  const restrictionOf = (p: AgentPrincipal): AgentToolRestriction => ({
    scopes: p.scopes,
    tool_allowlist: p.tool_allowlist,
  });

  /** S6: agent use spawns the user's MCPs and counts as activity for the lifecycle manager */
  async function prepareUser(p: AgentPrincipal): Promise<void> {
    host.userPool.markActivity(p.user_id);
    await host.ensureUserMcps(p.user_id);
    host.userPool.markActivity(p.user_id);
  }

  function buildServer(p: AgentPrincipal, sourceIp: string): Server {
    const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });
    const agent = toAgentSession(p);
    const restriction = restrictionOf(p);

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      await prepareUser(p);
      const tools = await listAgentTools(host.toolDeps, agent, restriction);
      return {
        tools: tools.map(t => ({
          name: t.name,
          description: t.description,
          inputSchema: (t.input_schema as { type: 'object' }) ?? { type: 'object' },
        })),
      };
    });

    server.setRequestHandler(CallToolRequestSchema, async (call): Promise<CallToolResult> => {
      const text = (msg: string): CallToolResult => ({
        content: [{ type: 'text', text: msg }],
        isError: true,
      });
      try {
        await prepareUser(p);
        const response = await invokeAgentTool(
          host.toolDeps,
          agent,
          restriction,
          { tool: call.params.name, arguments: call.params.arguments ?? {} },
          sourceIp
        );
        const err = response.metadata?.error;
        if (err) return text(typeof err === 'string' ? err : 'Tool invocation failed');
        const result = response.result;
        const content = Array.isArray(result)
          ? (result as CallToolResult['content'])
          : [{ type: 'text' as const, text: JSON.stringify(result ?? null) }];
        return { content, isError: response.metadata?.is_error === true };
      } catch (e) {
        if (e instanceof AuthorizationError) return text('Tool not permitted');
        if (e instanceof ValidationError) return text(e.message);
        logger.error(`[agent-mcp] tools/call failed: ${String(e)}`);
        return text('Tool invocation failed');
      }
    });
    return server;
  }

  // ----- POST /mcp -----
  app.post(AGENT_MCP_ROUTE, async (req, reply) => {
    const p = await authenticate(req, reply);
    if (!p) return reply;
    await touchGrant(deps, p.grant_id);

    // Rate limit tools/call per grant and per user (before doing any work)
    const calls = rpcMethods(req.body).filter(m => m === 'tools/call').length;
    for (let i = 0; i < calls; i++) {
      const ok =
        deps.limiter.allow(
          `mcp_call_grant:${p.grant_id}`,
          rl.tool_calls_per_minute_per_grant,
          60_000
        ) &&
        deps.limiter.allow(`mcp_call_user:${p.user_id}`, rl.tool_calls_per_minute_per_user, 60_000);
      if (!ok) {
        return reply
          .status(429)
          .header('Retry-After', '60')
          .send(jsonRpcError(-32000, 'Rate limit exceeded'));
      }
    }

    // Concurrency cap per grant (max_streams_per_grant); revocation aborts in-flight requests
    const raw = reply.raw;
    const release = deps.streams.acquire(p.grant_id, config.max_streams_per_grant, () => {
      raw.destroy();
    });
    if (!release) {
      return reply
        .status(429)
        .header('Retry-After', '1')
        .send(jsonRpcError(-32000, 'Too many concurrent requests for this grant'));
    }

    const server = buildServer(p, req.ip);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
    });
    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      release();
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    };
    raw.on('close', cleanup);

    try {
      await server.connect(transport);
      reply.hijack();
      raw.setHeader('Cache-Control', 'no-store');
      await transport.handleRequest(req.raw, raw, req.body);
    } catch (e) {
      logger.error(`[agent-mcp] request failed: ${String(e)}`);
      if (!raw.headersSent) {
        raw.statusCode = 500;
        raw.setHeader('Content-Type', 'application/json');
        raw.end(JSON.stringify(jsonRpcError(-32603, 'Internal error')));
      } else {
        raw.destroy();
      }
    } finally {
      cleanup();
    }
    return reply;
  });

  // ----- GET / DELETE /mcp: stateless server — no standalone SSE stream, no sessions -----
  const notAllowed = async (req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const p = await authenticate(req, reply);
    if (!p) return reply;
    return reply
      .status(405)
      .header('Allow', 'POST')
      .send(jsonRpcError(-32000, 'Method not allowed: this MCP endpoint is stateless (POST only)'));
  };
  app.get(AGENT_MCP_ROUTE, notAllowed);
  app.delete(AGENT_MCP_ROUTE, notAllowed);
}
