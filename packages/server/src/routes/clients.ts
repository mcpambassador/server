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
import {
  createUserClient,
  listUserClients,
  getUserClient,
  suspendUserClient,
  revokeUserClient,
  updateUserClientName,
} from '../services/client-service.js';
import {
  createClientSchema,
  updateClientSchema,
  clientIdParamsSchema,
} from './schemas.js';

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

      return reply.status(200).send({
        data: clients,
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

        const result = await createUserClient(db, {
          userId,
          clientName: body.client_name,
          profileId: body.profile_id,
        });

        return reply.status(201).send({
          data: {
            client_id: result.client.client_id,
            client_name: result.client.client_name,
            key_prefix: result.client.key_prefix,
            user_id: result.client.user_id,
            profile_id: result.client.profile_id,
            status: result.client.status,
            created_at: result.client.created_at,
            expires_at: result.client.expires_at,
            plaintext_key: result.plaintextKey, // ONLY returned here
          },
        });
      } catch (error: any) {
        // Handle Zod validation errors
        if (error.name === 'ZodError') {
          return reply.status(400).send({
            error: 'Bad Request',
            message: 'Invalid request data',
            details: error.errors,
          });
        }
        
        if (error.message.includes('not found')) {
          return reply.status(400).send({
            error: 'Bad Request',
            message: error.message,
          });
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
      const params = clientIdParamsSchema.parse(request.params);

      try {
        const client = await getUserClient(db, userId, params.clientId);

        return reply.status(200).send({
          data: client,
        });
      } catch (error: any) {
        if (error.message.includes('not found') || error.message.includes('access denied')) {
          return reply.status(404).send({
            error: 'Not Found',
            message: 'Client not found',
          });
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
      const params = clientIdParamsSchema.parse(request.params);

      try {
        const body = updateClientSchema.parse(request.body);

        if (body.client_name) {
          await updateUserClientName(db, userId, params.clientId, body.client_name);
        }

        if (body.status === 'suspended') {
          await suspendUserClient(db, userId, params.clientId);
        }

        const client = await getUserClient(db, userId, params.clientId);

        return reply.status(200).send({
          data: client,
        });
      } catch (error: any) {
        if (error.message.includes('not found') || error.message.includes('access denied')) {
          return reply.status(404).send({
            error: 'Not Found',
            message: 'Client not found',
          });
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
      const params = clientIdParamsSchema.parse(request.params);

      try {
        await revokeUserClient(db, userId, params.clientId);

        return reply.status(204).send();
      } catch (error: any) {
        if (error.message.includes('not found') || error.message.includes('access denied')) {
          return reply.status(404).send({
            error: 'Not Found',
            message: 'Client not found',
          });
        }
        throw error;
      }
    }
  );

  console.log('[ClientRoutes] Registered client management routes');
}
