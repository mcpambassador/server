/**
 * Admin UI Template Helpers
 *
 * Utility functions for fetching and formatting data for EJS templates
 */

import type { DatabaseClient } from '@mcpambassador/core';
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
  mcpStatus: unknown[];
  auditEvents: unknown[];
}> {
  // Get client count - use pagination to get approximate count
  const clientsData = await listClients(db, undefined, { limit: 100 });
  const clientCount = clientsData.clients.length;

  // Get profile count using listToolProfiles
  const profilesData = await listToolProfiles(db, {});
  const profileCount = profilesData.profiles.length;

  // Get downstream MCP status
  const mcpStatus = mcpManager.getStatus();

  // Get recent audit events (last 10)
  const auditData = await queryAuditEvents(db, undefined, { limit: 10 });

  return {
    clientCount,
    profileCount,
    mcpStatus: Array.isArray(mcpStatus) ? mcpStatus : [],
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
  clients: unknown[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}> {
  // For Phase 1, just get first page of clients
  // Phase 2 will implement proper cursor-based pagination
  const clientsData = await listClients(db, undefined, { limit });

  return {
    clients: clientsData.clients || [],
    total: clientsData.clients.length, // Approximate
    page,
    limit,
    totalPages: clientsData.has_more ? page + 1 : page,
  };
}

/**
 * Get all profiles
 */
export async function getProfiles(db: DatabaseClient): Promise<unknown[]> {
  const { profiles } = await listToolProfiles(db, {});
  return profiles || [];
}

/**
 * Get single profile by ID
 */
export async function getProfile(db: DatabaseClient, id: string): Promise<Record<string, unknown> | null> {
  const profile = await getToolProfileById(db, id);
  return profile || null;
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
  events: unknown[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
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
    total: auditData.events.length, // Approximate
    page,
    limit,
    totalPages: auditData.has_more ? page + 1 : page,
  };
}

/**
 * Format timestamp for display
 */
export function formatTimestamp(ts: number | string): string {
  const date = typeof ts === 'string' ? new Date(ts) : new Date(ts);
  return date.toISOString().replace('T', ' ').substring(0, 19);
}
