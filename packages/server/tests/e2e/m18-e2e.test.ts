/**
 * M18 E2E Tests — Admin Users, Preshared Keys, Sessions
 *
 * Tests against the RUNNING Docker container (docker compose up).
 * Admin API: https://localhost:9443
 * Main API:  https://localhost:8443
 *
 * Prerequisites:
 *   - Container running via `docker compose up -d`
 *   - Dev config with seeded admin key
 *
 * Run:
 *   RUN_E2E=1 pnpm --filter @mcpambassador/server exec vitest run tests/e2e/m18-e2e.test.ts
 */

import https from 'https';
import { describe, it, expect, beforeAll } from 'vitest';

const ADMIN_BASE = 'https://localhost:9443';
const MAIN_BASE = 'https://localhost:8443';
let adminSessionCookie = '';

interface HttpResponse<T = unknown> {
  statusCode: number;
  body: T;
  headers?: Record<string, string | string[]>;
}

function httpRequest<T = unknown>(
  baseUrl: string,
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {}
): Promise<HttpResponse<T>> {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    };

    const reqOptions: https.RequestOptions = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers,
      rejectUnauthorized: false,
    };

    const req = https.request(reqOptions, res => {
      let data = '';
      res.on('data', d => (data += d.toString()));
      res.on('end', () => {
        let parsed: T;
        try {
          parsed = data ? (JSON.parse(data) as T) : ({} as T);
        } catch {
          parsed = data as unknown as T;
        }
        resolve({ statusCode: res.statusCode || 0, body: parsed, headers: res.headers });
      });
    });

    req.on('error', err => reject(err));
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function adminRequest<T = any>(
  method: string,
  path: string,
  body?: unknown
): Promise<HttpResponse<T>> {
  const headers: Record<string, string> = {};
  if (adminSessionCookie) headers.Cookie = adminSessionCookie;
  return httpRequest<T>(ADMIN_BASE, method, path, { body, headers });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mainRequest<T = any>(
  method: string,
  path: string,
  body?: unknown
): Promise<HttpResponse<T>> {
  return httpRequest<T>(MAIN_BASE, method, path, { body });
}

async function waitForCondition(
  fn: () => Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 200
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error('Timeout waiting for condition');
}

describe('M18 E2E - Admin Users / Preshared Keys / Sessions', () => {
  // Verify container is reachable before running tests (health endpoint is on main port)
  beforeAll(async () => {
    const health = await httpRequest(MAIN_BASE, 'GET', '/health');
    if (health.statusCode !== 200) {
      throw new Error(`Container not reachable on ${MAIN_BASE}/health. Run: docker compose up -d`);
    }
    // Login to admin API and capture session cookie for admin requests
    const login = await httpRequest(ADMIN_BASE, 'POST', '/v1/auth/login', {
      body: { username: 'admin', password: 'admin123' },
    });
    if (![200, 201].includes(login.statusCode)) {
      throw new Error(`Admin login failed with status ${login.statusCode}`);
    }
    const setCookie = login.headers?.['set-cookie'] ?? login.headers?.['Set-Cookie'];
    if (!setCookie) {
      throw new Error('Admin login did not return Set-Cookie header');
    }
    const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    // Keep only the cookie pair (name=value)
    adminSessionCookie = raw.split(';')[0];
  }, 10000);

  it('T1: User CRUD Flow', async () => {
    // Create user
    const create = await adminRequest('POST', '/v1/admin/users', {
      username: `e2e_m18_user_${Date.now()}`,
      password: 'P@ssw0rd1!',
      display_name: 'e2e-m18-user',
      email: 'e2e-m18@example.test',
    });
    expect(create.statusCode).toBe(201);
    const userId = create.body?.data?.user_id;
    expect(userId).toBeTruthy();

    // List users — created user should appear
    const list = await adminRequest('GET', '/v1/admin/users?status=active&limit=100');
    expect(list.statusCode).toBe(200);
    const users = list.body?.data ?? list.body?.users ?? [];
    expect(users.find((u: Record<string, unknown>) => u.user_id === userId)).toBeTruthy();

    // Update display_name
    const upd = await adminRequest('PATCH', `/v1/admin/users/${userId}`, {
      display_name: 'e2e-m18-updated',
    });
    expect(upd.statusCode).toBe(200);

    // Suspend user (triggers cascade)
    const susp = await adminRequest('PATCH', `/v1/admin/users/${userId}`, {
      status: 'suspended',
    });
    expect(susp.statusCode).toBe(200);
  }, 20000);

  it('T2: Preshared Key Lifecycle', async () => {
    // Create user prerequisite
    const createUser = await adminRequest('POST', '/v1/admin/users', {
      username: `e2e_m18_keyuser_${Date.now()}`,
      password: 'P@ssw0rd1!',
      display_name: 'e2e-m18-keyuser',
    });
    expect(createUser.statusCode).toBe(201);
    const userId = createUser.body?.data?.user_id;
    expect(userId).toBeTruthy();

    // Get a profile_id
    const profiles = await adminRequest('GET', '/v1/admin/profiles');
    expect(profiles.statusCode).toBe(200);
    const profs =
      profiles.body?.data ??
      profiles.body?.profiles ??
      (Array.isArray(profiles.body) ? profiles.body : []);
    expect(profs.length).toBeGreaterThan(0);
    const profileId = profs[0].profile_id ?? profs[0].id;
    expect(profileId).toBeTruthy();

    // Create client (preshared key) — plaintext returned once
    const pkCreate = await adminRequest('POST', '/v1/admin/clients', {
      user_id: userId,
      profile_id: profileId,
      client_name: 'e2e-m18-key',
    });
    expect(pkCreate.statusCode).toBe(201);
    const plaintext: string = pkCreate.body?.data?.plaintext_key ?? '';
    expect(plaintext.startsWith('amb_pk_')).toBe(true);

    const keyId: string = pkCreate.body?.data?.client_id ?? pkCreate.body?.data?.key_id ?? '';
    expect(keyId).toBeTruthy();

    // List keys — key appears, NO hash leaked
    const listKeys = await adminRequest('GET', '/v1/admin/clients');
    expect(listKeys.statusCode).toBe(200);
    const keys = listKeys.body?.data ?? listKeys.body?.clients ?? [];
    const found = keys.find(
      (k: Record<string, unknown>) => k.client_id === keyId || k.key_id === keyId
    );
    expect(found).toBeTruthy();
    expect(found.key_hash).toBeUndefined();
    expect(found.preshared_key).toBeUndefined();

    // Revoke key (triggers cascade)
    const revoke = await adminRequest('PATCH', `/v1/admin/clients/${keyId}`, {
      status: 'revoked',
    });
    expect(revoke.statusCode).toBe(200);
  }, 30000);

  it('T3: Session List + Terminate', async () => {
    const ses = await adminRequest('GET', '/v1/admin/sessions');
    expect(ses.statusCode).toBe(200);
    // Response shape: { data: [...], pagination: {...} } or array
    const sessions =
      ses.body?.data ?? ses.body?.sessions ?? (Array.isArray(ses.body) ? ses.body : []);

    if (sessions.length > 0) {
      const sid = sessions[0].session_id ?? sessions[0].id;
      const del = await adminRequest('DELETE', `/v1/admin/sessions/${sid}`);
      expect([200, 204].includes(del.statusCode)).toBe(true);
    }
  }, 20000);

  it('T4: Integration — Create User → Key → Register Session → Suspend → Session Expired', async () => {
    // 1. Create user
    const create = await adminRequest('POST', '/v1/admin/users', {
      username: `e2e_m18_integ_${Date.now()}`,
      password: 'P@ssw0rd1!',
      display_name: 'e2e-m18-integration',
    });
    expect(create.statusCode).toBe(201);
    const userId = create.body?.data?.user_id;
    expect(userId).toBeTruthy();

    // 2. Get profile_id
    const profiles = await adminRequest('GET', '/v1/admin/profiles');
    const profs =
      profiles.body?.data ??
      profiles.body?.profiles ??
      (Array.isArray(profiles.body) ? profiles.body : []);
    const profileId = profs[0]?.profile_id ?? profs[0]?.id;

    // 3. Create preshared key (client)
    const pk = await adminRequest('POST', '/v1/admin/clients', {
      user_id: userId,
      profile_id: profileId,
      client_name: 'e2e-m18-integ-key',
    });
    expect(pk.statusCode).toBe(201);
    const plaintext: string = pk.body?.data?.plaintext_key ?? '';
    expect(plaintext.startsWith('amb_pk_')).toBe(true);

    // 4. Register session on MAIN server (port 8443)
    const reg = await mainRequest('POST', '/v1/sessions/register', {
      preshared_key: plaintext,
      friendly_name: 'e2e-m18-test',
      host_tool: 'cli',
    });
    // Accept 200 or 201
    expect([200, 201].includes(reg.statusCode)).toBe(true);
    const sessionToken: string = reg.body?.session_token ?? '';
    const sessionId: string = reg.body?.session_id ?? '';

    // At least one identifier should be returned
    expect(sessionToken || sessionId).toBeTruthy();

    // 5. Verify session appears in admin list
    await waitForCondition(
      async () => {
        const s = await adminRequest('GET', '/v1/admin/sessions');
        if (s.statusCode !== 200) return false;
        const arr = s.body?.data ?? s.body?.sessions ?? [];
        return arr.some(
          (x: Record<string, unknown>) => x.session_id === sessionId || x.user_id === userId
        );
      },
      5000,
      250
    );

    // 6. Suspend user — should cascade: expire sessions + terminate MCPs
    const susp = await adminRequest('PATCH', `/v1/admin/users/${userId}`, {
      status: 'suspended',
    });
    expect(susp.statusCode).toBe(200);

    // 7. Verify session is now expired
    await waitForCondition(
      async () => {
        const s = await adminRequest('GET', '/v1/admin/sessions');
        if (s.statusCode !== 200) return false;
        const arr = s.body?.data ?? s.body?.sessions ?? [];
        const entry = arr.find((x: Record<string, unknown>) => x.user_id === userId);
        if (!entry) return true; // Session may have been removed entirely
        return entry.status === 'expired';
      },
      8000,
      300
    );
  }, 45000);
});
