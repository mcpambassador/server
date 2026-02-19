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
import { authenticateAdminKey } from '@mcpambassador/core';
import { LoginRateLimiter } from './session.js';
import crypto from 'node:crypto';
import {
  getDashboardData,
  getClients,
  getProfiles,
  getProfile,
  getKillSwitches,
  getAuditLog,
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
  }
}

export interface UiRoutesOptions {
  db: DatabaseClient;
  mcpManager: SharedMcpManager;
  dataDir: string;
  audit: AuditProvider; // F-SEC-M10-004
  killSwitchManager: KillSwitchManager; // CR-M10-001
  sessionStore: BoundedSessionStore; // F-SEC-M10-005
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
  const { db, mcpManager } = opts;
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
      ...data,
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
    const query = request.query as { page?: string; client_id?: string; action?: string };
    const page = parseInt(query.page || '1', 10);
    const filters = {
      client_id: query.client_id,
      action: query.action,
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
  // Keep function signature async for caller compatibility
  await Promise.resolve();
}
