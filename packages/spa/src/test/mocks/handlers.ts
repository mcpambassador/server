import { http, HttpResponse } from 'msw';

// Base URL for API calls
const API_BASE = '';

// Sample handlers - these will be expanded in M32
export const handlers = [
  // Health check
  http.get(`${API_BASE}/health`, () => {
    return HttpResponse.json({ ok: true, data: { status: 'ok' } });
  }),

  // Auth - current user
  http.get(`${API_BASE}/v1/auth/me`, () => {
    return HttpResponse.json({
      ok: true,
      data: {
        user_id: 'test-user-id',
        username: 'admin',
        display_name: 'Admin User',
        is_admin: true,
      },
    });
  }),
  // Auth - session (used by authApi.getSession)
  http.get(`${API_BASE}/v1/auth/session`, () => {
    return HttpResponse.json({
      ok: true,
      data: {
        user_id: 'test-user-id',
        username: 'admin',
        display_name: 'Admin User',
        is_admin: true,
      },
    });
  }),
  
  // User profile
  http.get(`${API_BASE}/v1/users/me`, () => {
    return HttpResponse.json({ ok: true, data: { id: 'u1', username: 'alice' } });
  }),

  // Credentials
  http.get(`${API_BASE}/v1/users/me/credentials`, () => {
    return HttpResponse.json({ ok: true, data: [{ mcp_id: 'm1', status: 'active' }] });
  }),
  http.put(new RegExp(`${API_BASE}/v1/users/me/credentials/.*`), () => {
    return HttpResponse.json({ ok: true, data: { message: 'updated' } });
  }),
  http.delete(new RegExp(`${API_BASE}/v1/users/me/credentials/.*`), () => {
    return HttpResponse.json({ ok: true, data: { message: 'deleted' } });
  }),

  // Clients
  http.get(`${API_BASE}/v1/users/me/clients`, () => {
    return HttpResponse.json({ ok: true, data: [{ id: 'c1', clientName: 'Client 1' }] });
  }),
  http.get(new RegExp(`${API_BASE}/v1/users/me/clients/[^/]+$`), (req: unknown) => {
    const r = req as { url: URL };
    const id = r.url.pathname.split('/').pop();
    return HttpResponse.json({ ok: true, data: { id, clientName: `Client ${id}` } });
  }),
  http.post(`${API_BASE}/v1/users/me/clients`, () => {
    return HttpResponse.json({ ok: true, data: { client: { id: 'new', clientName: 'new' }, plaintext_key: 'sk' } });
  }),
  http.patch(new RegExp(`${API_BASE}/v1/users/me/clients/[^/]+$`), (req: unknown) => {
    const r = req as { url: URL };
    const id = r.url.pathname.split('/').pop();
    return HttpResponse.json({ ok: true, data: { id, clientName: 'updated' } });
  }),
  http.delete(new RegExp(`${API_BASE}/v1/users/me/clients/[^/]+$`), () => {
    return HttpResponse.json({ ok: true, data: { message: 'deleted' } });
  }),

  // Subscriptions
  http.get(new RegExp(`${API_BASE}/v1/users/me/clients/.*/subscriptions$`), () => {
    return HttpResponse.json({ ok: true, data: [{ id: 's1' }] });
  }),
  http.post(new RegExp(`${API_BASE}/v1/users/me/clients/.*/subscriptions$`), () => {
    return HttpResponse.json({ ok: true, data: { id: 's-new' } });
  }),
  http.patch(new RegExp(`${API_BASE}/v1/users/me/clients/.*/subscriptions/.*$`), () => {
    return HttpResponse.json({ ok: true, data: { updated: true } });
  }),
  http.delete(new RegExp(`${API_BASE}/v1/users/me/clients/.*/subscriptions/.*$`), () => {
    return HttpResponse.json({ ok: true, data: { message: 'unsubscribed' } });
  }),

  // Marketplace
  http.get(`${API_BASE}/v1/marketplace`, () => {
    return HttpResponse.json({ ok: true, data: [], pagination: { has_more: false, next_cursor: null, total_count: 0 } });
  }),
  http.get(new RegExp(`${API_BASE}/v1/marketplace/.*`), (req: unknown) => {
    const r = req as { url: URL };
    const id = r.url.pathname.split('/').pop();
    return HttpResponse.json({ ok: true, data: { id, name: `MCP ${id}` } });
  }),

  // Admin downstream (system status)
  http.get(`${API_BASE}/v1/admin/downstream`, () => {
    return HttpResponse.json({
      ok: true,
      data: {
        healthy_connections: 1,
        total_connections: 1,
        total_tools: 3,
        connections: [
          { name: 'm1', status: 'healthy', tools: 3 },
        ],
      },
    });
  }),

  // Admin - generic endpoints used by hooks
  http.get(new RegExp(`${API_BASE}/v1/admin/.*`), () => {
    // Return a paginated envelope so admin hooks/components that expect
    // { data, pagination } receive the correct shape.
    return HttpResponse.json({ ok: true, data: [], pagination: { cursor: null } });
  }),
  http.post(new RegExp(`${API_BASE}/v1/admin/.*`), () => {
    return HttpResponse.json({ ok: true, data: { created: true } });
  }),
  http.patch(new RegExp(`${API_BASE}/v1/admin/.*`), () => {
    return HttpResponse.json({ ok: true, data: { updated: true } });
  }),
  http.delete(new RegExp(`${API_BASE}/v1/admin/.*`), () => {
    return HttpResponse.json({ ok: true, data: { message: 'deleted' } });
  }),
];
