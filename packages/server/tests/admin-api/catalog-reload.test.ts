import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, stopTestServer } from './helpers.js';

describe('Admin API - Catalog Reload (integration)', () => {
  let handle: Awaited<ReturnType<typeof startTestServer>> | null = null;

  beforeAll(async () => {
    handle = await startTestServer();
  });

  afterAll(async () => {
    if (handle) await stopTestServer(handle);
  });

  it('GET /v1/admin/catalog/status returns PendingChanges shape', async () => {
    const res = await handle!.fastify.inject({ method: 'GET', url: '/v1/admin/catalog/status', headers: { 'X-Admin-Key': handle!.adminKey } });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.ok).toBe(true);
    const data = body.data;
    expect(data).toHaveProperty('shared');
    expect(data).toHaveProperty('per_user');
    expect(typeof data.has_changes).toBe('boolean');
  });

  it('GET /v1/admin/catalog/status — empty has_changes false', async () => {
    const res = await handle!.fastify.inject({ method: 'GET', url: '/v1/admin/catalog/status', headers: { 'X-Admin-Key': handle!.adminKey } });
    const body = JSON.parse(res.payload);
    expect(body.ok).toBe(true);
    expect(body.data.has_changes).toBe(false);
  });

  it('POST /v1/admin/catalog/apply returns ReloadResult shape', async () => {
    const res = await handle!.fastify.inject({ method: 'POST', url: '/v1/admin/catalog/apply', headers: { 'X-Admin-Key': handle!.adminKey } });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.ok).toBe(true);
    const data = body.data;
    expect(data).toHaveProperty('timestamp');
    expect(data).toHaveProperty('shared');
    expect(data).toHaveProperty('per_user');
    expect(data).toHaveProperty('summary');
  });

  it('POST /v1/admin/catalog/apply — no changes summary.total_changes 0', async () => {
    const res = await handle!.fastify.inject({ method: 'POST', url: '/v1/admin/catalog/apply', headers: { 'X-Admin-Key': handle!.adminKey } });
    const body = JSON.parse(res.payload);
    expect(body.ok).toBe(true);
    expect(body.data.summary.total_changes).toBe(0);
  });

  it('Admin auth required for endpoints', async () => {
    const r1 = await handle!.fastify.inject({ method: 'GET', url: '/v1/admin/catalog/status' });
    expect(r1.statusCode).toBe(401);
    const r2 = await handle!.fastify.inject({ method: 'POST', url: '/v1/admin/catalog/apply' });
    expect(r2.statusCode).toBe(401);
  });

  it('Create per-user MCP -> status shows pending (per_user)', async () => {
    // Create MCP (per_user isolation) via admin API
    const createBody = {
      name: 'test-per-user-mcp',
      display_name: 'Test Per User',
      transport_type: 'stdio',
      isolation_mode: 'per_user',
      config: { command: ['true'] },
    };

    const createRes = await handle!.fastify.inject({ method: 'POST', url: '/v1/admin/mcps', headers: { 'X-Admin-Key': handle!.adminKey }, payload: createBody });
    expect(createRes.statusCode).toBe(201);
    const created = JSON.parse(createRes.payload).data;

    // Validate then publish it (publish requires validation_status='valid')
    const validateRes = await handle!.fastify.inject({ method: 'POST', url: `/v1/admin/mcps/${created.mcp_id}/validate`, headers: { 'X-Admin-Key': handle!.adminKey } });
    expect(validateRes.statusCode).toBe(200);

    const publishRes = await handle!.fastify.inject({ method: 'POST', url: `/v1/admin/mcps/${created.mcp_id}/publish`, headers: { 'X-Admin-Key': handle!.adminKey } });
    expect(publishRes.statusCode).toBe(200);

    // Now status should report pending per_user addition
    const statusRes = await handle!.fastify.inject({ method: 'GET', url: '/v1/admin/catalog/status', headers: { 'X-Admin-Key': handle!.adminKey } });
    expect(statusRes.statusCode).toBe(200);
    const status = JSON.parse(statusRes.payload).data;
    const foundPerUser = status.per_user.to_add.some((x: any) => x.name === created.name);
    expect(foundPerUser).toBeTruthy();
  });

  it('Apply changes -> has_changes becomes false', async () => {
    const applyRes = await handle!.fastify.inject({ method: 'POST', url: '/v1/admin/catalog/apply', headers: { 'X-Admin-Key': handle!.adminKey } });
    expect(applyRes.statusCode).toBe(200);

    const statusRes = await handle!.fastify.inject({ method: 'GET', url: '/v1/admin/catalog/status', headers: { 'X-Admin-Key': handle!.adminKey } });
    const status = JSON.parse(statusRes.payload).data;
    expect(status.has_changes).toBe(false);
  });
});
