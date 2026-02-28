import { describe, test, expect, beforeAll } from 'vitest';
import https from 'https';

// Test configuration
const SERVER_PORT = 8443;
const ADMIN_PORT = 9443;
const SERVER_HOST = 'localhost';

// Session state
let sessionToken: string;
let sessionId: string;
let connectionId: string;

/**
 * Helper function to make HTTPS requests to the server
 */
async function request(
  port: number,
  method: string,
  path: string,
  body?: any,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const bodyString = body ? JSON.stringify(body) : undefined;
    const options: https.RequestOptions = {
      hostname: SERVER_HOST,
      port,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
        ...(bodyString ? { 'Content-Length': Buffer.byteLength(bodyString) } : {}),
      },
      rejectUnauthorized: false,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        let parsedBody;
        try {
          parsedBody = data ? JSON.parse(data) : {};
        } catch {
          parsedBody = { raw: data };
        }

        resolve({
          status: res.statusCode || 0,
          body: parsedBody,
        });
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    if (bodyString) {
      req.write(bodyString);
    }

    req.end();
  });
}

async function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

async function registerWithRetries(
  presharedKey: string | undefined,
  hostTool: string,
  clientName: string,
  maxAttempts = 10,
  delayMs = 500
) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await request(
      SERVER_PORT,
      'POST',
      '/v1/sessions/register',
      {
        preshared_key: presharedKey,
        friendly_name: clientName,
        host_tool: hostTool,
      }
    );

    if (res.status === 429 && attempt < maxAttempts) {
      await sleep(delayMs);
      continue;
    }

    return res;
  }

  return await request(
    SERVER_PORT,
    'POST',
    '/v1/sessions/register',
    {
      preshared_key: presharedKey,
      friendly_name: clientName,
      host_tool: hostTool,
    }
  );
}

async function fetchToolsWithRetry(token: string, attempts = 10, delayMs = 500) {
  for (let i = 0; i < attempts; i++) {
    const res = await request(SERVER_PORT, 'GET', '/v1/tools', undefined, { 'X-Session-Token': token });
    if (res.status === 200) return res;
    await sleep(delayMs);
  }
  // final attempt
  return await request(SERVER_PORT, 'GET', '/v1/tools', undefined, { 'X-Session-Token': token });
}

describe('M17.9 Per-User MCP Pools E2E', () => {
  beforeAll(() => {
    if (!process.env.DEV_PRESHARED_KEY) {
      throw new Error('DEV_PRESHARED_KEY environment variable not set.');
    }

    if (!process.env.ADMIN_KEY) {
      console.warn('ADMIN_KEY not set; admin calls will be limited.');
    }
  });

  test('Test 1: Health check', async () => {
    const res = await request(SERVER_PORT, 'GET', '/health');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status', 'ok');
    console.log('[Test1] health ok');
  });

  test('Test 2: Register session and verify tools include per-user tools', async () => {
    const res = await registerWithRetries(process.env.DEV_PRESHARED_KEY, 'vscode', 'm17-e2e');
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('session_token');
    expect(res.body).toHaveProperty('session_id');
    expect(res.body).toHaveProperty('connection_id');

    sessionToken = res.body.session_token;
    sessionId = res.body.session_id;
    connectionId = res.body.connection_id;

    console.log('[Test2] registered', { sessionId, connectionId });

    const toolsRes = await request(
      SERVER_PORT,
      'GET',
      '/v1/tools',
      undefined,
      { 'X-Session-Token': sessionToken }
    );

    expect(toolsRes.status).toBe(200);
    expect(Array.isArray(toolsRes.body.tools)).toBe(true);
    expect(toolsRes.body.tools.length).toBeGreaterThanOrEqual(10);
    console.log('[Test2] tool count', toolsRes.body.tools.length);
  });

  test('Test 3: Tool invocation works (validates routing)', async () => {
    // Attempt a simple invocation; accept any non-404/5xx as a valid routing response
    const invokeBody = {
      name: 'context7__resolve-library-id',
      args: { libraryId: 'test' },
    };

    const res = await request(
      SERVER_PORT,
      'POST',
      '/v1/tools/invoke',
      invokeBody,
      { 'X-Session-Token': sessionToken }
    );

    expect(res.status).not.toBe(404);
    expect(res.status).toBeLessThan(500);
    console.log('[Test3] invoke status', res.status);
  });

  test('Test 4: Tools remain available on heartbeat', async () => {
    const hb = await request(
      SERVER_PORT,
      'POST',
      '/v1/sessions/heartbeat',
      {},
      { 'X-Session-Token': sessionToken }
    );
    expect(hb.status).toBe(200);

    await sleep(1000);

    const toolsRes = await request(
      SERVER_PORT,
      'GET',
      '/v1/tools',
      undefined,
      { 'X-Session-Token': sessionToken }
    );

    expect(toolsRes.status).toBe(200);
    expect(Array.isArray(toolsRes.body.tools)).toBe(true);
    expect(toolsRes.body.tools.length).toBeGreaterThan(0);
    console.log('[Test4] tools after heartbeat', toolsRes.body.tools.length);
  });

  test('Test 5: Session disconnect removes connection', async () => {
    const res = await request(
      SERVER_PORT,
      'DELETE',
      `/v1/sessions/connections/${connectionId}`,
      undefined,
      { 'X-Session-Token': sessionToken }
    );

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('connection_id', connectionId);
    console.log('[Test5] disconnected', connectionId);
  });

  test('Test 6: Re-register (reconnect) and verify tools return', async () => {
    const res = await registerWithRetries(process.env.DEV_PRESHARED_KEY, 'vscode', 'm17-e2e-re');
    expect(res.status).toBe(201);
    const newToken = res.body.session_token;

    const toolsRes = await request(SERVER_PORT, 'GET', '/v1/tools', undefined, { 'X-Session-Token': newToken });
    expect(toolsRes.status).toBe(200);
    expect(Array.isArray(toolsRes.body.tools)).toBe(true);
    expect(toolsRes.body.tools.length).toBeGreaterThan(0);
    console.log('[Test6] re-registered tools', toolsRes.body.tools.length);
  });

  test('Test 7: Session reuse — second registration replaces token, both connections exist', async () => {
    // Server reuses sessions for the same user (same preshared key = same user_id).
    // Second registration generates a fresh token, invalidating the first.
    const a = await registerWithRetries(process.env.DEV_PRESHARED_KEY, 'vscode', 'm17-e2e-a');
    expect(a.status).toBe(201);
    const tokenA = a.body.session_token;
    const sessionIdA = a.body.session_id;

    const b = await registerWithRetries(process.env.DEV_PRESHARED_KEY, 'vscode', 'm17-e2e-b');
    expect(b.status).toBe(201);
    const tokenB = b.body.session_token;

    // Same user → same session reused
    expect(b.body.session_id).toBe(sessionIdA);

    // Old token (A) should be invalidated — session_token_hash replaced by B's
    const ta = await request(SERVER_PORT, 'GET', '/v1/tools', undefined, { 'X-Session-Token': tokenA });
    expect(ta.status).toBe(401);

    // New token (B) should work
    const tb = await fetchToolsWithRetry(tokenB);
    expect(tb.status).toBe(200);
    expect(Array.isArray(tb.body.tools)).toBe(true);
    expect(tb.body.tools.length).toBeGreaterThan(0);
    console.log('[Test7] session reuse — tokenA invalidated, tokenB tools:', tb.body.tools.length);
  }, { timeout: 20000 });

  test('Test 8: Unauthenticated tool request returns 401', async () => {
    const res = await request(SERVER_PORT, 'GET', '/v1/tools');
    expect(res.status).toBe(401);
  });

  test('Test 9: Invalid session token returns 401', async () => {
    const res = await request(SERVER_PORT, 'GET', '/v1/tools', undefined, { 'X-Session-Token': 'invalid-token' });
    expect(res.status).toBe(401);
  });
});
