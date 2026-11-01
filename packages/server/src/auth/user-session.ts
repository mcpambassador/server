/**
 * User Session Middleware
 *
 * Session management for user authentication on the main server.
 * Implements session store, authentication middleware, and session augmentation.
 *
 * @see M21.3: User Session Middleware
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifySession from '@fastify/session';
import { BoundedSessionStore, getOrCreateSessionSecret } from '../admin/session.js';
import { wrapError, ErrorCodes } from '../admin/reply-envelope.js';

// Augment Fastify Session interface with user fields
declare module 'fastify' {
  interface Session {
    userId?: string;
    username?: string;
    isAdmin?: boolean;
    displayName?: string;
  }
}

/**
 * Bounded session store for user sessions (same implementation as the admin store,
 * including the absolute TTL).
 */
export class UserSessionStore extends BoundedSessionStore {
  constructor(maxEntries = 1000, ttlSeconds?: number | null, clock?: () => number) {
    super(maxEntries, ttlSeconds, clock);
  }
}

/**
 * Require user session middleware
 *
 * Checks if request has valid user session (userId present).
 * Returns 401 Unauthorized if not authenticated.
 */
export async function requireUserSession(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  if (!request.session.userId) {
    return reply.status(401).send(wrapError(ErrorCodes.UNAUTHORIZED, 'Authentication required'));
  }
}

/** Default session TTL (8 hours); mirrors the config schema default */
const DEFAULT_SESSION_TTL_SECONDS = 28800;

/**
 * Register user session on Fastify instance
 *
 * Registers @fastify/cookie and @fastify/session with appropriate configuration.
 *
 * @param fastify - Fastify instance to register session on
 * @param config - Session configuration
 */
export async function registerUserSession(
  fastify: FastifyInstance,
  config: {
    dataDir: string;
    store: UserSessionStore;
    /** Cookie lifetime in seconds; derived from config session.ui_ttl_seconds (default 8h) */
    ttlSeconds?: number;
  }
): Promise<void> {
  // Register cookie support
  await fastify.register(fastifyCookie);

  // Register session with secure settings
  await fastify.register(fastifySession, {
    secret: getOrCreateSessionSecret(config.dataDir),
    cookie: {
      secure: true,
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      maxAge: (config.ttlSeconds ?? DEFAULT_SESSION_TTL_SECONDS) * 1000,
    },
    rolling: false, // absolute TTL: activity must not extend the cookie
    store: config.store,
    saveUninitialized: false, // Don't create session for unauthenticated requests
  });
}
