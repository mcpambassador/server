/**
 * Admin-revoked clients are terminal (TD-013 follow-up): no mutation via the admin or user
 * routes, no un-revoke, the revoked key cannot register, and suspend/reactivate cannot race an
 * admin revoke.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { clients, compatUpdate, createToolProfile } from '@mcpambassador/core';
import { startTestServer, stopTestServer, type TestServerHandle } from '../admin-api/helpers.js';
import { createUser } from '../../src/auth/user-auth.js';
import { suspendUserClient, reactivateUserClient } from '../../src/services/client-service.js';

describe('Admin-revoked clients are immutable', () => {
  let server: TestServerHandle;
  let userId: string;
  let profileId: string;
  let cookie: string;

  const adminHeaders = () => ({ 'x-admin-key': server.adminKey });

  async function createClient(name: string): Promise<{ id: string; key: string }> {
    const res = await server.admin.inject({
      method: 'POST',
      url: '/v1/users/me/clients',
      headers: { cookie },
      payload: { client_name: name, profile_id: profileId },
    });
    expect(res.statusCode).toBe(201);
    const data = JSON.parse(res.body).data;
    return { id: data.client.id, key: data.plaintext_key };
  }

  async function adminRevoke(id: string): Promise<void> {
    const res = await server.admin.inject({
      method: 'PATCH',
      url: `/v1/admin/clients/${id}`,
      headers: adminHeaders(),
      payload: { status: 'revoked' },
    });
    expect(res.statusCode).toBe(200);
  }

  const statusOf = async (id: string): Promise<string> =>
    (await server.db.query.clients.findFirst({ where: (c, { eq }) => eq(c.client_id, id) }))!
      .status;

  beforeAll(async () => {
    server = await startTestServer();
    const user = await createUser(server.db, {
      username: 'revokeduser',
      password: 'pass1234',
      display_name: 'Revoked User',
      email: 'revoked@example.com',
    });
    userId = user.user_id;
    profileId = (
      await createToolProfile(server.db, {
        name: 'revoked-profile',
        description: 'p',
        allowed_tools: '[]',
        denied_tools: '[]',
      })
    ).profile_id;
    const login = await server.admin.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { username: 'revokeduser', password: 'pass1234' },
    });
    const c = login.headers['set-cookie'];
    cookie = (Array.isArray(c) ? c[0]! : String(c)).split(';')[0]!;
  });

  afterAll(async () => {
    await stopTestServer(server);
  });

  it('admin PATCH of a revoked client is 409 for every mutation (incl. un-revoke)', async () => {
    const { id } = await createClient('admin-revoked-1');
    await adminRevoke(id);

    for (const payload of [
      { status: 'active' },
      { status: 'suspended' },
      { status: 'revoked' },
      { profile_id: profileId },
    ]) {
      const res = await server.admin.inject({
        method: 'PATCH',
        url: `/v1/admin/clients/${id}`,
        headers: adminHeaders(),
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(409);
    }
    expect(await statusOf(id)).toBe('revoked');
  });

  it('the revoked preshared key cannot register, even after an un-revoke attempt', async () => {
    const { id, key } = await createClient('admin-revoked-2');
    await adminRevoke(id);

    const un = await server.admin.inject({
      method: 'PATCH',
      url: `/v1/admin/clients/${id}`,
      headers: adminHeaders(),
      payload: { status: 'active' },
    });
    expect(un.statusCode).toBe(409);

    const reg = await server.fastify.inject({
      method: 'POST',
      url: '/v1/sessions/register',
      payload: { preshared_key: key, friendly_name: 'x', host_tool: 'cli' },
    });
    expect(reg.statusCode).toBeGreaterThanOrEqual(400);
    expect(reg.statusCode).toBeLessThan(500);
  });

  it('user PATCH of an admin-revoked client is 409 (rename, suspend, reactivate)', async () => {
    const { id } = await createClient('admin-revoked-3');
    await adminRevoke(id);

    for (const payload of [
      { client_name: 'renamed' },
      { status: 'suspended' },
      { status: 'active' },
    ]) {
      const res = await server.admin.inject({
        method: 'PATCH',
        url: `/v1/users/me/clients/${id}`,
        headers: { cookie },
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(409);
    }
    const row = await server.db.query.clients.findFirst({
      where: (c, { eq }) => eq(c.client_id, id),
    });
    expect(row!.status).toBe('revoked');
    expect(row!.client_name).toBe('admin-revoked-3');
  });

  it('user PATCH validates the transition before applying any field (no partial rename)', async () => {
    const { id } = await createClient('partial-rename');
    const res = await server.admin.inject({
      method: 'PATCH',
      url: `/v1/users/me/clients/${id}`,
      headers: { cookie },
      payload: { client_name: 'should-not-stick', status: 'active' }, // active -> active is invalid
    });
    expect(res.statusCode).toBe(409);
    const row = await server.db.query.clients.findFirst({
      where: (c, { eq }) => eq(c.client_id, id),
    });
    expect(row!.client_name).toBe('partial-rename');
  });

  it('zod errors expose only {path, message}', async () => {
    const { id } = await createClient('zod-shape');
    const res = await server.admin.inject({
      method: 'PATCH',
      url: `/v1/users/me/clients/${id}`,
      headers: { cookie },
      payload: { status: 'bogus-secret-value' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('bogus-secret-value');
    for (const issue of JSON.parse(res.body).error.details ?? []) {
      expect(Object.keys(issue).sort()).toEqual(['message', 'path']);
    }
  });

  describe('suspend/reactivate race with an admin revoke', () => {
    /** db whose first UPDATE ... RETURNING is preceded by an admin revoke (read-then-update race) */
    function racingDb(clientId: string) {
      let fired = false;
      return new Proxy(server.db as any, {
        get(target, prop, receiver) {
          if (prop !== 'update') return Reflect.get(target, prop, receiver);
          return (table: unknown) => {
            const builder = target.update(table);
            return {
              set: (v: unknown) => {
                const sb = builder.set(v);
                return {
                  where: (w: unknown) => {
                    const q = sb.where(w);
                    return {
                      returning: async (...a: unknown[]) => {
                        if (!fired) {
                          fired = true;
                          await compatUpdate(target, clients)
                            .set({ status: 'revoked' })
                            .where(eq(clients.client_id, clientId));
                        }
                        return q.returning(...a);
                      },
                    };
                  },
                };
              },
            };
          };
        },
      });
    }

    it('suspend loses to a concurrent revoke: invalid transition, status stays revoked', async () => {
      const { id } = await createClient('race-suspend');
      await expect(suspendUserClient(racingDb(id), userId, id)).rejects.toThrow(
        /Invalid state transition/
      );
      expect(await statusOf(id)).toBe('revoked');
    });

    it('reactivate loses to a concurrent revoke: invalid transition, status stays revoked', async () => {
      const { id } = await createClient('race-reactivate');
      await suspendUserClient(server.db, userId, id);
      await expect(reactivateUserClient(racingDb(id), userId, id)).rejects.toThrow(
        /Invalid state transition/
      );
      expect(await statusOf(id)).toBe('revoked');
    });
  });
});
