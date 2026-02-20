/**
 * Admin Client Routes
 *
 * Fastify plugin for client API key management endpoints.
 * All routes require admin authentication (applied globally by parent plugin).
 *
 * @see M18.4-M18.6: Client API Key Management
 * @see Architecture §16.4 Admin API Design Principles
 */

import crypto from 'crypto';
import argon2 from 'argon2';
import type { FastifyInstance, FastifyPluginCallback } from 'fastify';
import type { DatabaseClient, AuditProvider } from '@mcpambassador/core';
import type { UserMcpPool } from '../downstream/user-mcp-pool.js';
import { createPaginationEnvelope } from './pagination.js';
import { wrapSuccess, wrapError, ErrorCodes } from './reply-envelope.js';
import {
  createClientSchema,
  updateClientSchema,
  updateClientParamsSchema,
  listClientKeysQuerySchema,
} from './schemas.js';
import { clients, compatInsert, compatUpdate } from '@mcpambassador/core';
import { eq, and, or, desc, asc } from 'drizzle-orm';
import { user_sessions } from '@mcpambassador/core';

/**
 * Admin client routes plugin configuration
 */
export interface AdminClientRoutesConfig {
  db: DatabaseClient;
  audit: AuditProvider;
  userPool: UserMcpPool | null;
}

/**
 * Admin client routes plugin
 */
export const registerAdminClientRoutes: FastifyPluginCallback<AdminClientRoutesConfig> = (
  fastify: FastifyInstance,
  opts: AdminClientRoutesConfig,
  done
) => {
  const { db, audit, userPool } = opts;

  // ==========================================================================
  // M18.4: POST /v1/admin/clients
  // ==========================================================================
  fastify.post('/v1/admin/clients', async (request, reply) => {
    const body = createClientSchema.parse(request.body);

    // Verify user exists and is active
    const userRecord = await db.query.users.findFirst({
      where: (u, { eq }) => eq(u.user_id, body.user_id),
    });

    if (!userRecord) {
      return reply.status(400).send(
        wrapError(ErrorCodes.BAD_REQUEST, 'User not found')
      );
    }

    if (userRecord.status !== 'active') {
      return reply.status(400).send(
        wrapError(ErrorCodes.BAD_REQUEST, 'User is not active')
      );
    }

    // Verify profile exists
    const profile = await db.query.tool_profiles.findFirst({
      where: (p, { eq }) => eq(p.profile_id, body.profile_id),
    });

    if (!profile) {
      return reply.status(400).send(
        wrapError(ErrorCodes.BAD_REQUEST, 'Profile not found')
      );
    }

    // Generate preshared key: amb_pk_ + 48 chars of base64url
    const randomBytes = crypto.randomBytes(36); // 36 bytes → 48 base64 chars
    const base64url = randomBytes
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
    const clientKey = `amb_pk_${base64url}`;

    // Extract prefix: first 8 chars after amb_pk_
    const keyPrefix = base64url.substring(0, 8);

    // Hash with Argon2id
    const keyHash = await argon2.hash(clientKey, {
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });

    const clientId = crypto.randomUUID();
    const nowIso = new Date().toISOString();

    await compatInsert(db, clients).values({
      client_id: clientId,
      key_prefix: keyPrefix,
      key_hash: keyHash,
      client_name: body.client_name,
      user_id: body.user_id,
      profile_id: body.profile_id,
      status: 'active',
      created_by: 'admin', // TODO: Get actual admin user_id from auth context
      created_at: nowIso,
      expires_at: body.expires_at || null,
      metadata: '{}',
    });

    // Emit audit event (NEVER log the plaintext key!)
    await audit.emit({
      event_id: crypto.randomUUID(),
      timestamp: nowIso,
      event_type: 'admin_action',
      severity: 'info',
      client_id: undefined,
      user_id: body.user_id,
      source_ip: request.ip || '127.0.0.1',
      action: 'client_create',
      metadata: {
        client_id: clientId,
        client_name: body.client_name,
        user_id: body.user_id,
        profile_id: body.profile_id,
      },
    });

    const createdKey = await db.query.clients.findFirst({
      where: (k, { eq }) => eq(k.client_id, clientId),
    });

    // Return key info WITH plaintext key (only time it's ever returned)
    return reply.status(201).send(wrapSuccess({
      client_id: createdKey!.client_id,
      key_prefix: createdKey!.key_prefix,
      client_name: createdKey!.client_name,
      user_id: createdKey!.user_id,
      profile_id: createdKey!.profile_id,
      status: createdKey!.status,
      created_at: createdKey!.created_at,
      expires_at: createdKey!.expires_at,
      plaintext_key: clientKey, // ONLY returned here, never stored
    }));
  });

  // ==========================================================================
  // M18.5: GET /v1/admin/clients
  // ==========================================================================
  fastify.get('/v1/admin/clients', async (request, reply) => {
    const query = listClientKeysQuerySchema.parse(request.query);
    const limit = Math.min(query.limit || 20, 100);

    // Build where conditions
    const conditions: any[] = [];
    if (query.user_id) {
      conditions.push(eq(clients.user_id, query.user_id));
    }
    if (query.status) {
      conditions.push(eq(clients.status, query.status));
    }

    // Query with filters
    let keyList = await db.query.clients.findMany({
      where: conditions.length > 0 ? and(...conditions) : undefined,
      limit: limit + 1,
      orderBy: query.sort.includes('created_at')
        ? query.sort === 'created_at:desc'
          ? [desc(clients.created_at)]
          : [asc(clients.created_at)]
        : query.sort === 'client_name:desc'
          ? [desc(clients.client_name)]
          : [asc(clients.client_name)],
    });

    // Apply cursor filtering if provided
    if (query.cursor) {
      const cursorIndex = keyList.findIndex(
        k => k.client_id === query.cursor || k.created_at === query.cursor
      );
      if (cursorIndex >= 0) {
        keyList = keyList.slice(cursorIndex + 1);
      }
    }

    // Pagination
    const hasMore = keyList.length > limit;
    const data = hasMore ? keyList.slice(0, limit) : keyList;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1]!.client_id : null;

    // Strip key_hash from response (never expose hashes)
    const sanitizedData = data.map(k => {
      const { key_hash, ...rest } = k;
      return rest;
    });

    return reply.send(
      createPaginationEnvelope(sanitizedData, {
        has_more: hasMore,
        next_cursor: nextCursor,
        total_count: sanitizedData.length,
      })
    );
  });

  // ==========================================================================
  // M18.6: PATCH /v1/admin/clients/:clientId
  // ==========================================================================
  fastify.patch('/v1/admin/clients/:clientId', async (request, reply) => {
    const { clientId } = updateClientParamsSchema.parse(request.params);
    const body = updateClientSchema.parse(request.body);

    // Check if key exists
    const key = await db.query.clients.findFirst({
      where: (k, { eq }) => eq(k.client_id, clientId),
    });

    if (!key) {
      return reply.status(404).send(
        wrapError(ErrorCodes.NOT_FOUND, 'Client key not found')
      );
    }

    // If profile_id is being changed, verify it exists
    if (body.profile_id !== undefined) {
      const profile = await db.query.tool_profiles.findFirst({
        where: (p, { eq }) => eq(p.profile_id, body.profile_id!),
      });

      if (!profile) {
        return reply.status(400).send(
          wrapError(ErrorCodes.BAD_REQUEST, 'Profile not found')
        );
      }
    }

    const oldStatus = key.status;
    const statusChanged = body.status !== undefined && body.status !== oldStatus;

    const updates: Record<string, unknown> = {};
    if (body.status !== undefined) updates.status = body.status;
    if (body.profile_id !== undefined) updates.profile_id = body.profile_id;

    // If status changes to revoked, expire all sessions for this key's user
    if (statusChanged && body.status === 'revoked') {
      // Update key
      await compatUpdate(db, clients)
        .set(updates)
        .where(eq(clients.client_id, clientId));

      // Expire all active sessions for this key's user
      await compatUpdate(db, user_sessions)
        .set({ status: 'expired' })
        .where(
          and(
            eq(user_sessions.user_id, key.user_id),
            or(
              eq(user_sessions.status, 'active'),
              eq(user_sessions.status, 'idle'),
              eq(user_sessions.status, 'spinning_down')
            )
          )
        );

      // Terminate MCP instances (outside transaction)
      if (userPool) {
        await userPool.terminateForUser(key.user_id);
      }
    } else {
      // Normal update
      await compatUpdate(db, clients)
        .set(updates)
        .where(eq(clients.client_id, clientId));
    }

    const nowIso = new Date().toISOString();

    // Emit audit event
    await audit.emit({
      event_id: crypto.randomUUID(),
      timestamp: nowIso,
      event_type: 'admin_action',
      severity: 'info',
      client_id: undefined,
      user_id: key.user_id,
      source_ip: request.ip || '127.0.0.1',
      action: 'client_update',
      metadata: {
        client_id: clientId,
        changes: Object.keys(updates),
        old_status: oldStatus,
        new_status: body.status,
      },
    });

    const updatedKey = await db.query.clients.findFirst({
      where: (k, { eq }) => eq(k.client_id, clientId),
    });

    // Strip key_hash from response
    const { key_hash, ...keyInfo } = updatedKey!;

    return reply.send(wrapSuccess(keyInfo));
  });

  done();
};
