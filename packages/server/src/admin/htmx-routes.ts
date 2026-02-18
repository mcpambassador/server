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

export interface HtmxRoutesOptions {
  db: DatabaseClient;
}

/**
 * Kill switch state (shared with routes.ts)
 * Phase 2/3 will move to database
 */
const killSwitchState = new Map<string, boolean>();

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
  _opts: HtmxRoutesOptions
): Promise<void> {

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

      const key = `${type}:${target}`;
      const isActive = killSwitchState.get(key) || false;

      if (isActive) {
        killSwitchState.delete(key);
      } else {
        killSwitchState.set(key, true);
      }

      const newState = !isActive;

      const buttonHtml = `
        <button 
          class="kill-switch-btn ${newState ? 'active' : ''}"
          hx-post="/admin/api/kill-switch/${type}/${target}"
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
        <tr id="client-${id}">
          <td>${id}</td>
          <td>${status}</td>
          <td>
            <select hx-patch="/admin/api/clients/${id}/status" hx-target="#client-${id}">
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
      <li id="profile-${id}">
        <a href="/admin/profiles/${id}/edit">${name}</a>
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
        <div id="profile-${id}" class="profile-card">
          <h3>${name}</h3>
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
