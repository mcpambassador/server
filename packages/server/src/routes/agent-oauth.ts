/**
 * ADR-020 Authorization Server + agent-grant routes (9443) — CONTRACT STUBS (501).
 * Registered only when agent_endpoint.enabled; otherwise the paths 404.
 */

/* eslint-disable @typescript-eslint/require-await */
import type { FastifyInstance } from 'fastify';
import {
  OAUTH_AS_METADATA_ROUTE,
  OAUTH_AUTHORIZE_ROUTE,
  OAUTH_AUTHORIZE_CONSENT_ROUTE,
  OAUTH_TOKEN_ROUTE,
  OAUTH_REGISTER_ROUTE,
  OAUTH_REVOKE_ROUTE,
  AGENT_GRANTS_ROUTE,
  AGENT_GRANT_ROUTE,
  ADMIN_OAUTH_CLIENTS_ROUTE,
  ADMIN_OAUTH_CLIENT_ROUTE,
  ADMIN_AGENT_ENDPOINT_SETTINGS_ROUTE,
  type OAuthErrorResponse,
} from '@mcpambassador/contracts';
import { wrapError } from '../admin/reply-envelope.js';
import type { AgentEndpointDeps } from '../services/agent-endpoint/index.js';

export async function registerAgentOAuthRoutes(
  app: FastifyInstance,
  deps: AgentEndpointDeps
): Promise<void> {
  void deps;
  const oauth501: OAuthErrorResponse = {
    error: 'temporarily_unavailable',
    error_description: 'not implemented',
  };
  const env501 = wrapError('not_implemented', 'Not implemented');

  app.get(OAUTH_AS_METADATA_ROUTE, async (_req, reply) => reply.status(501).send(oauth501));
  app.get(OAUTH_AUTHORIZE_ROUTE, async (_req, reply) => reply.status(501).send(oauth501));
  app.post(OAUTH_AUTHORIZE_CONSENT_ROUTE, async (_req, reply) => reply.status(501).send(env501));
  app.post(OAUTH_TOKEN_ROUTE, async (_req, reply) => reply.status(501).send(oauth501));
  app.post(OAUTH_REGISTER_ROUTE, async (_req, reply) => reply.status(501).send(oauth501));
  app.post(OAUTH_REVOKE_ROUTE, async (_req, reply) => reply.status(501).send(oauth501));

  app.post(AGENT_GRANTS_ROUTE, async (_req, reply) => reply.status(501).send(env501));
  app.get(AGENT_GRANTS_ROUTE, async (_req, reply) => reply.status(501).send(env501));
  app.delete(AGENT_GRANT_ROUTE, async (_req, reply) => reply.status(501).send(env501));

  app.get(ADMIN_OAUTH_CLIENTS_ROUTE, async (_req, reply) => reply.status(501).send(env501));
  app.post(ADMIN_OAUTH_CLIENTS_ROUTE, async (_req, reply) => reply.status(501).send(env501));
  app.delete(ADMIN_OAUTH_CLIENT_ROUTE, async (_req, reply) => reply.status(501).send(env501));
  app.get(ADMIN_AGENT_ENDPOINT_SETTINGS_ROUTE, async (_req, reply) =>
    reply.status(501).send(env501)
  );
  app.put(ADMIN_AGENT_ENDPOINT_SETTINGS_ROUTE, async (_req, reply) =>
    reply.status(501).send(env501)
  );
}
