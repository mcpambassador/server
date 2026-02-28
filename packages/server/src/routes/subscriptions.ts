/**
 * Subscription Routes
 *
 * User self-service subscription management endpoints.
 * All routes require user session authentication.
 *
 * @see M25.5: Subscription Routes
 * @see Architecture §4.2 Client Subscription Management
 */

import type { FastifyInstance } from 'fastify';
import type { DatabaseClient } from '@mcpambassador/core';
import { getMcpEntryById } from '@mcpambassador/core';
import { requireUserSession } from '../auth/user-session.js';
import { wrapError, ErrorCodes } from '../admin/reply-envelope.js';
import {
  subscribeClientToMcp,
  updateSubscription,
  listClientSubscriptions,
  listUserSubscriptions,
  getSubscriptionDetail,
  removeSubscription,
} from '../services/subscription-service.js';
import {
  createSubscriptionSchema,
  updateSubscriptionSchema,
  subscriptionParamsSchema,
  clientSubscriptionParamsSchema,
} from './schemas.js';

export interface SubscriptionRoutesConfig {
  db: DatabaseClient;
}

/**
 * Register subscription routes
 */
export async function registerSubscriptionRoutes(
  fastify: FastifyInstance,
  config: SubscriptionRoutesConfig
): Promise<void> {
  const { db } = config;

  // ==========================================================================
  // GET /v1/users/me/clients/:clientId/subscriptions - List subscriptions
  // ==========================================================================
  fastify.get(
    '/v1/users/me/clients/:clientId/subscriptions',
    {
      preHandler: requireUserSession,
    },
    async (request, reply) => {
      const userId = request.session.userId!;
      const params = clientSubscriptionParamsSchema.parse(request.params);

      try {
        const subscriptions = await listClientSubscriptions(db, {
          userId,
          clientId: params.clientId,
        });

        // Transform snake_case to camelCase for SPA
        const transformedSubscriptions = subscriptions.map(sub => ({
          id: sub.subscription_id,
          clientId: sub.client_id,
          mcpId: sub.mcp_id,
          mcpName: sub.mcp_name,
          selectedTools: sub.selected_tools,
          status: sub.status,
          createdAt: sub.subscribed_at,
          updatedAt: sub.updated_at,
        }));

        return reply.status(200).send({
          ok: true,
          data: transformedSubscriptions,
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
  // GET /v1/users/me/subscriptions - List all subscriptions for the user (aggregate)
  // ==========================================================================
  fastify.get(
    '/v1/users/me/subscriptions',
    {
      preHandler: requireUserSession,
    },
    async (request, reply) => {
      const userId = request.session.userId!;

      const subscriptions = await listUserSubscriptions(db, userId);

      // Transform to camelCase for SPA
      const transformed = subscriptions.map(sub => ({
        id: sub.subscription_id,
        clientId: sub.client_id,
        mcpId: sub.mcp_id,
        mcpName: sub.mcp_name,
        selectedTools: sub.selected_tools,
        status: sub.status,
        createdAt: sub.subscribed_at,
        updatedAt: sub.updated_at,
      }));

      return reply.status(200).send({ ok: true, data: transformed });
    }
  );

  // ==========================================================================
  // POST /v1/users/me/clients/:clientId/subscriptions - Subscribe to MCP
  // ==========================================================================
  fastify.post(
    '/v1/users/me/clients/:clientId/subscriptions',
    {
      preHandler: requireUserSession,
    },
    async (request, reply) => {
      const userId = request.session.userId!;
      const params = clientSubscriptionParamsSchema.parse(request.params);

      try {
        const body = createSubscriptionSchema.parse(request.body);

        const subscription = await subscribeClientToMcp(db, {
          userId,
          clientId: params.clientId,
          mcpId: body.mcp_id,
          selectedTools: body.selected_tools,
        });

        // Fetch MCP name for response
        const mcp = await getMcpEntryById(db, body.mcp_id);
        const mcpName = mcp?.name || body.mcp_id;

        // Parse selected_tools if it's a JSON string
        let selectedTools: string[] = [];
        if (subscription.selected_tools) {
          selectedTools =
            typeof subscription.selected_tools === 'string'
              ? JSON.parse(subscription.selected_tools)
              : subscription.selected_tools;
        }

        // Transform to camelCase
        return reply.status(201).send({
          ok: true,
          data: {
            id: subscription.subscription_id,
            clientId: subscription.client_id,
            mcpId: subscription.mcp_id,
            mcpName,
            selectedTools,
            status: subscription.status,
            createdAt: subscription.subscribed_at,
            updatedAt: subscription.updated_at,
          },
        });
      } catch (error: any) {
        if (error.message.includes('not found')) {
          return reply.status(404).send(wrapError(ErrorCodes.NOT_FOUND, error.message));
        }
        if (
          error.message.includes('access denied') ||
          error.message.includes('does not have access')
        ) {
          return reply.status(403).send(wrapError(ErrorCodes.FORBIDDEN, error.message));
        }
        if (error.message.includes('already subscribed') || error.message.includes('requires')) {
          return reply.status(400).send(wrapError(ErrorCodes.BAD_REQUEST, error.message));
        }
        throw error;
      }
    }
  );

  // ==========================================================================
  // GET /v1/users/me/clients/:clientId/subscriptions/:subscriptionId - Get detail
  // ==========================================================================
  fastify.get(
    '/v1/users/me/clients/:clientId/subscriptions/:subscriptionId',
    {
      preHandler: requireUserSession,
    },
    async (request, reply) => {
      const userId = request.session.userId!;
      const params = subscriptionParamsSchema.parse(request.params);

      try {
        const subscription = await getSubscriptionDetail(db, {
          userId,
          clientId: params.clientId,
          subscriptionId: params.subscriptionId,
        });

        // Transform to camelCase
        return reply.status(200).send({
          ok: true,
          data: {
            id: subscription.subscription_id,
            clientId: subscription.client_id,
            mcpId: subscription.mcp_id,
            mcpName: subscription.mcp_name,
            selectedTools: subscription.selected_tools,
            status: subscription.status,
            createdAt: subscription.subscribed_at,
            updatedAt: subscription.updated_at,
          },
        });
      } catch (error: any) {
        if (error.message.includes('not found') || error.message.includes('does not belong')) {
          return reply.status(404).send(wrapError(ErrorCodes.NOT_FOUND, 'Subscription not found'));
        }
        throw error;
      }
    }
  );

  // ==========================================================================
  // PATCH /v1/users/me/clients/:clientId/subscriptions/:subscriptionId - Update
  // ==========================================================================
  fastify.patch(
    '/v1/users/me/clients/:clientId/subscriptions/:subscriptionId',
    {
      preHandler: requireUserSession,
    },
    async (request, reply) => {
      const userId = request.session.userId!;
      const params = subscriptionParamsSchema.parse(request.params);

      try {
        const body = updateSubscriptionSchema.parse(request.body);

        await updateSubscription(db, {
          userId,
          clientId: params.clientId,
          subscriptionId: params.subscriptionId,
          selectedTools: body.selected_tools,
          status: body.status,
        });

        const subscription = await getSubscriptionDetail(db, {
          userId,
          clientId: params.clientId,
          subscriptionId: params.subscriptionId,
        });

        // Transform to camelCase
        return reply.status(200).send({
          ok: true,
          data: {
            id: subscription.subscription_id,
            clientId: subscription.client_id,
            mcpId: subscription.mcp_id,
            mcpName: subscription.mcp_name,
            selectedTools: subscription.selected_tools,
            status: subscription.status,
            createdAt: subscription.subscribed_at,
            updatedAt: subscription.updated_at,
          },
        });
      } catch (error: any) {
        if (error.message.includes('not found') || error.message.includes('does not belong')) {
          return reply.status(404).send(wrapError(ErrorCodes.NOT_FOUND, 'Subscription not found'));
        }
        throw error;
      }
    }
  );

  // ==========================================================================
  // DELETE /v1/users/me/clients/:clientId/subscriptions/:subscriptionId - Remove
  // ==========================================================================
  fastify.delete(
    '/v1/users/me/clients/:clientId/subscriptions/:subscriptionId',
    {
      preHandler: requireUserSession,
    },
    async (request, reply) => {
      const userId = request.session.userId!;
      const params = subscriptionParamsSchema.parse(request.params);

      try {
        await removeSubscription(db, {
          userId,
          clientId: params.clientId,
          subscriptionId: params.subscriptionId,
        });

        return reply.status(204).send();
      } catch (error: any) {
        if (error.message.includes('not found') || error.message.includes('does not belong')) {
          return reply.status(404).send(wrapError(ErrorCodes.NOT_FOUND, 'Subscription not found'));
        }
        throw error;
      }
    }
  );

  console.log('[SubscriptionRoutes] Registered subscription management routes');
}
