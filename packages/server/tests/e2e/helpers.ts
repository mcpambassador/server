/**
 * E2E Test Helpers
 * 
 * Utility functions for end-to-end testing:
 * - Authenticated HTTPS requests
 * - Client registration
 * - Admin operations (key rotation, kill switch)
 * - Audit log inspection
 */

import https from 'https';
import { TEST_BASE_URL } from './setup';

export interface ClientCredentials {
  client_id: string;
  api_key: string;
}

/**
 * Make authenticated HTTPS request to test server
 */
export async function makeRequest<T>(
  method: string,
  path: string,
  options: {
    body?: any;
    apiKey?: string;
    expectStatus?: number;
  } = {}
): Promise<T> {
  return new Promise((resolve, reject) => {
    const url = new URL(TEST_BASE_URL + path);
    
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    
    if (options.apiKey) {
      headers['X-API-Key'] = options.apiKey;
    }
    
    const reqOptions: https.RequestOptions = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers,
      rejectUnauthorized: false, // Self-signed cert in test
    };
    
    const req = https.request(reqOptions, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk.toString();
      });
      
      res.on('end', () => {
        // Check expected status code
        if (options.expectStatus && res.statusCode !== options.expectStatus) {
          reject(new Error(`Expected status ${options.expectStatus}, got ${res.statusCode}: ${data}`));
          return;
        }
        
        // Parse JSON response
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data || '{}'));
          } catch (error) {
            reject(new Error(`Invalid JSON response: ${data}`));
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    });
    
    req.on('error', (error) => {
      reject(error);
    });
    
    if (options.body) {
      req.write(JSON.stringify(options.body));
    }
    
    req.end();
  });
}

/**
 * Register a new client and return credentials
 */
export async function registerClient(
  clientId: string,
  scope: string[] = ['read', 'write']
): Promise<ClientCredentials> {
  const response = await makeRequest<{ api_key: string }>(
    'POST',
    '/v1/admin/clients',
    {
      body: {
        client_id: clientId,
        scope,
      },
      // Admin endpoint requires bootstrap (no auth on first call)
      expectStatus: 201,
    }
  );
  
  return {
    client_id: clientId,
    api_key: response.api_key,
  };
}

/**
 * Fetch available tools catalog
 */
export interface ToolInfo {
  name: string;
  description?: string;
  inputSchema?: any;
}

export async function fetchTools(apiKey: string): Promise<ToolInfo[]> {
  const response = await makeRequest<{ tools: ToolInfo[] }>(
    'GET',
    '/v1/tools',
    { apiKey }
  );
  
  return response.tools;
}

/**
 * Invoke a tool
 */
export async function invokeTool(
  apiKey: string,
  toolName: string,
  parameters: Record<string, any>
): Promise<any> {
  const response = await makeRequest<{ result: any }>(
    'POST',
    '/v1/tools/invoke',
    {
      apiKey,
      body: {
        tool: toolName,
        parameters,
      },
    }
  );
  
  return response.result;
}

/**
 * Enable kill switch (admin operation)
 */
export async function enableKillSwitch(adminApiKey: string): Promise<void> {
  await makeRequest(
    'POST',
    '/v1/admin/kill-switch',
    {
      apiKey: adminApiKey,
      body: { enabled: true },
    }
  );
}

/**
 * Disable kill switch (admin operation)
 */
export async function disableKillSwitch(adminApiKey: string): Promise<void> {
  await makeRequest(
    'POST',
    '/v1/admin/kill-switch',
    {
      apiKey: adminApiKey,
      body: { enabled: false },
    }
  );
}

/**
 * Rotate client API key (admin operation)
 */
export async function rotateApiKey(
  adminApiKey: string,
  clientId: string
): Promise<string> {
  const response = await makeRequest<{ api_key: string }>(
    'POST',
    `/v1/admin/clients/${clientId}/rotate`,
    { apiKey: adminApiKey }
  );
  
  return response.api_key;
}

/**
 * Get audit log events (requires admin access or direct file read)
 * 
 * Note: In real deployment, this would query an admin endpoint.
 * For E2E tests, we can exec into container to read audit.jsonl
 */
export async function getAuditLogs(): Promise<any[]> {
  // This is a simplified version - in practice you'd exec into container
  // or provide an admin endpoint to query audit logs
  // For now, return empty array as placeholder
  return [];
}

/**
 * Wait for a condition to be true (polling helper)
 */
export async function waitFor(
  condition: () => Promise<boolean>,
  options: {
    timeoutMs?: number;
    intervalMs?: number;
    timeoutError?: string;
  } = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs || 5000;
  const intervalMs = options.intervalMs || 100;
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeoutMs) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  
  throw new Error(options.timeoutError || 'Timeout waiting for condition');
}

/**
 * Sleep for specified milliseconds
 */
export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
