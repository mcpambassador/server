/**
 * Client Routes
 *
 * User self-service client management endpoints.
 * All routes require user session authentication.
 *
 * @see M25.4: Client Routes
 * @see Architecture §4.1 Client Key Management
 */

import type { FastifyInstance } from 'fastify';
import type { DatabaseClient } from '@mcpambassador/core';
import { requireUserSession } from '../auth/user-session.js';
import { wrapError, ErrorCodes } from '../admin/reply-envelope.js';
import {
  createUserClient,
  listUserClients,
  getUserClient,
  suspendUserClient,
  reactivateUserClient,
  revokeUserClient,
  updateUserClientName,
} from '../services/client-service.js';
import { createClientSchema, updateClientSchema, clientIdParamsSchema } from './schemas.js';

export interface ClientRoutesConfig {
  db: DatabaseClient;
}

/**
 * Register client routes
 */
export async function registerClientRoutes(
  fastify: FastifyInstance,
  config: ClientRoutesConfig
): Promise<void> {
  const { db } = config;

  // ==========================================================================
  // GET /v1/users/me/clients - List user's clients
  // ==========================================================================
  fastify.get(
    '/v1/users/me/clients',
    {
      preHandler: requireUserSession,
    },
    async (request, reply) => {
      const userId = request.session.userId!;

      const clients = await listUserClients(db, userId);

      // Transform snake_case to camelCase for SPA
      const transformedClients = clients.map((client: any) => ({
        id: client.client_id,
        clientName: client.client_name,
        keyPrefix: client.key_prefix,
        status: client.status,
        profileId: client.profile_id || undefined,
        createdAt: client.created_at,
        expiresAt: client.expires_at || undefined,
        lastUsedAt: client.last_used_at || undefined,
      }));

      return reply.status(200).send({
        ok: true,
        data: transformedClients,
      });
    }
  );

  // ==========================================================================
  // POST /v1/users/me/clients - Create a new client
  // ==========================================================================
  fastify.post(
    '/v1/users/me/clients',
    {
      preHandler: requireUserSession,
    },
    async (request, reply) => {
      const userId = request.session.userId!;

      try {
        const body = createClientSchema.parse(request.body);

        // Auto-assign 'all-tools' profile if not provided
        let profileId = body.profile_id || null;
        if (!profileId) {
          const defaultProfile = await db.query.tool_profiles.findFirst({
            where: (p, { eq }) => eq(p.name, 'all-tools'),
          });
          if (defaultProfile) {
            profileId = defaultProfile.profile_id;
          }
        }

        const result = await createUserClient(db, {
          userId,
          clientName: body.client_name,
          profileId,
          expiresAt: body.expires_at || null,
        });

        // Transform response to match SPA expectations
        return reply.status(201).send({
          ok: true,
          data: {
            client: {
              id: result.client.client_id,
              clientName: result.client.client_name,
              keyPrefix: result.client.key_prefix,
              status: result.client.status,
              profileId: result.client.profile_id || undefined,
              createdAt: result.client.created_at,
              expiresAt: result.client.expires_at || undefined,
            },
            plaintext_key: result.plaintextKey, // ONLY returned here
          },
        });
      } catch (error: any) {
        // Handle Zod validation errors
        if (error.name === 'ZodError') {
          return reply
            .status(400)
            .send(wrapError(ErrorCodes.VALIDATION_ERROR, 'Invalid request data', error.errors));
        }

        if (error.message.includes('not found')) {
          return reply.status(400).send(wrapError(ErrorCodes.BAD_REQUEST, error.message));
        }
        throw error;
      }
    }
  );

  // ==========================================================================
  // GET /v1/users/me/clients/:clientId - Get client detail
  // ==========================================================================
  fastify.get(
    '/v1/users/me/clients/:clientId',
    {
      preHandler: requireUserSession,
    },
    async (request, reply) => {
      const userId = request.session.userId!;
      const isAdmin = request.session.isAdmin || false;
      const params = clientIdParamsSchema.parse(request.params);

      try {
        const client = await getUserClient(db, userId, params.clientId, isAdmin);

        // Transform to camelCase
        return reply.status(200).send({
          ok: true,
          data: {
            id: client.client_id,
            clientName: client.client_name,
            keyPrefix: client.key_prefix,
            status: client.status,
            profileId: client.profile_id || undefined,
            createdAt: client.created_at,
            expiresAt: client.expires_at || undefined,
            lastUsedAt: client.last_used_at || undefined,
          },
        });
      } catch (error: any) {
        if (error.message.includes('not found') || error.message.includes('access denied')) {
          return reply.status(404).send(wrapError(ErrorCodes.NOT_FOUND, 'Client not found'));
        }
        throw error;
      }
    }
  );

  // ==========================================================================
  // PATCH /v1/users/me/clients/:clientId - Update client
  // ==========================================================================
  fastify.patch(
    '/v1/users/me/clients/:clientId',
    {
      preHandler: requireUserSession,
    },
    async (request, reply) => {
      const userId = request.session.userId!;
      const isAdmin = request.session.isAdmin || false;
      const params = clientIdParamsSchema.parse(request.params);

      try {
        const body = updateClientSchema.parse(request.body);

        if (body.client_name) {
          await updateUserClientName(db, userId, params.clientId, body.client_name, isAdmin);
        }

        if (body.status === 'suspended') {
          await suspendUserClient(db, userId, params.clientId, isAdmin);
        } else if (body.status === 'active') {
          await reactivateUserClient(db, userId, params.clientId, isAdmin);
        }

        const client = await getUserClient(db, userId, params.clientId, isAdmin);

        // Transform to camelCase
        return reply.status(200).send({
          ok: true,
          data: {
            id: client.client_id,
            clientName: client.client_name,
            keyPrefix: client.key_prefix,
            status: client.status,
            profileId: client.profile_id || undefined,
            createdAt: client.created_at,
            expiresAt: client.expires_at || undefined,
            lastUsedAt: client.last_used_at || undefined,
          },
        });
      } catch (error: any) {
        if (error.message.includes('not found') || error.message.includes('access denied')) {
          return reply.status(404).send(wrapError(ErrorCodes.NOT_FOUND, 'Client not found'));
        }
        if (error.message.includes('Invalid state transition')) {
          return reply.status(409).send(wrapError(ErrorCodes.CONFLICT, error.message));
        }
        throw error;
      }
    }
  );

  // ==========================================================================
  // DELETE /v1/users/me/clients/:clientId - Revoke client
  // ==========================================================================
  fastify.delete(
    '/v1/users/me/clients/:clientId',
    {
      preHandler: requireUserSession,
    },
    async (request, reply) => {
      const userId = request.session.userId!;
      const isAdmin = request.session.isAdmin || false;
      const params = clientIdParamsSchema.parse(request.params);

      try {
        await revokeUserClient(db, userId, params.clientId, isAdmin);

        return reply.status(204).send();
      } catch (error: any) {
        if (error.message.includes('not found') || error.message.includes('access denied')) {
          return reply.status(404).send(wrapError(ErrorCodes.NOT_FOUND, 'Client not found'));
        }
        throw error;
      }
    }
  );

  console.log('[ClientRoutes] Registered client management routes');
}
