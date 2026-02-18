/**
 * Admin UI htmx Routes - HTML Fragment Endpoints
 *
 * Fragment endpoints that return HTML snippets for htmx interactions.
 * All routes require authenticated session + HX-Request header.
 *
 * @see ADR-007 Admin UI Technology Selection (EJS + htmx)
 * SEC-M10-12: htmx endpoints require HX-Request header
 */

// Fastify preHandler hooks accept async functions but ESLint's no-misused-promises
// reports false positives for Fastify's route option typing.
/* eslint-disable @typescript-eslint/no-misused-promises */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { DatabaseClient } from '@mcpambassador/core';
import type { KillSwitchManager } from './kill-switch-manager.js';
import { escapeHtml } from './html-escape.js';

export interface HtmxRoutesOptions {
  db: DatabaseClient;
  killSwitchManager: KillSwitchManager;
}

/**
 * Check if request has authenticated admin session
 */
function isAuthenticated(request: FastifyRequest): boolean {
  return (request.session as { isAdmin?: boolean } | undefined)?.isAdmin === true;
}

/**
 * Middleware: Require HX-Request header (SEC-M10-12)
 */
async function requireHxRequest(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const hxRequest = request.headers['hx-request'];

  if (!hxRequest || hxRequest !== 'true') {
    await reply.status(400).send({
      error: 'Bad Request',
      message: 'HX-Request header required',
    });
    return;
  }

  if (!isAuthenticated(request)) {
    await reply.status(401).send({
      error: 'Unauthorized',
      message: 'Authentication required',
    });
    return;
  }
}

/**
 * Register htmx fragment routes
 */
export async function registerHtmxRoutes(
  fastify: FastifyInstance,
  opts: HtmxRoutesOptions
): Promise<void> {
  const { killSwitchManager } = opts;

  /**
   * POST /admin/api/kill-switch/:type/:target - Toggle kill switch
   *
   * Returns HTML button with updated state
   */
  fastify.post<{ Params: { type: string; target: string } }>(
    '/admin/api/kill-switch/:type/:target',
    { preHandler: requireHxRequest },
    (request, reply) => {
      const { type, target } = request.params;

      const isActive = killSwitchManager.isActive(type, target);

      // CR-M10-001: Use shared kill-switch manager instead of local Map
      killSwitchManager.toggle(type, target);

      const newState = !isActive;

      const buttonHtml = `
        <button 
          class="kill-switch-btn ${newState ? 'active' : ''}"
          hx-post="/admin/api/kill-switch/${escapeHtml(type)}/${escapeHtml(target)}"
          hx-swap="outerHTML"
          hx-target="this">
          ${newState ? '🛑 Enabled' : '✓ Disabled'}
        </button>
      `;

      return reply.type('text/html').send(buttonHtml);
    }
  );

  /**
   * PATCH /admin/api/clients/:id/status - Update client status
   *
   * Returns HTML table row with updated client data
   */
  fastify.patch(
    '/admin/api/clients/:id/status',
    { preHandler: requireHxRequest },
    (request, reply) => {
      const { id } = request.params as { id: string };
      const { status } = request.body as { status?: string };

      if (!status || !['active', 'suspended'].includes(status)) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Invalid status',
        });
      }

      const rowHtml = `
        <tr id="client-${escapeHtml(id)}">
          <td>${escapeHtml(id)}</td>
          <td>${escapeHtml(status)}</td>
          <td>
            <select hx-patch="/admin/api/clients/${escapeHtml(id)}/status" hx-target="#client-${escapeHtml(id)}">
              <option value="active" ${status === 'active' ? 'selected' : ''}>Active</option>
              <option value="suspended" ${status === 'suspended' ? 'selected' : ''}>Suspended</option>
            </select>
          </td>
        </tr>
      `;

      return reply.type('text/html').send(rowHtml);
    }
  );

  /**
   * POST /admin/api/profiles - Create profile
   *
   * Returns HTML list item for new profile
   */
  fastify.post<{ Body: { name?: string } }>(
    '/admin/api/profiles',
    { preHandler: requireHxRequest },
    (request, reply) => {
      const { name } = request.body;

      if (!name) {
        return reply.status(400).send({ error: 'Bad Request', message: 'Name required' });
      }

      const id = `prof_${Date.now()}`;
      const html = `
      <li id="profile-${escapeHtml(id)}">
        <a href="/admin/profiles/${escapeHtml(id)}/edit">${escapeHtml(name)}</a>
      </li>
    `;

      return reply.type('text/html').send(html);
    }
  );

  /**
   * PATCH /admin/api/profiles/:id - Update profile
   *
   * Returns updated profile card/row HTML
   */
  fastify.patch(
    '/admin/api/profiles/:id',
    { preHandler: requireHxRequest },
    (request, reply) => {
      const { id } = request.params as { id: string };
      const { name } = request.body as { name?: string };

      if (!name) {
        return reply.status(400).send({ error: 'Bad Request', message: 'Name required' });
      }

      const html = `
        <div id="profile-${escapeHtml(id)}" class="profile-card">
          <h3>${escapeHtml(name)}</h3>
          <p>Updated successfully</p>
        </div>
      `;

      return reply.type('text/html').send(html);
    }
  );

  /**
   * DELETE /admin/api/profiles/:id - Delete profile
   *
   * Returns empty response (element will be removed by htmx)
   */
  fastify.delete(
    '/admin/api/profiles/:id',
    { preHandler: requireHxRequest },
    (_request, reply) => {
      return reply.type('text/html').send('');
    }
  );

  // Keep function signature async for caller compatibility
  await Promise.resolve();
}
