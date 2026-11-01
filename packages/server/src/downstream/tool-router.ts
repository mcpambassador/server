import type { SharedMcpManager } from './manager.js';
import type { UserMcpPool, UserMcpPoolStatus } from './user-mcp-pool.js';
import type { AggregatedTool, ToolInvocationRequest, ToolInvocationResponse } from './types.js';
import { validateToolName } from './types.js';
import { logger, getMcpPinPolicy } from '@mcpambassador/core';
import type { PinPolicy } from '@mcpambassador/contracts';
import type { ToolPinService } from '../services/tool-pins/pin-service.js';
import { truncateDescriptionForServe } from '../services/tool-pins/flags.js';
import type { DatabaseClient } from '@mcpambassador/core';

/**
 * Combined MCP Status
 * Merges status from shared manager + user pool
 */
export interface CombinedMcpStatus {
  shared: {
    total_connections: number;
    healthy_connections: number;
    total_tools: number;
    connections: Array<{ name: string; connected: boolean; tool_count: number }>;
  };
  perUser: UserMcpPoolStatus;
}

/**
 * Tool Router
 *
 * M17.2: Composition layer that unifies shared and per-user tool catalogs
 *
 * Responsibilities:
 * - Merge tool catalogs from SharedMcpManager + UserMcpPool
 * - Route tool invocations to correct manager (shared or per-user)
 * - Handle tool name conflicts (shared wins)
 * - Provide combined status for admin dashboard
 *
 * Per ADR-012 §Design/Tool Catalog Composition Strategy
 */
export class ToolRouter {
  /** ADR-021: when set, only admin-approved pinned definitions are served (D2/D3). */
  private pins?: ToolPinService;
  /** raw tools/list array (by identity) -> policy it was last observed under; avoids hashing per request */
  private observed = new WeakMap<object, { policy: PinPolicy; done: Promise<void> }>();
  /** D6 hook: baseline hashes (tool name -> hash) for an MCP's first observation, if any */
  private baselineFor?: (
    mcpId: string,
    scopeUserId: string | null
  ) => Promise<Map<string, string> | undefined>;

  constructor(
    private sharedManager: SharedMcpManager,
    private userPool: UserMcpPool
  ) {
    logger.info('[ToolRouter] Initialized');
  }

  setPinService(
    pins: ToolPinService | undefined,
    baselineFor?: (
      mcpId: string,
      scopeUserId: string | null
    ) => Promise<Map<string, string> | undefined>
  ): void {
    this.pins = pins;
    this.baselineFor = baselineFor;
  }

  getPinService(): ToolPinService | undefined {
    return this.pins;
  }

  /** Drop memoised observations so the next catalog read re-compares (re-discovery, policy change). */
  invalidatePinObservations(): void {
    this.observed = new WeakMap();
  }

  /**
   * ADR-021: observe a shared MCP's current raw tool list now (after a re-discovery), so changes reach the
   * review queue without waiting for an agent to list tools. Never throws.
   */
  async observeSharedNow(
    db: DatabaseClient,
    mcpEntry: { mcp_id: string; name: string }
  ): Promise<void> {
    if (!this.pins) return;
    const raw = this.sharedManager.getRawToolsFor(mcpEntry.name);
    if (!raw) return;
    try {
      const policy: PinPolicy = (await getMcpPinPolicy(db, mcpEntry.mcp_id)) ?? 'review';
      await this.observeOnce(raw, mcpEntry.mcp_id, null, policy);
    } catch (err) {
      logger.error({ err, mcp: mcpEntry.name }, '[ToolRouter] tool pin observation failed');
    }
  }

  /** Compare one connection's raw tool list with the pins, once per (array identity, policy). */
  private async observeOnce(
    raw: readonly unknown[],
    mcpId: string,
    scopeUserId: string | null,
    policy: PinPolicy
  ): Promise<void> {
    const pins = this.pins!;
    const prev = this.observed.get(raw as object);
    if (prev && prev.policy === policy) return prev.done;
    const done = (async () => {
      const baseline = this.baselineFor ? await this.baselineFor(mcpId, scopeUserId) : undefined;
      await pins.observe({ mcpId, scopeUserId, liveTools: [...raw], policy, baseline });
    })();
    this.observed.set(raw as object, { policy, done });
    try {
      await done;
    } catch (err) {
      this.observed.delete(raw as object); // retry next time; the tools stay hidden meanwhile
      throw err;
    }
  }

  /**
   * ADR-021: the tools of one MCP as the agent may see them: only those with an approved pin, built from
   * the approved canonical definition (never the live one). Fails closed on any error.
   */
  private async pinnedToolsFor(
    db: DatabaseClient,
    mcpEntry: { mcp_id: string; name: string; isolation_mode: string },
    userId: string
  ): Promise<AggregatedTool[]> {
    const pins = this.pins!;
    const shared = mcpEntry.isolation_mode === 'shared';
    const raw = shared
      ? this.sharedManager.getRawToolsFor(mcpEntry.name)
      : this.userPool.getRawToolsFor(userId, mcpEntry.name);
    if (!raw) return [];
    const scope = shared ? null : userId;
    try {
      const policy: PinPolicy = (await getMcpPinPolicy(db, mcpEntry.mcp_id)) ?? 'review';
      await this.observeOnce(raw, mcpEntry.mcp_id, scope, policy);
    } catch (err) {
      logger.error(
        { err, mcp: mcpEntry.name },
        '[ToolRouter] tool pin observation failed; failing closed'
      );
      return [];
    }
    const out: AggregatedTool[] = [];
    const seen = new Set<string>();
    // duplicate_name: a name that appears twice in one tools/list hides BOTH entries.
    const counts = new Map<string, number>();
    for (const t of raw) {
      const n = (t as { name?: unknown } | null)?.name;
      if (typeof n === 'string') counts.set(n, (counts.get(n) ?? 0) + 1);
    }
    for (const t of raw) {
      const name = (t as { name?: unknown } | null)?.name;
      if (typeof name !== 'string' || !validateToolName(name) || seen.has(name)) continue;
      seen.add(name);
      if ((counts.get(name) ?? 0) > 1) continue;
      const approved = pins.resolveApproved(mcpEntry.mcp_id, scope, name);
      if (!approved) continue;
      const d = approved.definition;
      out.push({
        name,
        // SEC-M9-05 / ADR-021 D1': agents are served T(approved) = the approved description cut to
        // 500 code points. The hash and the admin review cover the FULL text; the `truncated_on_serve`
        // flag marks tools where the two differ. Every serve path must go through this function.
        description:
          d.description === undefined ? d.description : truncateDescriptionForServe(d.description),
        inputSchema: (d.inputSchema as AggregatedTool['inputSchema']) ?? { type: 'object' },
        source_mcp: mcpEntry.name,
        pinned_hash: approved.hash,
      });
    }
    return out;
  }

  /**
   * Get composed tool catalog for a user: shared + per-user union
   * Shared tools come first. Per-user tools are appended.
   * Tool name conflicts: shared wins (per-user tool is skipped with warning)
   *
   * Per ADR-012: "Shared MCPs are admin-configured and represent the stable,
   * server-wide tool surface. Per-user MCPs are user-provisioned. If a user
   * subscribes to an MCP that provides a tool with the same name as a shared
   * MCP tool, the shared version takes precedence."
   */
  getToolCatalog(userId: string): AggregatedTool[] {
    const sharedTools = this.sharedManager.getToolCatalog();
    const userTools = this.userPool.getToolCatalog(userId);

    // Build set of shared tool names for deduplication
    const sharedToolNames = new Set(sharedTools.map(tool => tool.name));

    // Filter out user tools that conflict with shared tools
    const deduplicatedUserTools = userTools.filter(tool => {
      if (sharedToolNames.has(tool.name)) {
        logger.warn(
          `[ToolRouter] User ${userId} tool name conflict: ${tool.name} ` +
            `from per-user MCP ${tool.source_mcp} conflicts with shared tool. Using shared.`
        );
        return false;
      }
      return true;
    });

    // Return union: shared first, then deduplicated user tools
    return [...sharedTools, ...deduplicatedUserTools];
  }

  /**
   * Route tool invocation to the correct manager
   * Checks shared manager first, then user pool
   */
  async invokeTool(
    userId: string,
    request: ToolInvocationRequest
  ): Promise<ToolInvocationResponse> {
    // Check shared manager first
    const sharedTool = this.sharedManager.getToolDescriptor(request.tool_name);
    if (sharedTool) {
      logger.info(`[ToolRouter] Routing ${request.tool_name} to shared manager`);
      return await this.sharedManager.invokeTool(request);
    }

    // Check user pool
    const userTool = this.userPool.getToolDescriptor(userId, request.tool_name);
    if (userTool) {
      logger.info(`[ToolRouter] Routing ${request.tool_name} to user pool for ${userId}`);
      return await this.userPool.invokeTool(userId, request);
    }

    // Tool not found in either
    throw new Error(`Tool not found: ${request.tool_name}`);
  }

  /**
   * ADR-021 D2: invoke on the exact MCP the catalog resolved (never by bare tool name, which is
   * ambiguous across MCPs and could land on a different MCP's same-named tool).
   */
  async invokeOnSource(
    userId: string,
    sourceMcp: string,
    request: ToolInvocationRequest
  ): Promise<ToolInvocationResponse> {
    if (this.sharedManager.getRawToolsFor(sourceMcp) !== undefined) {
      return this.sharedManager.invokeToolOn(sourceMcp, request);
    }
    return this.userPool.invokeToolOn(userId, sourceMcp, request);
  }

  /**
   * Get tool descriptor from either shared or per-user catalog
   * Shared takes precedence
   */
  getToolDescriptor(userId: string, toolName: string): AggregatedTool | undefined {
    // Check shared first
    const sharedTool = this.sharedManager.getToolDescriptor(toolName);
    if (sharedTool) {
      return sharedTool;
    }

    // Check user pool
    return this.userPool.getToolDescriptor(userId, toolName);
  }

  /**
   * Get combined status (for admin health endpoint)
   * Merges status from shared manager + user pool
   */
  getStatus(): CombinedMcpStatus {
    return {
      shared: this.sharedManager.getStatus(),
      perUser: this.userPool.getStatus(),
    };
  }

  /**
   * Get subscription-filtered catalog for a client
   *
   * M25.7: Returns tools filtered by the client's active subscriptions.
   * This is intended for use by the MCP protocol handler when a client connects.
   *
   * @param db Database client
   * @param clientId Client UUID
   * @returns Aggregated tools based on client's subscriptions
   */
  async getSubscriptionFilteredCatalog(
    db: DatabaseClient,
    clientId: string
  ): Promise<AggregatedTool[]> {
    // Import catalog resolver service
    const { resolveEffectiveTools } = await import('../services/catalog-resolver.js');
    return resolveEffectiveTools(db, clientId);
  }

  /**
   * Get isolation-mode-aware tool catalog for a user
   *
   * M26.6: Returns tools considering isolation_mode from catalog.
   * - Shared MCPs: get tools from SharedMcpManager
   * - Per-user MCPs: get tools from UserMcpPool
   * - Applies subscription tool selection filters
   *
   * @param db Database client
   * @param userId User UUID
   * @param clientId Client UUID
   * @returns Aggregated tools based on isolation mode and subscriptions
   */
  async getIsolationAwareToolCatalog(
    db: DatabaseClient,
    userId: string,
    clientId: string,
    /** keepShadowed: keep same-named tools of different MCPs (ADR-022 P3 resolver); default first-wins */
    opts: { keepShadowed?: boolean } = {}
  ): Promise<AggregatedTool[]> {
    // Get client's subscriptions
    const { listClientSubscriptions } = await import('../services/subscription-service.js');
    const subscriptions = await listClientSubscriptions(db, { userId, clientId });

    const tools: AggregatedTool[] = [];
    const seenToolNames = new Set<string>();

    for (const sub of subscriptions) {
      if (sub.status !== 'active') {
        continue;
      }

      // Get MCP entry from catalog
      const { getMcpEntryById } = await import('@mcpambassador/core');
      const mcpEntry = await getMcpEntryById(db, sub.mcp_id);
      if (!mcpEntry) {
        logger.warn(`[ToolRouter] MCP ${sub.mcp_id} not found in catalog`);
        continue;
      }

      let mcpTools: AggregatedTool[] = [];

      if (this.pins) {
        // ADR-021 D2/D3: pin filter BEFORE name resolution, from the per-MCP raw list (the global
        // aggregate dedupes by name across MCPs and could let a pending tool shadow an approved one).
        mcpTools = await this.pinnedToolsFor(db, mcpEntry, userId);
      } else if (mcpEntry.isolation_mode === 'shared') {
        // Get tools from SharedMcpManager
        const sharedTools = this.sharedManager.getToolCatalog();
        mcpTools = sharedTools.filter(tool => tool.source_mcp === mcpEntry.name);
      } else if (mcpEntry.isolation_mode === 'per_user') {
        // Get tools from UserMcpPool
        const userTools = this.userPool.getToolCatalog(userId);
        mcpTools = userTools.filter(tool => tool.source_mcp === mcpEntry.name);
      }

      // Apply tool selection filter if specified
      if (sub.selected_tools && sub.selected_tools.length > 0) {
        const selectedSet = new Set(sub.selected_tools);
        mcpTools = mcpTools.filter(tool => selectedSet.has(tool.name));
      }

      // Add tools to result (deduplicate by name, first wins)
      for (const tool of mcpTools) {
        if (opts.keepShadowed || !seenToolNames.has(tool.name)) {
          tools.push(tool);
          seenToolNames.add(tool.name);
        } else {
          logger.warn(`[ToolRouter] Tool name conflict: ${tool.name} already seen, skipping`);
        }
      }
    }

    return tools;
  }
}
