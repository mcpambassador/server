/**
 * @mcpambassador/authz-local
 *
 * Local RBAC Authorization Provider (Phase 1)
 *
 * Authorizes tool access based on Tool Profiles stored in the database.
 * Supports glob patterns, deny lists, rate limits, and profile inheritance.
 *
 * @see Architecture §5.2 AuthorizationProvider
 * @see Architecture §10 Authorization Logic Deep Dive
 */

/* eslint-disable no-console, @typescript-eslint/require-await, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any */

import type {
  AuthorizationProvider,
  AuthzDecision,
  SessionContext,
  AuthzRequest,
  ProviderHealth,
} from '@mcpambassador/core';
import { getEffectiveProfile, getClientById, type DatabaseClient } from '@mcpambassador/core';
import type { ToolDescriptor } from '@mcpambassador/protocol';

/**
 * Local RBAC Authorization Provider
 *
 * Checks if a tool is allowed based on the client's effective profile.
 * Profile resolution includes inheritance chain merging.
 *
 * Authorization logic:
 * 1. Retrieve client's profile from database
 * 2. Resolve effective profile (merge inheritance chain)
 * 3. Check denied_tools (deny-wins - if matched, deny immediately)
 * 4. Check allowed_tools (if matched, permit)
 * 5. Default deny (if no explicit allow rule matches)
 */
export class LocalRbacProvider implements AuthorizationProvider {
  readonly id = 'local_rbac';

  constructor(private db: DatabaseClient) {}

  /**
   * Initialize provider (required by ProviderLifecycle)
   */
  async initialize(_config: Record<string, unknown>): Promise<void> {
    // No initialization required for local RBAC
    console.log(`[authz:local] Initialized: provider_id=${this.id}`);
  }

  /**
   * Health check (required by ProviderLifecycle)
   *
   * Verifies database connectivity by querying profile count.
   */
  async healthCheck(): Promise<ProviderHealth> {
    const startTime = Date.now();
    try {
      // Simple query to verify DB connectivity
      const profiles = await this.db.query.tool_profiles.findMany();
      const latency_ms = Date.now() - startTime;

      return {
        status: 'healthy',
        message: `DB connected, ${profiles.length} profiles available`,
        latency_ms,
        last_checked: new Date().toISOString(),
      };
    } catch (error) {
      const latency_ms = Date.now() - startTime;
      return {
        status: 'unhealthy',
        message: `DB error: ${error instanceof Error ? error.message : String(error)}`,
        latency_ms,
        last_checked: new Date().toISOString(),
      };
    }
  }

  /**
   * Shutdown provider (required by ProviderLifecycle)
   */
  async shutdown(): Promise<void> {
    // No cleanup required
    console.log(`[authz:local] Shutdown complete`);
  }

  /**
   * Authorize tool access for a session
   *
   * @param session Session context from authentication
   * @param request Authorization request with tool name and arguments
   * @returns Authorization decision (permit/deny) with policy details
   */
  async authorize(session: SessionContext, request: AuthzRequest): Promise<AuthzDecision> {
    const { tool_name } = request;

    // 1. Get client record to retrieve profile_id
    const client = await getClientById(this.db, session.client_id);
    if (!client) {
      return {
        decision: 'deny',
        reason: `Client not found: ${session.client_id}`,
        policy_id: 'system_default',
      };
    }

    // 2. Check if client is suspended or revoked
    if (client.status === 'suspended') {
      return {
        decision: 'deny',
        reason: 'Client is suspended',
        policy_id: 'system_lifecycle',
      };
    }

    if (client.status === 'revoked') {
      return {
        decision: 'deny',
        reason: 'Client is revoked',
        policy_id: 'system_lifecycle',
      };
    }

    // 3. Get effective profile (merged from inheritance chain)
    let effectiveProfile;
    try {
      effectiveProfile = await getEffectiveProfile(this.db, client.profile_id);
    } catch (error) {
      console.error(`[authz:local] Failed to resolve profile ${client.profile_id}:`, error);
      return {
        decision: 'deny',
        reason: 'Profile resolution error',
        policy_id: 'system_error',
      };
    }

    // 4. DENY-WINS: Check denied_tools first
    for (const deniedPattern of effectiveProfile.denied_tools) {
      if (matchGlob(deniedPattern, tool_name)) {
        return {
          decision: 'deny',
          reason: `Tool denied by profile rule: ${deniedPattern}`,
          policy_id: effectiveProfile.profile_id,
        };
      }
    }

    // 5. Check allowed_tools
    for (const allowedPattern of effectiveProfile.allowed_tools) {
      if (matchGlob(allowedPattern, tool_name)) {
        return {
          decision: 'permit',
          reason: `Tool allowed by profile rule: ${allowedPattern}`,
          policy_id: effectiveProfile.profile_id,
        };
      }
    }

    // 6. Default deny (no explicit allow rule matched)
    return {
      decision: 'deny',
      reason: 'No matching allow rule (default deny)',
      policy_id: effectiveProfile.profile_id,
    };
  }

  /**
   * List all tools that the session is authorized to use
   *
   * Filters the full tool catalog based on the session's effective profile.
   *
   * @param session Session context from authentication
   * @param allTools Full tool catalog from all downstream MCPs
   * @returns Filtered list of authorized tools
   */
  async listAuthorizedTools(
    session: SessionContext,
    allTools: ToolDescriptor[]
  ): Promise<ToolDescriptor[]> {
    // Get client and effective profile
    const client = await getClientById(this.db, session.client_id);
    if (!client) {
      console.warn(`[authz:local] Client not found for session ${session.session_id}`);
      return [];
    }

    if (client.status !== 'active') {
      console.warn(
        `[authz:local] Client ${client.client_id} is ${client.status}, returning empty tool list`
      );
      return [];
    }

    let effectiveProfile;
    try {
      effectiveProfile = await getEffectiveProfile(this.db, client.profile_id);
    } catch (error) {
      console.error(`[authz:local] Failed to resolve profile ${client.profile_id}:`, error);
      return [];
    }

    // Filter tools using same logic as authorize()
    const authorizedTools: ToolDescriptor[] = [];

    for (const tool of allTools) {
      // Check denied_tools first (deny-wins)
      const isDenied = effectiveProfile.denied_tools.some((pattern: string) =>
        matchGlob(pattern, tool.name)
      );
      if (isDenied) {
        continue; // Skip this tool
      }

      // Check allowed_tools
      const isAllowed = effectiveProfile.allowed_tools.some((pattern: string) =>
        matchGlob(pattern, tool.name)
      );
      if (isAllowed) {
        authorizedTools.push(tool);
      }

      // Default deny: if not explicitly allowed, skip
    }

    return authorizedTools;
  }
}

/**
 * Maximum pattern length to prevent ReDoS attacks (F-SEC-M5-001)
 */
const MAX_PATTERN_LENGTH = 200;

/**
 * Match tool name against glob pattern
 *
 * Supports * wildcard (e.g., "github.*" matches "github.search_code").
 * Special cases:
 * - "*" matches all tools
 * - "github.*" matches "github.search_code", "github.create_issue", etc.
 * - "github.search_*" matches "github.search_code", "github.search_issues", etc.
 * - Exact match (no wildcard) requires full string equality
 *
 * Security: Uses linear-time string matching instead of regex to prevent ReDoS.
 * No regex engine = no catastrophic backtracking possible.
 *
 * @param pattern Glob pattern (may contain * wildcards)
 * @param tool Fully qualified tool name
 * @returns True if tool matches pattern, false if pattern too long
 */
export function matchGlob(pattern: string, tool: string): boolean {
  // Enforce max pattern length (F-SEC-M5-001)
  if (pattern.length > MAX_PATTERN_LENGTH) {
    console.warn(
      `[authz:local] Pattern exceeds max length (${MAX_PATTERN_LENGTH}): ${pattern.substring(0, 50)}...`
    );
    return false;
  }

  // Special case: "*" matches everything
  if (pattern === '*') {
    return true;
  }

  // Exact match (no wildcard)
  if (!pattern.includes('*')) {
    return pattern === tool;
  }

  // Linear-time glob matching without regex (F-SEC-M5-001)
  const parts = pattern.split('*');
  let pos = 0;

  // First segment must match at start
  if (parts[0] && !tool.startsWith(parts[0])) {
    return false;
  }
  pos = parts[0]!.length;

  // Last segment must match at end
  const last = parts[parts.length - 1];
  if (last && !tool.endsWith(last)) {
    return false;
  }
  const endReserved = last ? last.length : 0;

  // Middle segments must appear in order
  for (let i = 1; i < parts.length - 1; i++) {
    const segment = parts[i]!;
    if (segment === '') continue; // Skip empty segments from consecutive **
    const idx = tool.indexOf(segment, pos);
    if (idx === -1 || idx + segment.length > tool.length - endReserved) {
      return false;
    }
    pos = idx + segment.length;
  }

  return true;
}
