/**
 * User Session Middleware
 *
 * Session management for user authentication on the main server.
 * Implements session store, authentication middleware, and session augmentation.
 *
 * @see M21.3: User Session Middleware
 */

import type { FastifyInstance, FastifyRequest, FastifyReply, Session } from 'fastify';
import type { SessionStore } from '@fastify/session';
import fastifyCookie from '@fastify/cookie';
import fastifySession from '@fastify/session';
import { getOrCreateSessionSecret } from '../admin/session.js';

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
 * Bounded session store for user sessions
 *
 * Prevents memory exhaustion by limiting total session count.
 * Identical implementation to admin session store.
 */
export class UserSessionStore implements SessionStore {
  private store = new Map<string, Session>();
  private maxEntries: number;

  constructor(maxEntries = 1000) {
    this.maxEntries = maxEntries;
  }

  set(sessionId: string, session: Session, callback: (err?: unknown) => void): void {
    try {
      if (this.store.size >= this.maxEntries) {
        const firstKey = this.store.keys().next().value;
        if (firstKey) {
          this.store.delete(firstKey);
        }
      }
      this.store.set(sessionId, session);
      callback();
    } catch (err) {
      callback(err);
    }
  }

  get(sessionId: string, callback: (err: unknown, session?: Session | null) => void): void {
    try {
      const session = this.store.get(sessionId) ?? null;
      if (session) {
        // AUTH-001: LRU eviction - re-insert to move to end of Map iteration order
        this.store.delete(sessionId);
        this.store.set(sessionId, session);
      }
      callback(null, session);
    } catch (err) {
      callback(err);
    }
  }

  destroy(sessionId: string, callback: (err?: unknown) => void): void {
    try {
      this.store.delete(sessionId);
      callback();
    } catch (err) {
      callback(err);
    }
  }

  /**
   * Clear all sessions
   */
  clear(): void {
    this.store.clear();
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
    return reply.status(401).send({
      error: 'Unauthorized',
      message: 'Authentication required',
    });
  }
}

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
      maxAge: 28800000, // 8 hours in milliseconds
    },
    store: config.store,
    saveUninitialized: false, // Don't create session for unauthenticated requests
  });
}
