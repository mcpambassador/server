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
import type { DatabaseClient } from '@mcpambassador/core';
import type { DownstreamMcpManager } from '../downstream/index.js';
import { authenticateAdminKey } from '@mcpambassador/core';
import { LoginRateLimiter } from './session.js';
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
  mcpManager: DownstreamMcpManager;
  dataDir: string;
}

/**
 * Check if request has authenticated admin session
 */
function isAuthenticated(request: FastifyRequest): boolean {
  return request.session?.isAdmin === true;
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
    const flash = request.session.flash;
    delete request.session.flash;

    return reply.view('login', {
      flash,
      title: 'Admin Login',
    });
  });

  /**
   * POST /admin/login - Handle login form submission
   */
  fastify.post<{ Body: { admin_key?: string } }>('/admin/login', async (request, reply) => {
    const sourceIp = request.ip || '0.0.0.0';

    // Check rate limit
    if (rateLimiter.isRateLimited(sourceIp)) {
      const retryAfter = rateLimiter.getRetryAfter(sourceIp);
      return reply
        .header('Retry-After', retryAfter.toString())
        .status(429)
        .send({
          error: 'Too Many Requests',
          message: `Too many failed login attempts. Try again in ${retryAfter} seconds.`,
        });
    }

    const { admin_key: adminKey } = request.body;

    if (!adminKey || typeof adminKey !== 'string') {
      rateLimiter.recordFailure(sourceIp);
      request.session.flash = { type: 'error', message: 'Admin key is required' };
      return reply.redirect(302, '/admin/login');
    }

    // Validate admin key
    const isValid = await authenticateAdminKey(db, adminKey);

    if (!isValid) {
      rateLimiter.recordFailure(sourceIp);
      request.session.flash = { type: 'error', message: 'Invalid admin key' };
      return reply.redirect(302, '/admin/login');
    }

    // Success - set session and reset rate limit
    rateLimiter.reset(sourceIp);
    request.session.isAdmin = true;
    await request.session.save();

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
    const mcpStatus = mcpManager.getStatus();

    const flash = request.session.flash;
    delete request.session.flash;

    return reply.view('downstream', {
      mcpStatus,
      flash,
      title: 'Downstream MCPs',
    });
  });
  // Keep function signature async for caller compatibility
  await Promise.resolve();
}
