/**
 * E2E Test Setup - Docker Lifecycle Management
 *
 * Manages automated Docker container lifecycle for end-to-end testing:
 * - Builds container from Dockerfile
 * - Starts container with test configuration
 * - Waits for health endpoint
 * - Tears down container after tests
 * - Cleans up volumes
 *
 * Usage:
 *   import { startTestContainer, stopTestContainer } from './setup';
 *
 *   beforeAll(async () => {
 *     await startTestContainer();
 *   });
 *
 *   afterAll(async () => {
 *     await stopTestContainer();
 *   });
 */

import { spawn, ChildProcess } from 'child_process';
import https from 'https';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Test container configuration
export const TEST_CONTAINER_NAME = 'mcpambassador-e2e-test';
export const TEST_HOST = 'localhost';
export const TEST_PORT = 18443; // Different from production port 8443
export const TEST_BASE_URL = `https://${TEST_HOST}:${TEST_PORT}`;

let containerProcess: ChildProcess | null = null;

/**
 * Execute shell command and return stdout
 */
function execCommand(command: string, args: string[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: 'pipe' });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', data => {
      stdout += data.toString();
    });

    proc.stderr?.on('data', data => {
      stderr += data.toString();
    });

    proc.on('close', code => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`${command} failed (code ${code}): ${stderr}`));
      }
    });

    proc.on('error', err => {
      reject(err);
    });
  });
}

/**
 * Check if container is healthy by polling health endpoint
 */
async function waitForHealthy(maxWaitMs = 30000): Promise<void> {
  const startTime = Date.now();
  const pollIntervalMs = 500;

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const response = await new Promise<number>((resolve, reject) => {
        const req = https.get(`${TEST_BASE_URL}/health`, { rejectUnauthorized: false }, res =>
          resolve(res.statusCode || 0)
        );

        req.on('error', reject);
        req.setTimeout(2000, () => {
          req.destroy();
          reject(new Error('Health check timeout'));
        });
      });

      if (response === 200) {
        console.log('[E2E Setup] Container is healthy');
        return;
      }
    } catch (error) {
      // Expected during startup
    }

    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(`Container failed to become healthy within ${maxWaitMs}ms`);
}

/**
 * Build Docker image for testing
 */
async function buildTestImage(): Promise<void> {
  console.log('[E2E Setup] Building Docker image...');

  const serverRoot = path.resolve(__dirname, '../../..');

  try {
    await execCommand('docker', [
      'build',
      '-t',
      'mcpambassador-server:test',
      '-f',
      path.join(serverRoot, 'Dockerfile'),
      serverRoot,
    ]);

    console.log('[E2E Setup] Docker image built successfully');
  } catch (error) {
    console.error('[E2E Setup] Docker build failed:', error);
    throw error;
  }
}

/**
 * Start test container
 */
export async function startTestContainer(): Promise<void> {
  console.log('[E2E Setup] Starting test container...');

  // Build image
  await buildTestImage();

  // Clean up any existing test container
  try {
    await execCommand('docker', ['rm', '-f', TEST_CONTAINER_NAME]);
  } catch {
    // Container doesn't exist - expected
  }

  // Start container
  const args = [
    'run',
    '--rm',
    '--name',
    TEST_CONTAINER_NAME,
    '-p',
    `${TEST_PORT}:8443`,
    '-e',
    'MCP_AMBASSADOR_LOG_LEVEL=debug',
    '-e',
    'NODE_ENV=test',
    'mcpambassador-server:test',
  ];

  containerProcess = spawn('docker', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Log container output for debugging
  containerProcess.stdout?.on('data', data => {
    console.log('[Container]', data.toString().trim());
  });

  containerProcess.stderr?.on('data', data => {
    console.error('[Container Error]', data.toString().trim());
  });

  containerProcess.on('close', code => {
    if (code !== 0 && code !== null) {
      console.error(`[E2E Setup] Container exited with code ${code}`);
    }
  });

  // Wait for container to be healthy
  await waitForHealthy();

  console.log('[E2E Setup] Test container ready');
}

/**
 * Stop test container
 */
export async function stopTestContainer(): Promise<void> {
  console.log('[E2E Setup] Stopping test container...');

  if (containerProcess) {
    containerProcess.kill('SIGTERM');

    // Wait for graceful shutdown
    await new Promise(resolve => {
      containerProcess!.on('close', resolve);
      setTimeout(resolve, 5000); // Force after 5s
    });

    containerProcess = null;
  }

  // Force remove container if still running
  try {
    await execCommand('docker', ['rm', '-f', TEST_CONTAINER_NAME]);
  } catch {
    // Already removed
  }

  console.log('[E2E Setup] Test container stopped');
}

/**
 * Get container logs for debugging
 */
export async function getContainerLogs(): Promise<string> {
  try {
    return await execCommand('docker', ['logs', TEST_CONTAINER_NAME]);
  } catch (error) {
    return `Failed to get logs: ${error}`;
  }
}
