/* eslint-disable no-console, @typescript-eslint/no-floating-promises, @typescript-eslint/require-await */

import { ServiceUnavailableError } from '@mcpambassador/core';
import type {
  DownstreamMcpConfig,
  AggregatedTool,
  ToolInvocationRequest,
  ToolInvocationResponse,
} from './types.js';
import { validateMcpConfig, validateToolName, BLOCKED_ENV_VARS } from './types.js';
import { StdioMcpConnection } from './stdio-connection.js';
import { HttpMcpConnection } from './http-connection.js';

/**
 * User MCP Pool Configuration
 *
 * M17.2: Configuration for per-user MCP instance management
 */
export interface UserMcpPoolConfig {
  /** MCP definitions to spawn per user (from YAML config for 1.0) */
  mcpConfigs: DownstreamMcpConfig[];
  /** Max MCP instances per user (default: 10) */
  maxInstancesPerUser: number;
  /** Max total MCP instances system-wide (default: 100) */
  maxTotalInstances: number;
  /** Health check interval in ms (default: 60000) */
  healthCheckIntervalMs: number;
}

/**
 * Per-user MCP instance set
 * Tracks all MCP connections and tools for a single user
 */
interface UserInstanceSet {
  userId: string;
  connections: Map<string, StdioMcpConnection | HttpMcpConnection>; // mcp_name → connection
  toolToMcpMap: Map<string, string>; // tool_name → mcp_name
  aggregatedTools: AggregatedTool[];
  spawnedAt: Date;
  status: 'spawning' | 'ready' | 'terminating' | 'terminated';
}

/**
 * User MCP Pool Status
 * Health/status information for admin dashboard
 */
export interface UserMcpPoolStatus {
  totalUserInstances: number;
  userCount: number;
  instancesByUser: Map<string, number>;
  totalConnections: number;
}

/**
 * User MCP Pool
 *
 * M17.2: Manages per-user MCP instances with session-bound lifecycle
 *
 * Responsibilities:
 * - Spawn MCP instances for individual users on demand
 * - Terminate user MCP instances when sessions are suspended
 * - Aggregate tool catalogs per user
 * - Route tool invocations to correct per-user MCP
 * - Enforce resource limits (per-user and system-wide)
 * - Monitor health of per-user connections
 *
 * Per ADR-012 and Architecture §18 (Multi-Tenant Orchestrator)
 */
export class UserMcpPool {
  private config: UserMcpPoolConfig;
  private userInstances = new Map<string, UserInstanceSet>();
  private spawningUsers = new Set<string>(); // Lock to prevent concurrent spawn races
  private systemSpawnLock: Promise<void> = Promise.resolve(); // SEC-M17-003: System-wide spawn mutex
  private healthCheckInterval: NodeJS.Timeout | null = null;
  // ADR-013 B1 fix: Store catalog-derived fingerprints for accurate change detection
  private storedMcpFingerprints = new Map<string, string>();

  constructor(config: UserMcpPoolConfig) {
    this.config = config;
    console.log('[UserMcpPool] Initialized');

    // Start health check interval
    if (config.healthCheckIntervalMs > 0) {
      this.healthCheckInterval = setInterval(() => {
        this.performHealthCheck();
      }, config.healthCheckIntervalMs);
    }
  }

  /**
   * Spawn MCP instances for a user
   * Called when session transitions to 'active' (first connect or reconnect from suspended)
   *
   * M17.6: Enforces resource limits
   * M26.4: Accepts optional credentials (env vars and headers) for injection
   *
   * @param userId User UUID
   * @param credentials Optional map of MCP name → credentials to inject
   * @throws ServiceUnavailableError if per-user or system-wide limit exceeded
   */
  async spawnForUser(
    userId: string,
    credentials?: Map<string, import('./types.js').UserMcpCredentials>
  ): Promise<void> {
    // Idempotent: if already spawned, return immediately
    const existingInstances = this.userInstances.get(userId);
    if (existingInstances && existingInstances.status === 'ready') {
      console.log(`[UserMcpPool] User ${userId} already has active instances`);
      return;
    }

    // Check for concurrent spawn
    if (this.spawningUsers.has(userId)) {
      console.log(`[UserMcpPool] User ${userId} already spawning, waiting...`);
      // Wait for current spawn to complete (simple polling with timeout)
      const maxWaitMs = 30000;
      const startTime = Date.now();
      while (this.spawningUsers.has(userId) && Date.now() - startTime < maxWaitMs) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // Check again if instances are ready
      const instances = this.userInstances.get(userId);
      if (instances && instances.status === 'ready') {
        return;
      }
    }

    // Acquire spawn lock
    this.spawningUsers.add(userId);

    // SEC-M17-003: Acquire system-wide spawn lock to prevent TOCTOU race in resource limits
    // Serialize the critical section: enforceResourceLimits + spawn
    let releaseLock: () => void = () => {}; // Default no-op ensures always callable
    const previousLock = this.systemSpawnLock;
    this.systemSpawnLock = new Promise<void>(resolve => {
      releaseLock = resolve;
    });
    await previousLock;

    try {
      // M17.6: Check resource limits (now under system-wide lock)
      await this.enforceResourceLimits(userId);

      console.log(`[UserMcpPool] Spawning MCP instances for user ${userId}...`);

      // Initialize user instance set
      const instanceSet: UserInstanceSet = {
        userId,
        connections: new Map(),
        toolToMcpMap: new Map(),
        aggregatedTools: [],
        spawnedAt: new Date(),
        status: 'spawning',
      };

      this.userInstances.set(userId, instanceSet);

      // Spawn connections for each MCP config (parallel, matching SharedMcpManager pattern)
      const startPromises = this.config.mcpConfigs.map(async config => {
        try {
          // F-SEC-M6-001: Validate config before spawning
          validateMcpConfig(config);

          // M26.4: Merge credentials (env vars and headers) if provided
          let finalConfig = config;
          if (credentials && credentials.has(config.name)) {
            const creds = credentials.get(config.name)!;

            // SEC-H3: Validate credential env var names against BLOCKED_ENV_VARS
            for (const key of Object.keys(creds.envVars)) {
              if (BLOCKED_ENV_VARS.includes(key.toUpperCase())) {
                throw new Error(
                  `Credential env var '${key}' matches blocked env var for ${config.name}`
                );
              }
            }

            // Skip 'Authorization' header validation (it's expected for OAuth)
            for (const key of Object.keys(creds.headers)) {
              if (key !== 'Authorization' && BLOCKED_ENV_VARS.includes(key.toUpperCase())) {
                throw new Error(
                  `Credential header '${key}' matches blocked env var for ${config.name}`
                );
              }
            }

            finalConfig = {
              ...config,
              env: {
                ...config.env,
                ...creds.envVars,
              },
              headers: {
                ...config.headers,
                ...creds.headers,
              },
            };

            const envCount = Object.keys(creds.envVars).length;
            const headerCount = Object.keys(creds.headers).length;
            console.log(
              `[UserMcpPool] Injected credentials for ${config.name}: ${envCount} env vars, ${headerCount} headers`
            );
          }

          let connection: StdioMcpConnection | HttpMcpConnection | null = null;

          if (finalConfig.transport === 'stdio') {
            connection = new StdioMcpConnection(finalConfig);
            await connection.start();
            instanceSet.connections.set(finalConfig.name, connection);
          } else if (finalConfig.transport === 'http' || finalConfig.transport === 'sse') {
            connection = new HttpMcpConnection(finalConfig);
            await connection.start();
            instanceSet.connections.set(finalConfig.name, connection);
          } else {
            console.warn(
              // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
              `[UserMcpPool] Unknown transport ${finalConfig.transport} for ${finalConfig.name}`
            );
          }

          // CR-M17-006: Register event handlers once (extracted to helper)
          if (connection) {
            this.registerConnectionHandlers(connection, userId, finalConfig.name);
          }
        } catch (err) {
          // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
          console.error(`[UserMcpPool] User ${userId} failed to start ${config.name}:`, err);
          // Continue with other MCPs even if one fails
        }
      });

      await Promise.allSettled(startPromises);

      // Aggregate tools from all connected MCPs
      await this.aggregateToolsForUser(userId);

      instanceSet.status = 'ready';

      console.log(
        `[UserMcpPool] User ${userId} spawned ${instanceSet.connections.size} connections, ${instanceSet.aggregatedTools.length} tools`
      );
    } catch (err) {
      // SEC-M17-002: Cleanup on failure - stop any connections that were successfully started
      const instanceSet = this.userInstances.get(userId);
      if (instanceSet) {
        console.log(
          `[UserMcpPool] Cleaning up ${instanceSet.connections.size} partially spawned connections for user ${userId}`
        );
        for (const [mcpName, connection] of instanceSet.connections.entries()) {
          try {
            await connection.stop();
            console.log(`[UserMcpPool] Stopped connection ${mcpName} for user ${userId}`);
          } catch (stopErr) {
            // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
            console.error(
              `[UserMcpPool] Failed to stop connection ${mcpName} for user ${userId}:`,
              stopErr
            );
            // Continue cleanup even if individual stops fail
          }
        }
        this.userInstances.delete(userId);
      }
      throw err;
    } finally {
      // Release spawn locks
      this.spawningUsers.delete(userId);
      releaseLock(); // SEC-M17-003: Release system-wide lock
    }
  }

  /**
   * M17.6: Enforce resource limits before spawning
   * @throws ServiceUnavailableError if limits exceeded
   */
  private async enforceResourceLimits(userId: string): Promise<void> {
    // Check per-user limit
    const existingUserInstances = this.userInstances.get(userId);
    if (existingUserInstances) {
      const userInstanceCount = existingUserInstances.connections.size;
      if (userInstanceCount >= this.config.maxInstancesPerUser) {
        throw new ServiceUnavailableError(
          `User ${userId} has reached maximum MCP instance limit (${this.config.maxInstancesPerUser})`,
          {
            error_code: 'resource_limit_exceeded',
            user_id: userId,
            limit_type: 'per_user',
            current_count: userInstanceCount,
            max_allowed: this.config.maxInstancesPerUser,
          }
        );
      }
    }

    // Check system-wide limit
    let totalInstances = 0;
    for (const instanceSet of this.userInstances.values()) {
      totalInstances += instanceSet.connections.size;
    }

    // Calculate how many new instances we're about to spawn
    const newInstances = this.config.mcpConfigs.length;

    if (totalInstances + newInstances > this.config.maxTotalInstances) {
      throw new ServiceUnavailableError(
        `System-wide MCP instance limit reached (${this.config.maxTotalInstances})`,
        {
          error_code: 'resource_limit_exceeded',
          limit_type: 'system_wide',
          current_count: totalInstances,
          requested_additional: newInstances,
          max_allowed: this.config.maxTotalInstances,
        }
      );
    }
  }

  /**
   * Aggregate tool catalogs for a specific user
   * Same pattern as SharedMcpManager.aggregateTools()
   */
  private async aggregateToolsForUser(userId: string): Promise<void> {
    const instanceSet = this.userInstances.get(userId);
    if (!instanceSet) {
      return;
    }

    instanceSet.aggregatedTools = [];
    instanceSet.toolToMcpMap.clear();

    for (const [mcpName, connection] of instanceSet.connections) {
      if (!connection.isConnected()) {
        continue;
      }

      const tools = connection.getTools();

      for (const tool of tools) {
        // SEC-M9-05: Validate tool name
        if (!validateToolName(tool.name)) {
          console.warn(
            `[UserMcpPool] User ${userId} skipping tool with invalid name from ${mcpName}: ${tool.name}`
          );
          continue;
        }

        // Check for tool name conflicts
        if (instanceSet.toolToMcpMap.has(tool.name)) {
          const existingMcp = instanceSet.toolToMcpMap.get(tool.name);
          console.warn(
            `[UserMcpPool] User ${userId} tool name conflict: ${tool.name} ` +
              `provided by both ${existingMcp} and ${mcpName}. ` +
              `Using ${existingMcp}.`
          );
          continue;
        }

        // SEC-M9-05: Truncate description to 500 chars
        let description = tool.description;
        if (description && description.length > 500) {
          description = description.substring(0, 500);
        }

        // Add to aggregated catalog
        instanceSet.aggregatedTools.push({
          ...tool,
          description,
          source_mcp: mcpName,
        });

        instanceSet.toolToMcpMap.set(tool.name, mcpName);
      }
    }

    console.log(
      `[UserMcpPool] User ${userId} aggregated ${instanceSet.aggregatedTools.length} tools from ${instanceSet.connections.size} MCPs`
    );
  }

  /**
   * Terminate all MCP instances for a user
   * Called when session transitions to 'spinning_down'
   * Idempotent — safe to call if already terminated
   */
  async terminateForUser(userId: string): Promise<void> {
    const instanceSet = this.userInstances.get(userId);

    if (!instanceSet) {
      console.log(`[UserMcpPool] User ${userId} has no instances to terminate`);
      return;
    }

    if (instanceSet.status === 'terminating' || instanceSet.status === 'terminated') {
      console.log(`[UserMcpPool] User ${userId} instances already terminating/terminated`);
      return;
    }

    console.log(`[UserMcpPool] Terminating MCP instances for user ${userId}...`);
    instanceSet.status = 'terminating';

    // Stop all connections (parallel)
    const stopPromises = Array.from(instanceSet.connections.values()).map(conn =>
      conn.stop().catch(err => {
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        console.error(`[UserMcpPool] User ${userId} error stopping connection:`, err);
      })
    );

    await Promise.allSettled(stopPromises);

    // Clear instance set
    instanceSet.connections.clear();
    instanceSet.toolToMcpMap.clear();
    instanceSet.aggregatedTools = [];
    instanceSet.status = 'terminated';

    // Remove from map
    this.userInstances.delete(userId);

    console.log(`[UserMcpPool] User ${userId} instances terminated`);
  }

  /**
   * Get tool catalog for a specific user's MCP instances
   * Returns empty array if user has no active instances
   */
  getToolCatalog(userId: string): AggregatedTool[] {
    const instanceSet = this.userInstances.get(userId);

    if (!instanceSet || instanceSet.status !== 'ready') {
      return [];
    }

    return instanceSet.aggregatedTools;
  }

  /**
   * Get tool descriptor by name for a specific user
   */
  getToolDescriptor(userId: string, toolName: string): AggregatedTool | undefined {
    const instanceSet = this.userInstances.get(userId);

    if (!instanceSet || instanceSet.status !== 'ready') {
      return undefined;
    }

    return instanceSet.aggregatedTools.find(tool => tool.name === toolName);
  }

  /**
   * Route a tool invocation to the correct per-user MCP instance
   *
   * @throws Error if tool not found in user's pool or MCP not connected
   */
  async invokeTool(
    userId: string,
    request: ToolInvocationRequest
  ): Promise<ToolInvocationResponse> {
    const instanceSet = this.userInstances.get(userId);

    if (!instanceSet || instanceSet.status !== 'ready') {
      throw new Error(`User ${userId} has no active MCP instances`);
    }

    const mcpName = instanceSet.toolToMcpMap.get(request.tool_name);

    if (!mcpName) {
      throw new Error(`Tool not found in user pool: ${request.tool_name}`);
    }

    const connection = instanceSet.connections.get(mcpName);

    if (!connection) {
      throw new Error(`MCP connection not found: ${mcpName}`);
    }

    if (!connection.isConnected()) {
      throw new Error(`MCP not connected: ${mcpName}`);
    }

    // Route invocation to the correct MCP
    return await connection.invokeTool(request);
  }

  /**
   * Check if a user has active (spawned) MCP instances
   */
  hasActiveInstances(userId: string): boolean {
    const instanceSet = this.userInstances.get(userId);
    return instanceSet !== undefined && instanceSet.status === 'ready';
  }

  /**
   * Get status of all per-user instances (for admin dashboard)
   */
  getStatus(): UserMcpPoolStatus {
    const instancesByUser = new Map<string, number>();
    let totalConnections = 0;

    for (const [userId, instanceSet] of this.userInstances) {
      const connectionCount = instanceSet.connections.size;
      instancesByUser.set(userId, connectionCount);
      totalConnections += connectionCount;
    }

    return {
      totalUserInstances: this.userInstances.size,
      userCount: this.userInstances.size,
      instancesByUser,
      totalConnections,
    };
  }

  /**
   * Get all user instances for a specific MCP
   */
  getInstancesForMcp(mcpName: string): Array<{
    userId: string;
    status: string;
    spawnedAt: Date;
    connected: boolean;
    toolCount: number;
    last_error: string | null; // M33.1: NEW
    error_count: number; // M33.1: NEW
    stderr_tail: import('./error-ring-buffer.js').ErrorLogEntry[]; // M33.1: NEW
  }> {
    const result: Array<{
      userId: string;
      status: string;
      spawnedAt: Date;
      connected: boolean;
      toolCount: number;
      last_error: string | null;
      error_count: number;
      stderr_tail: import('./error-ring-buffer.js').ErrorLogEntry[];
    }> = [];

    for (const [userId, instanceSet] of this.userInstances) {
      const connection = instanceSet.connections.get(mcpName);
      if (connection) {
        // M33.1: Get error info from connection
        const lastError = connection.getLastError();
        const errorCount = connection.getErrorCount();
        const errorHistory = connection.getErrorHistory();
        // Limit to 20 most recent entries for listing view
        const stderrTail = errorHistory.slice(-20);

        result.push({
          userId,
          status: instanceSet.status,
          spawnedAt: instanceSet.spawnedAt,
          connected: connection.isConnected(),
          toolCount: connection.getTools().length,
          last_error: lastError?.message ?? null,
          error_count: errorCount,
          stderr_tail: stderrTail,
        });
      }
    }

    return result;
  }

  /**
   * CR-M17-006: Register event handlers for a connection
   * Extracted helper to avoid code duplication between stdio and http setup
   */
  private registerConnectionHandlers(
    connection: StdioMcpConnection | HttpMcpConnection,
    userId: string,
    mcpName: string
  ): void {
    connection.on('disconnect', () => {
      console.log(`[UserMcpPool] User ${userId} MCP ${mcpName} disconnected`);
      this.aggregateToolsForUser(userId);
    });

    connection.on('error', err => {
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      console.error(`[UserMcpPool] User ${userId} MCP ${mcpName} error:`, err);
    });
  }

  /**
   * N1 fix: Public getter for MCP config names
   * Used by catalog reloader for diffing without accessing private fields
   */
  getMcpConfigNames(): string[] {
    return this.config.mcpConfigs.map(c => c.name);
  }

  /**
   * ADR-013 B1 fix: Return stored catalog-derived fingerprints
   * These are set at startup and updated via updateMcpConfigs/setMcpConfigFingerprints
   */
  getMcpConfigFingerprints(): Map<string, string> {
    return new Map(this.storedMcpFingerprints);
  }

  /**
   * ADR-013 B1 fix: Set initial fingerprints from catalog entries at startup
   * Called by server.ts after constructing UserMcpPool from catalog data
   */
  setMcpConfigFingerprints(fingerprints: Map<string, string>): void {
    this.storedMcpFingerprints = new Map(fingerprints);
  }

  /**
   * ADR-013: Update MCP configs for future spawns (hot reload)
   * Updates the template configs used for per-user instance spawning.
   * Active user instances continue with old configs until sessions end.
   *
   * @param newConfigs New array of MCP configs from catalog
   * @returns Summary of config changes
   */
  updateMcpConfigs(
    newConfigs: DownstreamMcpConfig[],
    newFingerprints?: Map<string, string>
  ): { added: string[]; removed: string[]; updated: string[] } {
    // B1+B3 fix: Use stored catalog-derived fingerprints for accurate diff
    const oldFingerprints = this.getMcpConfigFingerprints();
    const oldNames = new Set(this.config.mcpConfigs.map(c => c.name));
    const newNames = new Set(newConfigs.map(c => c.name));

    const added = newConfigs.filter(c => !oldNames.has(c.name)).map(c => c.name);
    const removed = [...oldNames].filter(n => !newNames.has(n));

    // B3 fix: Only mark as updated if fingerprint differs
    const updated: string[] = [];
    if (newFingerprints) {
      for (const config of newConfigs) {
        if (!oldNames.has(config.name)) continue;
        const oldFp = oldFingerprints.get(config.name);
        const newFp = newFingerprints.get(config.name);
        if (oldFp !== newFp) {
          updated.push(config.name);
        }
      }
    }

    // Update config and fingerprints
    this.config.mcpConfigs = newConfigs;
    if (newFingerprints) {
      this.storedMcpFingerprints = new Map(newFingerprints);
    }

    console.log(
      `[UserMcpPool] Config updated: +${added.length} -${removed.length} ~${updated.length}`
    );

    return { added, removed, updated };
  }

  /**
   * M17.7: Periodic health check
   * Verifies connections are alive, logs unhealthy ones
   */
  private performHealthCheck(): void {
    for (const [userId, instanceSet] of this.userInstances) {
      if (instanceSet.status !== 'ready') {
        continue;
      }

      for (const [mcpName, connection] of instanceSet.connections) {
        if (!connection.isConnected()) {
          console.warn(`[UserMcpPool] User ${userId} MCP ${mcpName} is unhealthy`);
        }
      }
    }
  }

  /**
   * Shutdown all user instances (server shutdown)
   * Terminates all per-user MCP connections
   */
  async shutdown(): Promise<void> {
    console.log('[UserMcpPool] Shutting down all user instances...');

    // Stop health check interval
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    // Terminate all users (parallel)
    const userIds = Array.from(this.userInstances.keys());
    const terminatePromises = userIds.map(userId => this.terminateForUser(userId));

    await Promise.allSettled(terminatePromises);

    this.userInstances.clear();
    this.spawningUsers.clear();

    console.log('[UserMcpPool] Shutdown complete');
  }
}
