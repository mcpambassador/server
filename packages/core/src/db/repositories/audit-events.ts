/**
 * Audit Event Repository
 * 
 * Data access layer for audit events (database-backed audit provider, Phase 2).
 * In Phase 1, the file audit provider writes JSONL directly, not via this repo.
 * 
 * @see Architecture §5.3 AuditEvent
 * @see Architecture §11 Audit Deep Dive
 * @see schema/index.ts audit_events table
 */

import { eq, and, gte, lte, desc, sql } from 'drizzle-orm';
import type { DatabaseClient } from '../client.js';
import { audit_events, type AuditEvent, type NewAuditEvent } from '../../schema/index.js';
import { v4 as uuidv4 } from 'uuid';
import { compatInsert, compatSelect, compatDelete } from '../compat.js';

/**
 * Insert audit event
 * 
 * @param db Database client
 * @param event Audit event data
 */
export async function insertAuditEvent(db: DatabaseClient, event: Omit<NewAuditEvent, 'event_id'>): Promise<void> {
  const event_id = uuidv4();
  
  const newEvent: NewAuditEvent = {
    event_id,
    timestamp: event.timestamp || new Date().toISOString(),
    event_type: event.event_type,
    severity: event.severity,
    session_id: event.session_id,
    client_id: event.client_id,
    user_id: event.user_id,
    auth_method: event.auth_method,
    source_ip: event.source_ip,
    tool_name: event.tool_name,
    downstream_mcp: event.downstream_mcp,
    action: event.action,
    request_summary: event.request_summary || '{}',
    response_summary: event.response_summary || '{}',
    authz_decision: event.authz_decision,
    authz_policy: event.authz_policy,
    ambassador_node: event.ambassador_node,
    metadata: event.metadata || '{}',
  };
  
  await compatInsert(db, audit_events).values(newEvent);
}

/**
 * Query audit events with filters and pagination
 * 
 * @param db Database client
 * @param filters Query filters
 * @param pagination Cursor-based pagination (§16.4)
 * @returns Array of audit events + pagination metadata
 */
export async function queryAuditEvents(
  db: DatabaseClient,
  filters?: {
    start_time?: string; // ISO 8601
    end_time?: string;   // ISO 8601
    client_id?: string;
    user_id?: string;
    event_type?: string;
    severity?: 'info' | 'warn' | 'error' | 'critical';
    action?: string;
  },
  pagination?: {
    limit?: number;
    cursor?: string; // timestamp ISO 8601
  }
): Promise<{ events: AuditEvent[]; has_more: boolean; next_cursor?: string; total_count?: number }> {
  const limit = pagination?.limit || 100;
  
  let query = compatSelect(db).from(audit_events);
  
  // Build conditions
  const conditions = [];
  
  if (filters?.start_time) {
    conditions.push(gte(audit_events.timestamp, filters.start_time));
  }
  if (filters?.end_time) {
    conditions.push(lte(audit_events.timestamp, filters.end_time));
  }
  if (filters?.client_id) {
    conditions.push(eq(audit_events.client_id, filters.client_id));
  }
  if (filters?.user_id) {
    conditions.push(eq(audit_events.user_id, filters.user_id));
  }
  if (filters?.event_type) {
    conditions.push(eq(audit_events.event_type, filters.event_type as any));
  }
  if (filters?.severity) {
    conditions.push(eq(audit_events.severity, filters.severity));
  }
  if (filters?.action) {
    conditions.push(eq(audit_events.action, filters.action));
  }
  
  // Cursor pagination (by timestamp DESC)
  if (pagination?.cursor) {
    conditions.push(sql`${audit_events.timestamp} < ${pagination.cursor}`);
  }
  
  if (conditions.length > 0) {
    query = query.where(and(...conditions));
  }
  
  // Order by timestamp DESC, limit + 1 to detect has_more
  const results = await query
    .orderBy(desc(audit_events.timestamp))
    .limit(limit + 1);
  
  const has_more = results.length > limit;
  const eventsPage = has_more ? results.slice(0, limit) : results;
  const next_cursor = has_more ? eventsPage[eventsPage.length - 1].timestamp : undefined;
  
  return {
    events: eventsPage,
    has_more,
    next_cursor,
  };
}

/**
 * Get audit event by ID
 */
export async function getAuditEventById(db: DatabaseClient, event_id: string): Promise<AuditEvent | null> {
  const [event] = await compatSelect(db)
    .from(audit_events)
    .where(eq(audit_events.event_id, event_id))
    .limit(1);
  
  return event || null;
}

/**
 * Count audit events (for dashboard metrics)
 */
export async function countAuditEvents(
  db: DatabaseClient,
  filters?: {
    start_time?: string;
    end_time?: string;
    client_id?: string;
    event_type?: string;
    severity?: string;
  }
): Promise<number> {
  const conditions = [];
  
  if (filters?.start_time) {
    conditions.push(gte(audit_events.timestamp, filters.start_time));
  }
  if (filters?.end_time) {
    conditions.push(lte(audit_events.timestamp, filters.end_time));
  }
  if (filters?.client_id) {
    conditions.push(eq(audit_events.client_id, filters.client_id));
  }
  if (filters?.event_type) {
    conditions.push(eq(audit_events.event_type, filters.event_type as any));
  }
  if (filters?.severity) {
    conditions.push(eq(audit_events.severity, filters.severity as any));
  }
  
  let query = compatSelect(db, { count: sql<number>`count(*)`.as('count') })
    .from(audit_events);
  
  if (conditions.length > 0) {
    query = query.where(and(...conditions));
  }
  
  const [result] = await query;
  return result?.count || 0;
}

/**
 * Delete old audit events (retention policy enforcement)
 * 
 * @param db Database client
 * @param olderThan ISO 8601 timestamp (delete events older than this)
 * @returns Number of events deleted
 */
export async function deleteOldAuditEvents(db: DatabaseClient, olderThan: string): Promise<number> {
  await compatDelete(db, audit_events)
    .where(sql`${audit_events.timestamp} < ${olderThan}`);
  
  // Drizzle doesn't return rowCount directly, would need to query count first
  console.log(`[db:audit-events] Deleted audit events older than ${olderThan}`);
  
  return 0; // Placeholder - actual count requires SQL-specific query
}

/**
 * Get audit statistics (for dashboard)
 */
export async function getAuditStatistics(
  db: DatabaseClient,
  timeRange: { start_time: string; end_time: string }
): Promise<{
  total_events: number;
  by_event_type: { event_type: string; count: number }[];
  by_severity: { severity: string; count: number }[];
  by_client: { client_id: string; count: number }[];
}> {
  const conditions = [
    gte(audit_events.timestamp, timeRange.start_time),
    lte(audit_events.timestamp, timeRange.end_time),
  ];
  
  // Total count
  const [totalResult] = await compatSelect(db, { count: sql<number>`count(*)`.as('count') })
    .from(audit_events)
    .where(and(...conditions));
  
  const total_events = totalResult?.count || 0;
  
  // By event type
  const by_event_type = await compatSelect(db, {
      event_type: audit_events.event_type,
      count: sql<number>`count(*)`.as('count'),
    })
    .from(audit_events)
    .where(and(...conditions))
    .groupBy(audit_events.event_type)
    .orderBy(desc(sql`count(*)`))
    .limit(10);
  
  // By severity
  const by_severity = await compatSelect(db, {
      severity: audit_events.severity,
      count: sql<number>`count(*)`.as('count'),
    })
    .from(audit_events)
    .where(and(...conditions))
    .groupBy(audit_events.severity)
    .orderBy(desc(sql`count(*)`));
  
  // By client (top 10)
  const by_client = await compatSelect(db, {
      client_id: audit_events.client_id,
      count: sql<number>`count(*)`.as('count'),
    })
    .from(audit_events)
    .where(and(...conditions))
    .groupBy(audit_events.client_id)
    .orderBy(desc(sql`count(*)`))
    .limit(10);
  
  return {
    total_events,
    by_event_type: by_event_type.map((r: any) => ({ event_type: r.event_type, count: r.count })),
    by_severity: by_severity.map((r: any) => ({ severity: r.severity, count: r.count })),
    by_client: by_client.filter((r: any) => r.client_id).map((r: any) => ({ client_id: r.client_id!, count: r.count })),
  };
}
