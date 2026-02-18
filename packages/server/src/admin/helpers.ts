/**
 * Admin UI Template Helpers
 *
 * Utility functions for fetching and formatting data for EJS templates
 */

import type { DatabaseClient } from '@mcpambassador/core';

// Template/data interfaces for admin UI helpers
export interface McpStatusItem {
  name?: string;
  transport?: string;
  status?: string;
  toolCount?: number;
}

export interface AuditEventSummary {
  timestamp: string | number;
  client_id?: string | null;
  action?: string | null;
  tool_name?: string | null;
  decision?: string | null;
  profile_id?: string | null;
}

export interface ClientSummary {
  id?: string;
  name?: string;
  profile_name?: string;
  status?: string;
  created_at?: string | number;
}

export interface ProfileSummary {
  id?: string;
  name?: string;
  allowed_tools?: string;
  denied_tools?: string;
}
import {
  listClients,
  listToolProfiles,
  getToolProfileById,
  queryAuditEvents,
} from '@mcpambassador/core';
import type { DownstreamMcpManager } from '../downstream/index.js';

/**
 * Get dashboard data (summary stats)
 */
export async function getDashboardData(
  db: DatabaseClient,
  mcpManager: DownstreamMcpManager
): Promise<{
  clientCount: number;
  profileCount: number;
  mcpStatus: McpStatusItem[];
  auditEvents: AuditEventSummary[];
}> {
  // Run dashboard queries in parallel
  const [clientsData, profilesData, mcpStatus, auditData] = await Promise.all([
    listClients(db, undefined, { limit: 100 }),
    listToolProfiles(db, {}),
    Promise.resolve(mcpManager.getStatus()),
    queryAuditEvents(db, undefined, { limit: 10 }),
  ]);
  const clientCount = clientsData.clients.length;
  const profileCount = profilesData.profiles.length;

  return {
    clientCount,
    profileCount,
    mcpStatus: Array.isArray(mcpStatus) ? (mcpStatus as McpStatusItem[]) : [],
    auditEvents: auditData.events || [],
  };
}

/**
 * Get all clients
 */
export async function getClients(
  db: DatabaseClient,
  page = 1,
  limit = 20
): Promise<{
  clients: ClientSummary[];
  page: number;
  limit: number;
  hasMore: boolean;
}> {
  // For Phase 1, just get first page of clients
  // Phase 2 will implement proper cursor-based pagination
  const clientsData = await listClients(db, undefined, { limit });

  return {
    clients: clientsData.clients || [],
    page,
    limit,
    hasMore: clientsData.has_more ?? false,
  };
}

/**
 * Get all profiles
 */
export async function getProfiles(db: DatabaseClient): Promise<ProfileSummary[]> {
  const { profiles } = await listToolProfiles(db, {});
  return (profiles || []) as ProfileSummary[];
}

/**
 * Get single profile by ID
 */
export async function getProfile(db: DatabaseClient, id: string): Promise<ProfileSummary | null> {
  const profile = await getToolProfileById(db, id);
  return (profile as ProfileSummary) || null;
}

/**
 * Get kill switches
 * Note: Kill switches are currently in-memory. This returns empty array.
 * Phase 2/3 will implement persistent storage.
 */
export function getKillSwitches(_db: DatabaseClient): unknown[] {
  // Kill switches are in-memory in routes.ts for Phase 1
  // Return empty array for now
  return [];
}

/**
 * Get audit log with pagination
 */
export async function getAuditLog(
  db: DatabaseClient,
  page = 1,
  limit = 50,
  filters?: { client_id?: string; action?: string }
): Promise<{
  events: AuditEventSummary[];
  page: number;
  limit: number;
  hasMore: boolean;
}> {
  // For Phase 1, just get first page of events
  // Phase 2 will implement proper cursor-based pagination
  const auditData = await queryAuditEvents(
    db,
    {
      client_id: filters?.client_id,
      action: filters?.action,
    },
    { limit }
  );

  return {
    events: auditData.events || [],
    page,
    limit,
    hasMore: auditData.has_more ?? false,
  };
}

/**
 * Format timestamp for display
 */
export function formatTimestamp(ts: number | string): string {
  const date = typeof ts === 'string' ? new Date(ts) : new Date(ts);
  return date.toISOString().replace('T', ' ').substring(0, 19);
}
