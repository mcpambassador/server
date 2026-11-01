/**
 * ADR-020 MCP resource-server routes (8443) — CONTRACT STUBS (501).
 * Registered only when agent_endpoint.enabled; otherwise the paths 404.
 */

/* eslint-disable @typescript-eslint/require-await */
import type { FastifyInstance } from 'fastify';
import {
  AGENT_MCP_ROUTE,
  OAUTH_PROTECTED_RESOURCE_ROUTE,
  OAUTH_PROTECTED_RESOURCE_MCP_ROUTE,
} from '@mcpambassador/contracts';
import type { AgentEndpointDeps } from '../services/agent-endpoint/index.js';

export async function registerAgentMcpRoutes(
  app: FastifyInstance,
  deps: AgentEndpointDeps
): Promise<void> {
  void deps;
  const stub = { error: 'not_implemented', message: 'Not implemented' };
  app.get(OAUTH_PROTECTED_RESOURCE_ROUTE, async (_req, reply) => reply.status(501).send(stub));
  app.get(OAUTH_PROTECTED_RESOURCE_MCP_ROUTE, async (_req, reply) => reply.status(501).send(stub));
  app.post(AGENT_MCP_ROUTE, async (_req, reply) => reply.status(501).send(stub));
  app.get(AGENT_MCP_ROUTE, async (_req, reply) => reply.status(501).send(stub));
  app.delete(AGENT_MCP_ROUTE, async (_req, reply) => reply.status(501).send(stub));
}
