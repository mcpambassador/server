/**
 * Admin Session Routes
 *
 * Fastify plugin for user session management endpoints.
 * All routes require admin authentication (applied globally by parent plugin).
 *
 * @see M18.7: Admin Session Management
 * @see Architecture §16.4 Admin API Design Principles
 */

import crypto from 'crypto';
import type { FastifyInstance, FastifyPluginCallback } from 'fastify';
import type { DatabaseClient, AuditProvider } from '@mcpambassador/core';
import type { UserMcpPool } from '../downstream/user-mcp-pool.js';
import { createPaginationEnvelope } from './pagination.js';
import { wrapSuccess, wrapError, ErrorCodes } from './reply-envelope.js';
import {
  listSessionsQuerySchema,
  deleteSessionParamsSchema,
} from './schemas.js';
import { user_sessions, session_connections, compatUpdate } from '@mcpambassador/core';
import { eq, and, desc, asc } from 'drizzle-orm';

/**
 * Admin session routes plugin configuration
 */
export interface AdminSessionRoutesConfig {
  db: DatabaseClient;
  audit: AuditProvider;
  userPool: UserMcpPool | null;
}

/**
 * Admin session routes plugin
 */
export const registerAdminSessionRoutes: FastifyPluginCallback<AdminSessionRoutesConfig> = (
  fastify: FastifyInstance,
  opts: AdminSessionRoutesConfig,
  done
) => {
  const { db, audit, userPool } = opts;

  // ==========================================================================
  // M18.7: GET /v1/admin/sessions
  // ==========================================================================
  fastify.get('/v1/admin/sessions', async (request, reply) => {
    const query = listSessionsQuerySchema.parse(request.query);
    const limit = Math.min(query.limit || 20, 100);

    // Build where conditions
    const conditions: any[] = [];
    if (query.user_id) {
      conditions.push(eq(user_sessions.user_id, query.user_id));
    }
    if (query.status) {
      conditions.push(eq(user_sessions.status, query.status));
    }

    // Query with filters
    let sessionList = await db.query.user_sessions.findMany({
      where: conditions.length > 0 ? and(...conditions) : undefined,
      limit: limit + 1,
      orderBy: query.sort.includes('last_activity_at')
        ? query.sort === 'last_activity_at:desc'
          ? [desc(user_sessions.last_activity_at)]
          : [asc(user_sessions.last_activity_at)]
        : query.sort === 'created_at:desc'
          ? [desc(user_sessions.created_at)]
          : [asc(user_sessions.created_at)],
    });

    // Apply cursor filtering if provided
    if (query.cursor) {
      const cursorIndex = sessionList.findIndex(
        s => s.session_id === query.cursor || s.last_activity_at === query.cursor
      );
      if (cursorIndex >= 0) {
        sessionList = sessionList.slice(cursorIndex + 1);
      }
    }

    // Pagination
    const hasMore = sessionList.length > limit;
    const data = hasMore ? sessionList.slice(0, limit) : sessionList;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1]!.session_id : null;

    // For each session, count connected connections
    const sessionsWithConnections = await Promise.all(
      data.map(async session => {
        const connections = await db.query.session_connections.findMany({
          where: (c, { eq, and }) =>
            and(eq(c.session_id, session.session_id), eq(c.status, 'connected')),
        });

        // Strip sensitive fields
        const { session_token_hash, token_nonce, ...sessionInfo } = session;

        return {
          ...sessionInfo,
          connection_count: connections.length,
        };
      })
    );

    return reply.send(
      createPaginationEnvelope(sessionsWithConnections, {
        has_more: hasMore,
        next_cursor: nextCursor,
        total_count: sessionsWithConnections.length,
      })
    );
  });

  // ==========================================================================
  // M18.8: DELETE /v1/admin/sessions/:sessionId
  // ==========================================================================
  fastify.delete('/v1/admin/sessions/:sessionId', async (request, reply) => {
    const { sessionId } = deleteSessionParamsSchema.parse(request.params);

    // Check if session exists
    const session = await db.query.user_sessions.findFirst({
      where: (s, { eq }) => eq(s.session_id, sessionId),
    });

    if (!session) {
      return reply.status(404).send(
        wrapError(ErrorCodes.NOT_FOUND, 'Session not found')
      );
    }

    const nowIso = new Date().toISOString();

    // If already expired, return current state (idempotent)
    if (session.status === 'expired') {
      return reply.send(wrapSuccess({
        session_id: sessionId,
        status: 'expired',
        terminated_at: nowIso,
      }));
    }

    // Expire the session and disconnect all connections
    // Set session to expired
    await compatUpdate(db, user_sessions)
      .set({ status: 'expired' })
      .where(eq(user_sessions.session_id, sessionId));

    // Disconnect all connections
    await compatUpdate(db, session_connections)
      .set({ status: 'disconnected', disconnected_at: nowIso })
      .where(eq(session_connections.session_id, sessionId));

    // Terminate MCP instances for this user
    if (userPool) {
      await userPool.terminateForUser(session.user_id);
    }

    // Emit audit event
    await audit.emit({
      event_id: crypto.randomUUID(),
      timestamp: nowIso,
      event_type: 'admin_action',
      severity: 'info',
      client_id: undefined,
      user_id: session.user_id,
      source_ip: request.ip || '127.0.0.1',
      action: 'session_terminate',
      metadata: {
        session_id: sessionId,
        old_status: session.status,
      },
    });

    return reply.send(wrapSuccess({
      session_id: sessionId,
      status: 'expired',
      terminated_at: nowIso,
    }));
  });

  done();
};
