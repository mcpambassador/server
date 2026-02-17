/**
 * Audit Event Reader
 *
 * Reads audit events from JSONL files with cursor-based pagination.
 *
 * @see packages/audit-file JSONL file format
 * @see dev-plan.md M8.10: Audit query endpoint
 */

import { createReadStream } from 'fs';
import path from 'path';
import { createInterface } from 'readline';
import type { AuditEvent } from '@mcpambassador/protocol';

/**
 * Audit query filters
 */
export interface AuditQueryFilters {
  start_time?: string;
  end_time?: string;
  client_id?: string;
  event_type?: string;
  limit?: number;
  cursor?: string; // ISO timestamp
}

/**
 * Query audit events from JSONL files
 *
 * @param dataDir Data directory (audit files are in dataDir/audit/)
 * @param filters Query filters
 * @returns Paginated audit events
 */
export async function queryAuditEvents(
  dataDir: string,
  filters: AuditQueryFilters
): Promise<{
  events: AuditEvent[];
  has_more: boolean;
  next_cursor: string | null;
}> {
  const auditDir = path.join(dataDir, 'audit');
  const limit = filters.limit || 20;

  // Determine date range
  const startDate = filters.start_time
    ? new Date(filters.start_time)
    : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // Default: 30 days ago
  const endDate = filters.end_time ? new Date(filters.end_time) : new Date();

  // Generate list of dates to scan
  const datesToScan: string[] = [];
  const currentDate = new Date(startDate);
  while (currentDate <= endDate) {
    const dateStr = currentDate.toISOString().split('T')[0];
    if (dateStr) {
      datesToScan.push(dateStr);
    }
    currentDate.setDate(currentDate.getDate() + 1);
  }

  // Read events from each date's file
  const events: AuditEvent[] = [];
  for (const date of datesToScan.reverse()) {
    // Reverse to get most recent first
    const filePath = path.join(auditDir, `audit-${date}.jsonl`);

    try {
      const fileEvents = await readAuditFile(filePath, filters);
      events.push(...fileEvents);

      // Stop if we've reached limit + 1 (to check has_more)
      if (events.length >= limit + 1) {
        break;
      }
    } catch (error) {
      // File might not exist (no events on that day) - this is okay
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`[audit-reader] Error reading ${filePath}:`, error);
      }
    }
  }

  // Sort by timestamp desc (most recent first)
  events.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  // Apply cursor pagination
  let filteredEvents = events;
  if (filters.cursor) {
    filteredEvents = events.filter(e => e.timestamp < filters.cursor!);
  }

  // Determine has_more and next_cursor
  const has_more = filteredEvents.length > limit;
  const page = has_more ? filteredEvents.slice(0, limit) : filteredEvents;
  const next_cursor = has_more ? page[page.length - 1]!.timestamp : null;

  return {
    events: page,
    has_more,
    next_cursor,
  };
}

/**
 * Read and filter audit events from a JSONL file
 *
 * @param filePath Path to JSONL audit file
 * @param filters Query filters
 * @returns Array of matching audit events
 */
async function readAuditFile(
  filePath: string,
  filters: AuditQueryFilters
): Promise<AuditEvent[]> {
  const events: AuditEvent[] = [];

  // Create readline interface for efficient line-by-line reading
  const fileStream = createReadStream(filePath, { encoding: 'utf-8' });
  const rl = createInterface({
    input: fileStream,
    crlfDelay: Infinity, // Treat \r\n as single line break
  });

  for await (const line of rl) {
    if (!line.trim()) {
      continue; // Skip empty lines
    }

    try {
      const event = JSON.parse(line) as AuditEvent;

      // Apply filters
      if (filters.client_id && event.client_id !== filters.client_id) {
        continue;
      }

      if (filters.event_type && event.event_type !== filters.event_type) {
        continue;
      }

      if (filters.start_time && event.timestamp < filters.start_time) {
        continue;
      }

      if (filters.end_time && event.timestamp > filters.end_time) {
        continue;
      }

      events.push(event);
    } catch (error) {
      console.error(`[audit-reader] Failed to parse line in ${filePath}:`, error);
      // Continue processing other lines
    }
  }

  return events;
}
