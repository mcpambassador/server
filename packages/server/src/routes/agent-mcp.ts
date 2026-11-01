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
import { logger, type AgentSession } from '@mcpambassador/core';
import {
  AGENT_MCP_ROUTE,
  APPROVAL_ID_META_KEY,
  APPROVAL_ID_PATTERN,
  type AgentAuthFailureReason,
  OAUTH_PROTECTED_RESOURCE_ROUTE,
  OAUTH_PROTECTED_RESOURCE_MCP_ROUTE,
} from '@mcpambassador/contracts';
import {
  emitAgentAudit,
  logPrefix,
  touchGrant,
  validateAgentToken,
  type AgentEndpointDeps,
  type AgentPrincipal,
} from '../services/agent-endpoint/index.js';
import {
  agentScopeAllows,
  listAgentTools,
  type AgentToolRestriction,
  type ToolServiceDeps,
} from '../services/tool-service.js';
import {
  META_TOOL_DEFINITIONS,
  META_TOOL_DESCRIBE,
  META_TOOL_SEARCH,
  handleMetaTool,
  isMetaToolName,
  runToolCall,
  targetsOfToolCall,
  type MetaToolContext,
} from '../services/agent-endpoint/meta-tools.js';
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

/**
 * Tools that tools/call requests in a JSON-RPC body (object or batch) target. `ambassador__call_tool` is
 * unwrapped exactly one level (ADR-022 P2) so a call outside the grant's scopes cannot hide behind it.
 */
function toolCallTargets(body: unknown): Array<{ name: string; mcp?: string; wrapped: boolean }> {
  const items = Array.isArray(body) ? body : [body];
  const out: Array<{ name: string; mcp?: string; wrapped: boolean }> = [];
  for (const m of items) {
    if (!m || typeof m !== 'object') continue;
    const o = m as { method?: unknown; params?: unknown };
    if (o.method === 'tools/call') out.push(...targetsOfToolCall(o.params));
  }
  return out;
}

/** Names of tools/call requests as sent (not unwrapped): used to weight rate limits */
function rawCallNames(body: unknown): string[] {
  const items = Array.isArray(body) ? body : [body];
  const out: string[] = [];
  for (const m of items) {
    if (!m || typeof m !== 'object') continue;
    const o = m as { method?: unknown; params?: { name?: unknown } };
    if (o.method === 'tools/call')
      out.push(typeof o.params?.name === 'string' ? o.params.name : '');
  }
  return out;
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
  const challenge = (error?: 'invalid_token'): string =>
    `Bearer resource_metadata="${config.protectedResourceMetadataUrl}"` +
    (error ? `, error="${error}"` : '');

  async function fail(
    req: FastifyRequest,
    reply: FastifyReply,
    reason: AgentAuthFailureReason,
    opts: { principal?: AgentPrincipal; token?: string | null; scope?: string } = {}
  ): Promise<FastifyReply> {
    const { principal, token, scope } = opts;
    await emitAgentAudit(deps, 'agent_auth_failure', {
      ...(principal
        ? { user_id: principal.user_id, bound_client_id: principal.bound_client_id }
        : {}),
      source_ip: req.ip,
      severity: 'warn',
      metadata: {
        reason,
        ...(token ? { token_prefix: logPrefix(token) } : {}),
        ...(principal ? { agent_grant_id: principal.grant_id } : {}),
        ...(scope ? { required_scope: scope } : {}),
      },
    });
    if (reason === 'bad_origin') {
      return reply.status(403).send(jsonRpcError(-32000, 'Origin not allowed'));
    }
    if (reason === 'token_in_query') {
      // Treated as "no credentials presented": 401 (never echo or honour a URL token)
      return reply
        .status(401)
        .header(
          'WWW-Authenticate',
          `Bearer error="invalid_request", error_description="tokens must not be sent in the URL", resource_metadata="${config.protectedResourceMetadataUrl}"`
        )
        .send(jsonRpcError(-32000, 'Tokens must not be sent in the URL'));
    }
    if (reason === 'insufficient_scope') {
      return reply
        .status(403)
        .header(
          'WWW-Authenticate',
          `Bearer error="insufficient_scope"${scope ? `, scope="${scope}"` : ''}, resource_metadata="${config.protectedResourceMetadataUrl}"`
        )
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
      await fail(req, reply, 'bad_origin', { token: bearerFrom(req) });
      return null;
    }
    if (QUERY_TOKEN_RE.test(req.url)) {
      await fail(req, reply, 'token_in_query', { token: bearerFrom(req) });
      return null;
    }
    const token = bearerFrom(req);
    if (!token) {
      await fail(req, reply, 'missing_token');
      return null;
    }
    const result = await validateAgentToken(deps, token);
    if (!result.ok) {
      await fail(req, reply, result.reason, { token });
      return null;
    }
    const p = result.principal;
    if (!p.scopes.some(s => s === 'mcp:*' || s.startsWith('mcp:'))) {
      await fail(req, reply, 'insufficient_scope', { principal: p, token });
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

    const metaCtx = (approvalId?: string): MetaToolContext => ({
      ...(approvalId !== undefined ? { approvalId } : {}),
      deps: host.toolDeps,
      agent,
      restriction,
      mode: p.disclosure_mode,
      sourceIp,
      auditDiscovery: metadata =>
        emitAgentAudit(deps, 'agent_tool_discovery', {
          user_id: p.user_id,
          bound_client_id: p.bound_client_id,
          source_ip: sourceIp,
          metadata: {
            agent_grant_id: p.grant_id,
            disclosure_mode: p.disclosure_mode,
            ...metadata,
          },
        }),
    });

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      // ADR-022: progressive grants see only the three fixed, server-authored meta-tools
      if (p.disclosure_mode === 'progressive') {
        return {
          tools: META_TOOL_DEFINITIONS.map(t => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        };
      }
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
      try {
        await prepareUser(p);
      } catch (e) {
        logger.error(`[agent-mcp] tools/call failed: ${String(e)}`);
        return { content: [{ type: 'text', text: 'Tool invocation failed' }], isError: true };
      }
      // ADR-023: read the agent's approval id (status polling) BEFORE anything drops the `ambassador/`
      // namespace. Only the request's own `_meta` is read; `_meta` is never forwarded downstream.
      const rawApprovalId = (call.params._meta as Record<string, unknown> | undefined)?.[
        APPROVAL_ID_META_KEY
      ];
      const approvalId =
        typeof rawApprovalId === 'string' && APPROVAL_ID_PATTERN.test(rawApprovalId)
          ? rawApprovalId
          : undefined;
      // P1: a name in the reserved set always dispatches to the meta-tool (never to a downstream tool)
      if (isMetaToolName(call.params.name)) {
        return handleMetaTool(metaCtx(approvalId), call.params.name, call.params.arguments);
      }
      return runToolCall(metaCtx(approvalId), call.params.name, call.params.arguments ?? {}, {});
    });
    return server;
  }

  // ----- POST /mcp -----
  // Auth runs in onRequest (before content-type negotiation and body parsing) so an unauthenticated
  // POST without/with a bad content-type gets 401 and an auth-failure audit, not 415/400.
  const authenticated = new WeakMap<FastifyRequest, AgentPrincipal>();
  app.post(
    AGENT_MCP_ROUTE,
    {
      onRequest: async (req, reply) => {
        const principal = await authenticate(req, reply);
        if (!principal) return reply;
        authenticated.set(req, principal);
        return undefined;
      },
    },
    async (req, reply) => {
      const p = authenticated.get(req);
      if (!p) return reply.status(401).send(jsonRpcError(-32001, 'Unauthorized'));
      await touchGrant(deps, p.grant_id);

      // A tool outside the token's scopes is an auth failure (403 insufficient_scope), not a tool error.
      // Allowlist and kill-switch denials stay JSON-RPC tool results (same text as /v1/tools/invoke).
      const targets = toolCallTargets(req.body);
      if (targets.length > 0) {
        await prepareUser(p);
        // keepShadowed: same-named tools of different MCPs stay visible so ambassador__call_tool's
        // optional `mcp` is checked against the MCP it names (direct calls keep first-wins below)
        const catalog = await host.toolDeps.toolRouter.getIsolationAwareToolCatalog(
          host.toolDeps.db,
          p.user_id,
          p.bound_client_id,
          { keepShadowed: true }
        );
        for (const target of targets) {
          const cands = catalog.filter(
            t => t.name === target.name && (target.mcp === undefined || t.source_mcp === target.mcp)
          );
          // Direct call: the first-wins tool is the one that would run. Wrapped call: the resolver may pick
          // any permitted candidate, so it is denied only when every candidate is out of scope.
          const denied = target.wrapped
            ? cands.length > 0 && cands.every(t => !agentScopeAllows(p.scopes, t))
            : cands.length > 0 && !agentScopeAllows(p.scopes, cands[0]!);
          if (denied) {
            return fail(req, reply, 'insufficient_scope', {
              principal: p,
              token: bearerFrom(req),
              scope: `mcp:${cands[0]!.source_mcp}`,
            });
          }
        }
      }

      // Rate limit tools/call per grant and per user (before doing any work)
      // ADR-022: search/describe draw from their own bucket at half the weight of a call (2x the limit),
      // so enumeration is cheaper than calling but still bounded; call_tool counts as a call.
      const callNames = rawCallNames(req.body);
      for (const callName of callNames) {
        if (callName === META_TOOL_SEARCH || callName === META_TOOL_DESCRIBE) {
          if (
            !deps.limiter.allow(
              `mcp_disc_grant:${p.grant_id}`,
              rl.tool_calls_per_minute_per_grant * 2,
              60_000
            )
          ) {
            return reply
              .status(429)
              .header('Retry-After', '60')
              .send(jsonRpcError(-32000, 'Rate limit exceeded'));
          }
          continue;
        }
        const ok =
          deps.limiter.allow(
            `mcp_call_grant:${p.grant_id}`,
            rl.tool_calls_per_minute_per_grant,
            60_000
          ) &&
          deps.limiter.allow(
            `mcp_call_user:${p.user_id}`,
            rl.tool_calls_per_minute_per_user,
            60_000
          );
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
        const handled = transport.handleRequest(req.raw, raw, req.body);
        // The SDK wraps req/res with @hono/node-server's listener, which learns the body was consumed
        // only from the incoming stream's 'end' event. Fastify already consumed it (req.body is
        // parsed), so 'end' fired before hono subscribed; hono then "drains" the request after the
        // response and, 500ms later, calls socket.destroySoon(). On real sockets IncomingMessage is
        // already destroyed (hono no-ops), but on inject()/light-my-request streams it is not and the
        // fake socket has no destroySoon (unhandled TypeError). handleRequest has subscribed
        // synchronously by now, so tell hono the body is already fully read.
        if (req.raw.readableEnded) req.raw.emit('end');
        await handled;
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
    }
  );

  // ----- GET / DELETE /mcp: stateless server — no standalone SSE stream, no sessions -----
  // Auth runs in onRequest so an unauthenticated DELETE/GET gets 401 before body parsing (an empty
  // JSON body would otherwise 400 first).
  // Authenticated GET/DELETE answer 405 straight from onRequest, before body parsing (a JSON
  // content-type with an empty body would otherwise 400 first).
  const authOnRequest = async (req: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const p = await authenticate(req, reply);
    if (!p) return reply;
    return reply
      .status(405)
      .header('Allow', 'POST')
      .send(jsonRpcError(-32000, 'Method not allowed: this MCP endpoint is stateless (POST only)'));
  };
  const unreachable = async (_req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> =>
    reply;
  app.get(AGENT_MCP_ROUTE, { onRequest: authOnRequest }, unreachable);
  app.delete(AGENT_MCP_ROUTE, { onRequest: authOnRequest }, unreachable);
}
