/**
 * ADR-020 built-in Authorization Server + agent-grant APIs (9443).
 * Registered only when agent_endpoint.enabled; otherwise the paths 404.
 *
 *  - /oauth/* and /.well-known/oauth-authorization-server: RFC-style bodies (not the envelope)
 *  - /v1/oauth/consent, /v1/users/me/agent-grants: user session (+ CSRF via the admin hook)
 *  - /v1/admin/*: admin session (+ CSRF)
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import {
  OAUTH_AS_METADATA_ROUTE,
  OAUTH_AUTHORIZE_ROUTE,
  OAUTH_CONSENT_ROUTE,
  OAUTH_TOKEN_ROUTE,
  OAUTH_REGISTER_ROUTE,
  OAUTH_REVOKE_ROUTE,
  AGENT_GRANTS_ROUTE,
  AGENT_GRANT_ROUTE,
  ADMIN_OAUTH_CLIENTS_ROUTE,
  ADMIN_OAUTH_CLIENT_ROUTE,
  ADMIN_AGENT_GRANTS_ROUTE,
  ADMIN_AGENT_GRANT_ROUTE,
  ADMIN_AGENT_ENDPOINT_SETTINGS_ROUTE,
  SPA_CONSENT_ROUTE,
  authorizeQuerySchema,
  tokenRequestSchema,
  consentDecisionSchema,
  clientRegistrationRequestSchema,
  revokeRequestSchema,
  createGrantRequestSchema,
  adminCreateClientRequestSchema,
  adminPatchClientRequestSchema,
  adminListGrantsQuerySchema,
  adminUpdateSettingsRequestSchema,
} from '@mcpambassador/contracts';
import { logger, sweepExpiredAgentRecords } from '@mcpambassador/core';
import { wrapSuccess, wrapPaginated, wrapError, ErrorCodes } from '../admin/reply-envelope.js';
import { requireUserSession } from '../auth/user-session.js';
import { requireAdmin } from '../auth/admin-middleware.js';
import {
  type AgentEndpointDeps,
  OAuthError,
  AgentApiError,
  buildAuthorizationServerMetadata,
  startAuthorization,
  getConsentDetails,
  decideConsent,
  exchangeToken,
  registerClient,
  revokeToken,
  createGrant,
  listGrants,
  revokeGrant,
  adminListClients,
  adminCreateClient,
  adminSetClientDisabled,
  adminDeleteClient,
  adminListGrants,
  getSettings,
  updateSettings,
} from '../services/agent-endpoint/index.js';

const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

function oauthFail(reply: FastifyReply, err: unknown): FastifyReply {
  reply.header('Cache-Control', 'no-store').header('Pragma', 'no-cache');
  if (err instanceof OAuthError) {
    if (err.error === 'invalid_client' && err.status === 401) {
      reply.header('WWW-Authenticate', 'Basic realm="oauth"');
    }
    return reply.status(err.status).send(err.toBody());
  }
  if (err instanceof ZodError) {
    return reply.status(400).send({
      error: 'invalid_request',
      error_description: err.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '),
    });
  }
  logger.error(`[AgentOAuth] unexpected error: ${String(err)}`);
  return reply.status(500).send({ error: 'server_error' });
}

function apiFail(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof AgentApiError) {
    return reply.status(err.status).send(wrapError(err.code, err.message));
  }
  if (err instanceof ZodError) {
    return reply
      .status(400)
      .send(
        wrapError(
          ErrorCodes.VALIDATION_ERROR,
          err.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
        )
      );
  }
  logger.error(`[AgentOAuth] unexpected error: ${String(err)}`);
  return reply.status(500).send(wrapError(ErrorCodes.INTERNAL_ERROR, 'Internal error'));
}

const ipOf = (req: FastifyRequest): string => req.ip ?? 'unknown';

/** Parses the body as an object whether it came as form-encoded or JSON */
function bodyObject(req: FastifyRequest): Record<string, unknown> {
  const b = req.body;
  return b && typeof b === 'object' ? (b as Record<string, unknown>) : {};
}

export async function registerAgentOAuthRoutes(
  app: FastifyInstance,
  deps: AgentEndpointDeps
): Promise<void> {
  // RFC 6749 requires application/x-www-form-urlencoded at the token/revoke/register endpoints
  if (!app.hasContentTypeParser('application/x-www-form-urlencoded')) {
    app.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: 16 * 1024 },
      (_req, body, done) => {
        try {
          done(null, Object.fromEntries(new URLSearchParams(body as string)));
        } catch (e) {
          done(e as Error, undefined);
        }
      }
    );
  }

  // ---- Authorization server metadata (RFC 8414) ----
  app.get(OAUTH_AS_METADATA_ROUTE, async (_req, reply) =>
    reply
      .header('Cache-Control', 'public, max-age=300')
      .send(buildAuthorizationServerMetadata(deps))
  );

  // ---- /oauth/authorize ----
  app.get(OAUTH_AUTHORIZE_ROUTE, async (req, reply) => {
    try {
      // Per-IP limit: the browser may not have a session yet when it first lands here
      if (
        !deps.limiter.allow(
          `authorize:${ipOf(req)}`,
          deps.config.rate_limits.authorize_per_minute,
          60_000
        )
      ) {
        throw new OAuthError('temporarily_unavailable', 'Rate limit exceeded', 429);
      }
      const parsed = authorizeQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new OAuthError(
          'invalid_request',
          parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
        );
      }
      const { requestId } = await startAuthorization(deps, parsed.data);
      // Relative redirect: the SPA lives on the same origin as this listener
      return reply
        .header('Cache-Control', 'no-store')
        .redirect(`${SPA_CONSENT_ROUTE}?request_id=${encodeURIComponent(requestId)}`, 302);
    } catch (err) {
      return oauthFail(reply, err);
    }
  });

  // ---- Consent (user session) ----
  app.get(OAUTH_CONSENT_ROUTE, { preHandler: requireUserSession }, async (req, reply) => {
    try {
      const { requestId } = req.params as { requestId: string };
      return reply.send(wrapSuccess(await getConsentDetails(deps, req.session.userId!, requestId)));
    } catch (err) {
      return apiFail(reply, err);
    }
  });
  app.post(OAUTH_CONSENT_ROUTE, { preHandler: requireUserSession }, async (req, reply) => {
    try {
      const { requestId } = req.params as { requestId: string };
      const body = consentDecisionSchema.parse(req.body);
      return reply.send(
        wrapSuccess(await decideConsent(deps, req.session.userId!, requestId, body, ipOf(req)))
      );
    } catch (err) {
      return apiFail(reply, err);
    }
  });

  // ---- /oauth/token ----
  app.post(OAUTH_TOKEN_ROUTE, async (req, reply) => {
    try {
      const parsed = tokenRequestSchema.safeParse(bodyObject(req));
      if (!parsed.success) {
        const gt = bodyObject(req)['grant_type'];
        if (gt !== 'authorization_code' && gt !== 'refresh_token') {
          throw new OAuthError('unsupported_grant_type', 'Unsupported grant_type');
        }
        throw new OAuthError(
          'invalid_request',
          parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
        );
      }
      const out = await exchangeToken(deps, parsed.data, ipOf(req));
      return reply.header('Cache-Control', 'no-store').header('Pragma', 'no-cache').send(out);
    } catch (err) {
      return oauthFail(reply, err);
    }
  });

  // ---- /oauth/register (RFC 7591; gated) ----
  app.post(OAUTH_REGISTER_ROUTE, async (req, reply) => {
    try {
      const body = clientRegistrationRequestSchema.safeParse(bodyObject(req));
      if (!body.success) {
        throw new OAuthError(
          'invalid_client_metadata',
          body.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
        );
      }
      const out = await registerClient(deps, body.data, ipOf(req));
      return reply.status(201).header('Cache-Control', 'no-store').send(out);
    } catch (err) {
      return oauthFail(reply, err);
    }
  });

  // ---- /oauth/revoke (RFC 7009) ----
  app.post(OAUTH_REVOKE_ROUTE, async (req, reply) => {
    try {
      const parsed = revokeRequestSchema.safeParse(bodyObject(req));
      if (!parsed.success)
        throw new OAuthError('invalid_request', 'token and client_id are required');
      if (
        !deps.limiter.allow(
          `token:${ipOf(req)}:${parsed.data.client_id}`,
          deps.config.rate_limits.token_per_minute,
          60_000
        )
      ) {
        throw new OAuthError('temporarily_unavailable', 'Rate limit exceeded', 429);
      }
      await revokeToken(deps, parsed.data, ipOf(req));
      return reply.status(200).header('Cache-Control', 'no-store').send();
    } catch (err) {
      return oauthFail(reply, err);
    }
  });

  // ---- User grants ----
  app.post(AGENT_GRANTS_ROUTE, { preHandler: requireUserSession }, async (req, reply) => {
    try {
      const body = createGrantRequestSchema.parse(req.body);
      const out = await createGrant(deps, req.session.userId!, body, ipOf(req));
      return reply.status(201).header('Cache-Control', 'no-store').send(wrapSuccess(out));
    } catch (err) {
      return apiFail(reply, err);
    }
  });
  app.get(AGENT_GRANTS_ROUTE, { preHandler: requireUserSession }, async (req, reply) => {
    try {
      const items = await listGrants(deps, req.session.userId!);
      return reply.send(
        wrapPaginated(items, { has_more: false, total_count: items.length, next_cursor: null })
      );
    } catch (err) {
      return apiFail(reply, err);
    }
  });
  app.delete(AGENT_GRANT_ROUTE, { preHandler: requireUserSession }, async (req, reply) => {
    try {
      const { grantId } = req.params as { grantId: string };
      const out = await revokeGrant(
        deps,
        { user_id: req.session.userId!, admin: false },
        grantId,
        ipOf(req)
      );
      return reply.send(wrapSuccess(out));
    } catch (err) {
      return apiFail(reply, err);
    }
  });

  // ---- Admin ----
  const adminOnly = [requireUserSession, requireAdmin];

  app.get(ADMIN_OAUTH_CLIENTS_ROUTE, { preHandler: adminOnly }, async (_req, reply) => {
    try {
      const items = await adminListClients(deps);
      return reply.send(
        wrapPaginated(items, { has_more: false, total_count: items.length, next_cursor: null })
      );
    } catch (err) {
      return apiFail(reply, err);
    }
  });
  app.post(ADMIN_OAUTH_CLIENTS_ROUTE, { preHandler: adminOnly }, async (req, reply) => {
    try {
      const body = adminCreateClientRequestSchema.parse(req.body);
      const out = await adminCreateClient(deps, req.session.userId!, body, ipOf(req));
      return reply.status(201).send(wrapSuccess(out));
    } catch (err) {
      return apiFail(reply, err);
    }
  });
  app.patch(ADMIN_OAUTH_CLIENT_ROUTE, { preHandler: adminOnly }, async (req, reply) => {
    try {
      const { clientId } = req.params as { clientId: string };
      const body = adminPatchClientRequestSchema.parse(req.body);
      const out = await adminSetClientDisabled(
        deps,
        req.session.userId!,
        clientId,
        body.disabled,
        ipOf(req)
      );
      return reply.send(wrapSuccess(out));
    } catch (err) {
      return apiFail(reply, err);
    }
  });
  app.delete(ADMIN_OAUTH_CLIENT_ROUTE, { preHandler: adminOnly }, async (req, reply) => {
    try {
      const { clientId } = req.params as { clientId: string };
      await adminDeleteClient(deps, req.session.userId!, clientId, ipOf(req));
      return reply.status(204).send();
    } catch (err) {
      return apiFail(reply, err);
    }
  });
  app.get(ADMIN_AGENT_GRANTS_ROUTE, { preHandler: adminOnly }, async (req, reply) => {
    try {
      const q = adminListGrantsQuerySchema.parse(req.query);
      const r = await adminListGrants(deps, q);
      return reply.send(
        wrapPaginated(r.items, {
          has_more: r.next_cursor !== null,
          total_count: r.total,
          next_cursor: r.next_cursor,
        })
      );
    } catch (err) {
      return apiFail(reply, err);
    }
  });
  app.delete(ADMIN_AGENT_GRANT_ROUTE, { preHandler: adminOnly }, async (req, reply) => {
    try {
      const { grantId } = req.params as { grantId: string };
      const out = await revokeGrant(
        deps,
        { user_id: req.session.userId!, admin: true },
        grantId,
        ipOf(req)
      );
      return reply.send(wrapSuccess(out));
    } catch (err) {
      return apiFail(reply, err);
    }
  });
  app.get(ADMIN_AGENT_ENDPOINT_SETTINGS_ROUTE, { preHandler: adminOnly }, async (_req, reply) =>
    reply.send(wrapSuccess(getSettings(deps)))
  );
  app.put(ADMIN_AGENT_ENDPOINT_SETTINGS_ROUTE, { preHandler: adminOnly }, async (req, reply) => {
    try {
      const body = adminUpdateSettingsRequestSchema.parse(req.body);
      return reply.send(
        wrapSuccess(await updateSettings(deps, req.session.userId!, body, ipOf(req)))
      );
    } catch (err) {
      return apiFail(reply, err);
    }
  });

  // ---- Periodic sweep of expired codes/requests/tokens/grants ----
  const timer = setInterval(() => {
    sweepExpiredAgentRecords(deps.db, new Date()).catch(err =>
      logger.error(`[AgentOAuth] sweep failed: ${String(err)}`)
    );
  }, SWEEP_INTERVAL_MS);
  timer.unref();
  app.addHook('onClose', async () => {
    clearInterval(timer);
  });
}
