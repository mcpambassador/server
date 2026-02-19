/**
 * Admin UI Routes - HTML Page Rendering
 *
 * Renders full HTML pages using EJS templates.
 * All routes except /admin/login require authenticated session.
 *
 * @see ADR-007 Admin UI Technology Selection (EJS + htmx)
 * @see ADR-008 Admin UI Routing
 */

// Fastify preHandler hooks accept async functions but ESLint's no-misused-promises
// reports false positives for Fastify's route option typing. Same pattern as routes.ts.
/* eslint-disable @typescript-eslint/no-misused-promises */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { DatabaseClient, AuditProvider } from '@mcpambassador/core';
import type { SharedMcpManager } from '../downstream/index.js';
import type { KillSwitchManager } from './kill-switch-manager.js';
import type { BoundedSessionStore } from './session.js';
import {
  authenticateAdminKey,
  users,
  preshared_keys,
  user_sessions,
  session_connections,
  compatInsert,
  compatUpdate,
} from '@mcpambassador/core';
import { LoginRateLimiter } from './session.js';
import crypto from 'node:crypto';
import { eq, and, or } from 'drizzle-orm';
import {
  getDashboardData,
  getClients,
  getProfiles,
  getProfile,
  getKillSwitches,
  getAuditLog,
  getUsers,
  getPresharedKeys,
  getSessions,
  formatTimestamp,
} from './helpers.js';

// Extend session type to include our custom properties
declare module 'fastify' {
  interface Session {
    isAdmin?: boolean;
    flash?: {
      type: 'error' | 'success' | 'info';
      message: string;
    };
    generatedKey?: string;
  }
}

export interface UiRoutesOptions {
  db: DatabaseClient;
  mcpManager: SharedMcpManager;
  dataDir: string;
  audit: AuditProvider; // F-SEC-M10-004
  killSwitchManager: KillSwitchManager; // CR-M10-001
  sessionStore: BoundedSessionStore; // F-SEC-M10-005
  userPool?: import('../downstream/user-mcp-pool.js').UserMcpPool | null; // M18: CR fix
}

/**
 * Check if request has authenticated admin session
 */
function isAuthenticated(request: FastifyRequest): boolean {
  return request.session?.isAdmin === true;
}

/**
 * CR-M10-009: Extract flash message helper to eliminate duplication
 * Returns flash message and removes it from session
 * Note: Currently only applied to login page. Will be applied to other routes as needed.
 */
function extractFlash(request: FastifyRequest): { type: string; message: string } | undefined {
  const flash = request.session.flash;
  delete request.session.flash;
  return flash;
}

/**
 * Middleware: Require authenticated session
 */
async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!isAuthenticated(request)) {
    await reply.redirect(302, '/admin/login');
  }
}

/**
 * Register admin UI routes
 */
export async function registerUiRoutes(
  fastify: FastifyInstance,
  opts: UiRoutesOptions
): Promise<void> {
  const { db, mcpManager, userPool, audit } = opts;
  const rateLimiter = new LoginRateLimiter();

  // ==========================================================================
  // PUBLIC ROUTES
  // ==========================================================================

  /**
   * GET /admin/login - Login page
   */
  fastify.get('/admin/login', (request, reply) => {
    // If already authenticated, redirect to dashboard
    if (isAuthenticated(request)) {
      return reply.redirect(302, '/admin/dashboard');
    }
    const flash = extractFlash(request);

    return reply.view('login', {
      flash,
      title: 'Admin Login',
    });
  });

  /**
   * POST /admin/login - Handle login form submission
   * F-SEC-M10-004: Session regeneration + audit events
   * CR-M10-004: Consistent error handling (redirect+flash)
   * CR-M10-005: Refactored for clarity
   */
  fastify.post<{ Body: { admin_key?: string } }>('/admin/login', async (request, reply) => {
    const sourceIp = request.ip || '0.0.0.0';
    const { admin_key: adminKey } = request.body;

    // F-SEC-M10-004: Check rate limit with audit event on brute force
    if (rateLimiter.isRateLimited(sourceIp)) {
      const retryAfter = rateLimiter.getRetryAfter(sourceIp);
      
      // Emit brute force detection audit event
      await opts.audit.emit({
        event_id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        event_type: 'error',
        severity: 'critical',
        client_id: undefined,
        user_id: undefined,
        source_ip: sourceIp,
        action: 'brute_force_detected',
        metadata: { retry_after: retryAfter },
      });

      // CR-M10-004: Use redirect+flash instead of JSON for consistency
      request.session.flash = {
        type: 'error',
        message: `Too many failed login attempts. Try again in ${retryAfter} seconds.`,
      };
      return reply.redirect(302, '/admin/login');
    }

    // F-SEC-M10-006: Apply progressive delay before authentication attempt
    const delayMs = rateLimiter.getDelayMs(sourceIp);
    if (delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }

    // Validate input
    if (!adminKey || typeof adminKey !== 'string') {
      rateLimiter.recordFailure(sourceIp);
      
      // F-SEC-M10-004: Emit login failure audit event
      await opts.audit.emit({
        event_id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        event_type: 'auth_failure',
        severity: 'warn',
        client_id: undefined,
        user_id: undefined,
        source_ip: sourceIp,
        action: 'login_failure',
        metadata: { reason: 'missing_key' },
      });

      request.session.flash = { type: 'error', message: 'Admin key is required' };
      return reply.redirect(302, '/admin/login');
    }

    // Validate admin key
    const isValid = await authenticateAdminKey(db, adminKey);

    if (!isValid) {
      rateLimiter.recordFailure(sourceIp);

      // F-SEC-M10-004: Emit login failure audit event
      await opts.audit.emit({
        event_id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        event_type: 'auth_failure',
        severity: 'warn',
        client_id: undefined,
        user_id: undefined,
        source_ip: sourceIp,
        action: 'login_failure',
        metadata: { reason: 'invalid_key' },
      });

      request.session.flash = { type: 'error', message: 'Invalid admin key' };
      return reply.redirect(302, '/admin/login');
    }

    // F-SEC-M10-003: Session fixation prevention
    // WORKAROUND: @fastify/session@10.9.0 has a bug where both destroy() and regenerate()
    // nullify the request.session object, making it impossible to set properties afterward.
    // As a workaround, we manually clear existing session data to prevent data leakage.
    // LIMITATION: This does not regenerate the session ID, which is less secure than proper
    // session regeneration. Consider upgrading @fastify/session when a fixed version is available.
    
    // Clear any existing session data (prevents data leakage from previous sessions)
    if (request.session.isAdmin) delete (request.session as any).isAdmin;
    if (request.session.flash) delete (request.session as any).flash;
    
    // Set new authenticated session data
    request.session.isAdmin = true;
    request.session.flash = { type: 'success', message: 'Login successful' };
    await request.session.save();

    // Success - reset rate limit
    rateLimiter.reset(sourceIp);

    // F-SEC-M10-004: Emit login success audit event
    await opts.audit.emit({
      event_id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      event_type: 'auth_success',
      severity: 'info',
      client_id: undefined,
      user_id: 'admin',
      source_ip: sourceIp,
      action: 'login_success',
      metadata: {},
    });

    return reply.redirect(302, '/admin/dashboard');
  });

  /**
   * POST /admin/logout - Handle logout
   */
  fastify.post('/admin/logout', async (request, reply) => {
    await request.session.destroy();
    return reply.redirect(302, '/admin/login');
  });

  /**
   * GET /admin or /admin/ - Redirect to dashboard or login
   */
  fastify.get('/admin', (request, reply) => {
    if (isAuthenticated(request)) {
      return reply.redirect(302, '/admin/dashboard');
    }
    return reply.redirect(302, '/admin/login');
  });

  fastify.get('/admin/', (request, reply) => {
    if (isAuthenticated(request)) {
      return reply.redirect(302, '/admin/dashboard');
    }
    return reply.redirect(302, '/admin/login');
  });

  // ==========================================================================
  // AUTHENTICATED ROUTES
  // All routes below require session authentication
  // ==========================================================================

  /**
   * GET /admin/dashboard - Admin dashboard
   */
  fastify.get('/admin/dashboard', { preHandler: requireAuth }, async (request, reply) => {
    const data = await getDashboardData(db, mcpManager);

    const flash = request.session.flash;
    delete request.session.flash;

    return reply.view('dashboard', {
      sessionCount: data.sessionCount,
      userCount: data.userCount,
      profileCount: data.profileCount,
      mcpStatus: data.mcpStatus,
      auditEvents: data.auditEvents,
      flash,
      title: 'Dashboard',
      formatTimestamp,
    });
  });

  /**
   * GET /admin/clients - Client management
   */
  fastify.get('/admin/clients', { preHandler: requireAuth }, async (request, reply) => {
    const query = request.query as { page?: string };
    const page = parseInt(query.page || '1', 10);

    const data = await getClients(db, page);

    const flash = request.session.flash;
    delete request.session.flash;

    return reply.view('clients', {
      ...data,
      flash,
      title: 'Clients',
      formatTimestamp,
    });
  });

  /**
   * GET /admin/profiles - Profile management
   */
  fastify.get('/admin/profiles', { preHandler: requireAuth }, async (request, reply) => {
    const profiles = await getProfiles(db);

    const flash = request.session.flash;
    delete request.session.flash;

    return reply.view('profiles', {
      profiles,
      flash,
      title: 'Profiles',
      formatTimestamp,
    });
  });

  /**
   * GET /admin/profiles/:id/edit - Edit profile
   */
  fastify.get('/admin/profiles/:id/edit', { preHandler: requireAuth }, async (request, reply) => {
    const params = request.params as { id: string };
    const profile = await getProfile(db, params.id);

    if (!profile) {
      request.session.flash = { type: 'error', message: 'Profile not found' };
      return reply.redirect(302, '/admin/profiles');
    }

    const flash = request.session.flash;
    delete request.session.flash;

    const profileData = profile as { name?: string };

    return reply.view('profile-edit', {
      profile,
      flash,
      title: `Edit Profile: ${profileData.name ?? params.id}`,
    });
  });

  /**
   * GET /admin/kill-switches - Kill switch management
   */
  fastify.get('/admin/kill-switches', { preHandler: requireAuth }, (request, reply) => {
    const killSwitches = getKillSwitches(db);

    const flash = request.session.flash;
    delete request.session.flash;

    return reply.view('kill-switches', {
      killSwitches,
      flash,
      title: 'Kill Switches',
      formatTimestamp,
    });
  });

  /**
   * GET /admin/audit - Audit log
   */
  fastify.get('/admin/audit', { preHandler: requireAuth }, async (request, reply) => {
    const query = request.query as {
      page?: string;
      client_id?: string;
      action?: string;
      user_id?: string;
      session_id?: string;
    };
    const page = parseInt(query.page || '1', 10);
    const filters = {
      client_id: query.client_id,
      action: query.action,
      user_id: query.user_id,
      session_id: query.session_id,
    };

    const data = await getAuditLog(db, page, 50, filters);

    const flash = request.session.flash;
    delete request.session.flash;

    return reply.view('audit-log', {
      ...data,
      filters,
      flash,
      title: 'Audit Log',
      formatTimestamp,
    });
  });

  /**
   * GET /admin/downstream - Downstream MCP management
   */
  fastify.get('/admin/downstream', { preHandler: requireAuth }, async (request, reply) => {
    const status = mcpManager.getStatus();

    const flash = request.session.flash;
    delete request.session.flash;

    return reply.view('downstream', {
      mcpStatus: status.connections.map(c => ({
        name: c.name,
        status: c.connected ? 'Connected' : 'Disconnected',
        toolCount: c.tool_count,
      })),
      summary: {
        totalConnections: status.total_connections,
        healthyConnections: status.healthy_connections,
        totalTools: status.total_tools,
      },
      flash,
      title: 'Downstream MCPs',
    });
  });

  /**
   * GET /admin/users - User management
   */
  fastify.get('/admin/users', { preHandler: requireAuth }, async (request, reply) => {
    const users = await getUsers(db);

    const flash = request.session.flash;
    delete request.session.flash;

    return reply.view('users', {
      users,
      flash,
      title: 'Users',
      formatTimestamp,
    });
  });

  /**
   * POST /admin/users/create - Create new user
   */
  fastify.post<{ Body: { display_name: string; email?: string } }>(
    '/admin/users/create',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { display_name, email } = request.body;

      // Validate input
      if (!display_name || display_name.trim().length === 0) {
        request.session.flash = { type: 'error', message: 'Display name is required' };
        return reply.redirect(302, '/admin/users');
      }

      try {
        // Create user
        const userId = crypto.randomUUID();
        const now = new Date().toISOString();

        await compatInsert(db, users).values({
          user_id: userId,
          display_name: display_name.trim(),
          email: email && email.trim().length > 0 ? email.trim() : null,
          status: 'active',
          auth_source: 'local',
          created_at: now,
          updated_at: now,
          metadata: '{}',
        });

        await audit.emit({
          event_id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          event_type: 'admin_action',
          severity: 'info',
          client_id: undefined,
          user_id: userId,
          source_ip: request.ip || '127.0.0.1',
          action: 'user_create',
          metadata: { display_name, email, status: 'active' },
        });

        request.session.flash = {
          type: 'success',
          message: `User "${display_name}" created successfully`,
        };
      } catch (error) {
        fastify.log.error(error, 'Failed to create user');
        request.session.flash = {
          type: 'error',
          message: 'Failed to create user. Please try again.',
        };
      }

      return reply.redirect(302, '/admin/users');
    }
  );

  /**
   * POST /admin/users/:userId/status - Update user status
   */
  fastify.post<{ Params: { userId: string }; Body: { status: string } }>(
    '/admin/users/:userId/status',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { userId } = request.params;
      const { status } = request.body;

      // Validate status
      if (!['active', 'suspended', 'deactivated'].includes(status)) {
        request.session.flash = { type: 'error', message: 'Invalid status' };
        return reply.redirect(302, '/admin/users');
      }

      try {
        // Update user status
        await compatUpdate(db, users)
          .set({ status, updated_at: new Date().toISOString() })
          .where(eq(users.user_id, userId));

        // CR fix: Cascade — if suspending/deactivating, expire sessions + terminate MCPs
        if (status === 'suspended' || status === 'deactivated') {
          await compatUpdate(db, user_sessions)
            .set({ status: 'expired' })
            .where(
              and(
                eq(user_sessions.user_id, userId),
                or(
                  eq(user_sessions.status, 'active'),
                  eq(user_sessions.status, 'idle'),
                  eq(user_sessions.status, 'spinning_down')
                )
              )
            );

          if (userPool) {
            await userPool.terminateForUser(userId);
          }
        }

        await audit.emit({
          event_id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          event_type: 'admin_action',
          severity: 'info',
          client_id: undefined,
          user_id: userId,
          source_ip: request.ip || '127.0.0.1',
          action: 'user_update',
          metadata: { new_status: status },
        });

        request.session.flash = {
          type: 'success',
          message: `User status updated to ${status}`,
        };
      } catch (error) {
        fastify.log.error(error, 'Failed to update user status');
        request.session.flash = {
          type: 'error',
          message: 'Failed to update user status. Please try again.',
        };
      }

      return reply.redirect(302, '/admin/users');
    }
  );

  /**
   * GET /admin/preshared-keys - Preshared key management
   */
  fastify.get('/admin/preshared-keys', { preHandler: requireAuth }, async (request, reply) => {
    const keys = await getPresharedKeys(db);
    const usersData = await getUsers(db);
    const profilesData = await getProfiles(db);

    // Extract generated key from session flash (one-time display)
    const generatedKey = request.session.generatedKey;
    delete request.session.generatedKey;

    const flash = request.session.flash;
    delete request.session.flash;

    return reply.view('preshared-keys', {
      keys,
      users: usersData,
      profiles: profilesData,
      generatedKey,
      flash,
      title: 'Preshared Keys',
      formatTimestamp,
    });
  });

  /**
   * POST /admin/preshared-keys/create - Create new preshared key
   */
  fastify.post<{ Body: { user_id: string; profile_id: string; label: string } }>(
    '/admin/preshared-keys/create',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { user_id, profile_id, label } = request.body;

      // Validate input
      if (!user_id || !profile_id || !label || label.trim().length === 0) {
        request.session.flash = { type: 'error', message: 'All fields are required' };
        return reply.redirect(302, '/admin/preshared-keys');
      }

      try {
        // Generate key: amb_pk_ + 48 chars of base64url (matching API route)
        const randomBytes = crypto.randomBytes(36); // 36 bytes → 48 base64 chars
        const base64url = randomBytes
          .toString('base64')
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=/g, '');
        const plainKey = `amb_pk_${base64url}`;
        const keyPrefix = base64url.substring(0, 8);

        // Hash key with Argon2id (OWASP parameters from M18)
        const argon2 = await import('argon2');
        const keyHash = await argon2.default.hash(plainKey, {
          type: argon2.default.argon2id,
          memoryCost: 19456,
          timeCost: 2,
          parallelism: 1,
        });

        // Insert key
        const keyId = crypto.randomUUID();
        const now = new Date().toISOString();

        await compatInsert(db, preshared_keys).values({
          key_id: keyId,
          key_prefix: keyPrefix,
          key_hash: keyHash,
          label: label.trim(),
          user_id,
          profile_id,
          status: 'active',
          created_by: 'admin',
          created_at: now,
          metadata: '{}',
        });

        await audit.emit({
          event_id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          event_type: 'admin_action',
          severity: 'info',
          client_id: undefined,
          user_id: user_id,
          source_ip: request.ip || '127.0.0.1',
          action: 'preshared_key_create',
          metadata: { key_id: keyId, label: label.trim(), key_prefix: keyPrefix },
        });

        // Store generated key in session for one-time display
        request.session.generatedKey = plainKey;
        request.session.flash = {
          type: 'success',
          message: 'Preshared key created successfully',
        };
      } catch (error) {
        fastify.log.error(error, 'Failed to create preshared key');
        request.session.flash = {
          type: 'error',
          message: 'Failed to create preshared key. Please try again.',
        };
      }

      return reply.redirect(302, '/admin/preshared-keys');
    }
  );

  /**
   * POST /admin/preshared-keys/:keyId/status - Update preshared key status
   */
  fastify.post<{ Params: { keyId: string }; Body: { status: string } }>(
    '/admin/preshared-keys/:keyId/status',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { keyId } = request.params;
      const { status } = request.body;

      // Validate status
      if (!['active', 'suspended', 'revoked'].includes(status)) {
        request.session.flash = { type: 'error', message: 'Invalid status' };
        return reply.redirect(302, '/admin/preshared-keys');
      }

      try {
        // Update key status
        await compatUpdate(db, preshared_keys).set({ status }).where(eq(preshared_keys.key_id, keyId));

        // CR fix: If revoking, cascade — expire user's sessions + terminate MCPs
        if (status === 'revoked') {
          // Look up key to get user_id
          const key = await db.query.preshared_keys.findFirst({
            where: (k, { eq: eq2 }) => eq2(k.key_id, keyId),
          });

          if (key) {
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

            if (userPool) {
              await userPool.terminateForUser(key.user_id);
            }
          }
        }

        await audit.emit({
          event_id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          event_type: 'admin_action',
          severity: 'info',
          client_id: undefined,
          user_id: undefined,
          source_ip: request.ip || '127.0.0.1',
          action: 'preshared_key_update',
          metadata: { key_id: keyId, new_status: status },
        });

        request.session.flash = {
          type: 'success',
          message: `Key status updated to ${status}`,
        };
      } catch (error) {
        fastify.log.error(error, 'Failed to update key status');
        request.session.flash = {
          type: 'error',
          message: 'Failed to update key status. Please try again.',
        };
      }

      return reply.redirect(302, '/admin/preshared-keys');
    }
  );

  /**
   * GET /admin/sessions - Active sessions management
   */
  fastify.get('/admin/sessions', { preHandler: requireAuth }, async (request, reply) => {
    const sessions = await getSessions(db);

    const flash = request.session.flash;
    delete request.session.flash;

    return reply.view('sessions', {
      sessions,
      flash,
      title: 'Active Sessions',
      formatTimestamp,
    });
  });

  /**
   * POST /admin/sessions/:sessionId/terminate - Force-terminate session
   */
  fastify.post<{ Params: { sessionId: string } }>(
    '/admin/sessions/:sessionId/terminate',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { sessionId } = request.params;

      try {
        // Look up session to get user_id for MCP termination
        const session = await db.query.user_sessions.findFirst({
          where: (s, { eq: eq2 }) => eq2(s.session_id, sessionId),
        });

        // Expire the session
        await compatUpdate(db, user_sessions)
          .set({ status: 'expired' })
          .where(eq(user_sessions.session_id, sessionId));

        // CR fix: Disconnect all connections
        const nowIso = new Date().toISOString();
        await compatUpdate(db, session_connections)
          .set({ status: 'disconnected', disconnected_at: nowIso })
          .where(eq(session_connections.session_id, sessionId));

        // CR fix: Terminate MCP instances for this user
        if (session && userPool) {
          await userPool.terminateForUser(session.user_id);
        }

        await audit.emit({
          event_id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          event_type: 'admin_action',
          severity: 'info',
          client_id: undefined,
          user_id: session?.user_id,
          source_ip: request.ip || '127.0.0.1',
          action: 'session_terminate',
          metadata: { session_id: sessionId },
        });

        request.session.flash = {
          type: 'success',
          message: 'Session terminated successfully',
        };
      } catch (error) {
        fastify.log.error(error, 'Failed to terminate session');
        request.session.flash = {
          type: 'error',
          message: 'Failed to terminate session. Please try again.',
        };
      }

      return reply.redirect(302, '/admin/sessions');
    }
  );

  // Keep function signature async for caller compatibility
  await Promise.resolve();
}
