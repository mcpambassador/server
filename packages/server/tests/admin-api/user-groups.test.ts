import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { startTestServer, stopTestServer, type TestServerHandle } from './helpers';
import { createUser } from '../../src/auth/user-auth.js';

let handle: TestServerHandle;

beforeAll(async () => {
  handle = await startTestServer();
});

afterAll(async () => {
  await stopTestServer(handle);
});

describe('Admin: GET /v1/admin/users/:userId/groups', () => {
  it('returns 401 without admin key', async () => {
    const res = await handle.fastify.inject({ method: 'GET', url: '/v1/admin/users/does-not-matter/groups' });
    expect(res.statusCode).toBe(401);
  });

  it('returns user groups with valid admin key', async () => {
    // Create a test user
    const user = await createUser(handle.db, {
      username: 'test-user',
      password: 'pass1234',
      display_name: 'Tester',
    });

    // Create a group via admin API
    const createGroupRes = await handle.fastify.inject({
      method: 'POST',
      url: '/v1/admin/groups',
      headers: { 'X-Admin-Key': handle.adminKey },
      payload: { name: 'g-test', description: 'desc', status: 'active' },
    });

    expect(createGroupRes.statusCode).toBe(201);
    const grp = JSON.parse(createGroupRes.body).data;

    // Add user to group
    const addRes = await handle.fastify.inject({
      method: 'POST',
      url: `/v1/admin/groups/${grp.group_id}/members`,
      headers: { 'X-Admin-Key': handle.adminKey },
      payload: { user_id: user.user_id },
    });
    expect(addRes.statusCode).toBe(201);

    // Fetch user's groups
    const res = await handle.fastify.inject({
      method: 'GET',
      url: `/v1/admin/users/${user.user_id}/groups`,
      headers: { 'X-Admin-Key': handle.adminKey },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    const g = body.data[0];
    expect(g.group_id).toBeDefined();
    expect(g.name).toBeDefined();
    expect(g.assigned_at).toBeDefined();
  });

  it('returns 404 for non-existent user', async () => {
    const res = await handle.fastify.inject({
      method: 'GET',
      url: '/v1/admin/users/00000000-0000-0000-0000-000000000000/groups',
      headers: { 'X-Admin-Key': handle.adminKey },
    });

    expect(res.statusCode).toBe(404);
  });
});
