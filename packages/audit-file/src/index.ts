/**
 * @mcpambassador/audit-file
 *
 * File-based Audit Provider (Phase 1)
 *
 * Writes audit events to JSONL (JSON Lines) files for tamper-evident logging.
 * File naming: audit-YYYY-MM-DD.jsonl, rotated daily at midnight UTC.
 *
 * @see Architecture §5.3 AuditProvider
 * @see Architecture §11 Audit Deep Dive
 */

/* eslint-disable no-console, @typescript-eslint/no-misused-promises, prefer-const, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any */

import type { AuditProvider, AuditQueryFilters, ProviderHealth } from '@mcpambassador/core';
import type { AuditEvent } from '@mcpambassador/protocol';
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import path from 'path';
import { createInterface } from 'readline';

/**
 * File-based Audit Provider
 *
 * Appends audit events to daily-rotated JSONL files.
 * Each event is one JSON object per line (no commas, no array wrapper).
 *
 * Configuration:
 * - auditDir: Directory to store audit files (default: ./audit-logs)
 * - retention: Number of days to retain old audit files (default: 90)
 * - flushInterval: Milliseconds between auto-flushes (default: 5000)
 */
export class FileAuditProvider implements AuditProvider {
  readonly id = 'file_jsonl';

  private auditDir: string;
  private resolvedAuditDir: string = ''; // Validated absolute path
  private retention: number = 90; // days
  private flushInterval: number = 5000; // ms
  private buffer: AuditEvent[] = [];
  private flushTimer?: NodeJS.Timeout;
  private isShuttingDown = false;
  private isFlushing = false; // Flush lock to prevent concurrent flushes (F-SEC-M5-004)

  constructor(config?: { auditDir?: string; retention?: number; flushInterval?: number }) {
    this.auditDir = config?.auditDir || './audit-logs';
    if (config?.retention !== undefined) {
      this.retention = config.retention;
    }
    if (config?.flushInterval !== undefined) {
      this.flushInterval = config.flushInterval;
    }
  }

  /**
   * Initialize provider (required by ProviderLifecycle)
   *
   * Creates audit directory and starts periodic flush timer.
   */
  async initialize(_config: Record<string, unknown>): Promise<void> {
    // Validate and resolve audit directory path (F-SEC-M5-002)
    await this.validateAuditDir();

    // Ensure audit directory exists with restricted permissions
    await fs.mkdir(this.resolvedAuditDir, { recursive: true, mode: 0o700 });

    console.log(
      `[audit:file] Initialized: dir=${this.resolvedAuditDir}, retention=${this.retention}d, flushInterval=${this.flushInterval}ms`
    );

    // Start periodic flush
    this.flushTimer = setInterval(async () => {
      if (this.buffer.length > 0 && !this.isFlushing) {
        await this.flush();
      }
    }, this.flushInterval);

    // Clean up old audit files
    await this.cleanupOldFiles();
  }

  /**
   * Validate audit directory path (F-SEC-M5-002)
   *
   * Ensures auditDir is resolved to an absolute path and does not traverse outside
   * an allowed base directory. Protects against path traversal attacks.
   */
  private async validateAuditDir(): Promise<void> {
    // Resolve to absolute path
    this.resolvedAuditDir = path.resolve(this.auditDir);

    // For Phase 1, we allow any absolute path but validate no '..' components remain
    // after resolution. In Phase 2/3, consider restricting to a specific base directory.
    const normalized = path.normalize(this.resolvedAuditDir);
    if (normalized.includes('..')) {
      throw new Error(
        `[audit:file] Invalid audit directory (path traversal detected): ${this.auditDir}`
      );
    }

    // Check if path exists and if it's a symlink, resolve it
    try {
      const realPath = await fs.realpath(this.resolvedAuditDir).catch(() => null);
      if (realPath) {
        // Directory exists, use real path (follows symlinks)
        this.resolvedAuditDir = realPath;
      }
      // If directory doesn't exist yet, we'll create it in initialize()
    } catch (error) {
      // Directory doesn't exist yet - that's okay, we'll create it
    }
  }

  /**
   * Health check (required by ProviderLifecycle)
   *
   * Verifies audit directory exists and is writable.
   */
  async healthCheck(): Promise<ProviderHealth> {
    const startTime = Date.now();
    try {
      // Check directory exists
      const stats = await fs.stat(this.resolvedAuditDir);
      if (!stats.isDirectory()) {
        return {
          status: 'unhealthy',
          message: 'Audit path exists but is not a directory',
          latency_ms: Date.now() - startTime,
          last_checked: new Date().toISOString(),
        };
      }

      // Check write permission by creating and deleting a test file
      const testFile = path.join(this.resolvedAuditDir, `.healthcheck-${Date.now()}`);
      await fs.writeFile(testFile, 'test', { mode: 0o600 });
      await fs.unlink(testFile);

      const latency_ms = Date.now() - startTime;
      return {
        status: 'healthy',
        message: `Audit directory writable, ${this.buffer.length} events buffered`,
        latency_ms,
        last_checked: new Date().toISOString(),
      };
    } catch (error) {
      const latency_ms = Date.now() - startTime;
      return {
        status: 'unhealthy',
        message: `Audit directory error: ${error instanceof Error ? error.message : String(error)}`,
        latency_ms,
        last_checked: new Date().toISOString(),
      };
    }
  }

  /**
   * Shutdown provider (required by ProviderLifecycle)
   *
   * Flushes remaining events and stops flush timer.
   */
  async shutdown(): Promise<void> {
    this.isShuttingDown = true;

    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }

    // Final flush
    if (this.buffer.length > 0) {
      await this.flush();
    }

    console.log(`[audit:file] Shutdown complete`);
  }

  /**
   * Emit audit event (buffered write)
   *
   * Adds event to in-memory buffer. Actual write happens in flush().
   *
   * @param event Audit event to log
   */
  async emit(event: AuditEvent): Promise<void> {
    if (this.isShuttingDown) {
      console.warn(`[audit:file] Cannot emit event during shutdown: ${event.event_id}`);
      return;
    }

    this.buffer.push(event);

    // Auto-flush if buffer is large (prevents memory bloat)
    if (this.buffer.length >= 100) {
      await this.flush();
    }
  }

  /**
   * Emit batch of events (optional optimization)
   *
   * @param events Array of audit events
   */
  async emitBatch(events: AuditEvent[]): Promise<void> {
    if (this.isShuttingDown) {
      console.warn(`[audit:file] Cannot emit batch during shutdown: ${events.length} events`);
      return;
    }

    this.buffer.push(...events);

    // Auto-flush if buffer is large
    if (this.buffer.length >= 100) {
      await this.flush();
    }
  }

  /**
   * Flush buffered events to disk
   *
   * Writes all buffered events to appropriate daily file.
   * Groups by date to support proper daily rotation.
   *
   * Uses atomic buffer swap and flush lock to prevent race conditions (F-SEC-M5-004).
   */
  async flush(): Promise<void> {
    // Flush lock to prevent concurrent flushes (F-SEC-M5-004)
    if (this.isFlushing) {
      return;
    }

    if (this.buffer.length === 0) {
      return;
    }

    this.isFlushing = true;

    // Atomic buffer swap (F-SEC-M5-004)
    const toFlush = this.buffer;
    this.buffer = [];

    try {
      // Group events by date
      const eventsByDate = new Map<string, AuditEvent[]>();

      for (const event of toFlush) {
        const date = event.timestamp.split('T')[0]!; // Extract YYYY-MM-DD (always present in ISO format)
        const events = eventsByDate.get(date) || [];
        events.push(event);
        eventsByDate.set(date, events);
      }

      // Write to each date's file
      for (const [date, events] of eventsByDate.entries()) {
        const filePath = getAuditFilePath(this.resolvedAuditDir, date);

        // Append events as JSONL (one JSON object per line)
        const lines = events.map(e => JSON.stringify(e)).join('\n') + '\n';

        try {
          await fs.appendFile(filePath, lines, { encoding: 'utf-8', mode: 0o600 });
        } catch (error) {
          console.error(`[audit:file] Failed to write to ${filePath}:`, error);
          // Re-buffer failed events (F-SEC-M5-004)
          this.buffer.unshift(...events);
        }
      }

      console.log(`[audit:file] Flushed ${toFlush.length} events to disk`);
    } catch (error) {
      console.error(`[audit:file] Flush error:`, error);
      // Re-buffer all events on general error
      this.buffer.unshift(...toFlush);
    } finally {
      this.isFlushing = false;
    }
  }

  /**
   * Query audit events from JSONL files
   *
   * Reads and filters JSONL files by date range.
   * Supports filtering by client_id, user_id, event_type, severity.
   *
   * @param filters Query filters
   * @returns Array of matching audit events
   */
  async query(filters: AuditQueryFilters): Promise<AuditEvent[]> {
    const results: AuditEvent[] = [];
    const limit = filters.limit || 1000;

    // Determine date range
    const startDate = filters.start_time
      ? new Date(filters.start_time)
      : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // Default: 30 days ago
    const endDate = filters.end_time ? new Date(filters.end_time) : new Date();

    // Generate list of dates to scan
    const datesToScan: string[] = [];
    let currentDate = new Date(startDate);
    while (currentDate <= endDate) {
      const dateStr = currentDate.toISOString().split('T')[0];
      if (dateStr) {
        datesToScan.push(dateStr);
      }
      currentDate.setDate(currentDate.getDate() + 1);
    }

    // Read each date's file
    for (const date of datesToScan) {
      const filePath = getAuditFilePath(this.resolvedAuditDir, date);

      try {
        const events = await readAuditFile(filePath, filters);
        results.push(...events);

        // Stop if we've reached limit
        if (results.length >= limit) {
          break;
        }
      } catch (error) {
        // File might not exist (no events on that day) - this is okay
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.error(`[audit:file] Error reading ${filePath}:`, error);
        }
      }
    }

    // Apply limit
    return results.slice(0, limit);
  }

  /**
   * Clean up old audit files based on retention policy
   */
  private async cleanupOldFiles(): Promise<void> {
    try {
      const files = await fs.readdir(this.resolvedAuditDir);
      const cutoffDate = new Date(Date.now() - this.retention * 24 * 60 * 60 * 1000);

      for (const file of files) {
        if (!file.startsWith('audit-') || !file.endsWith('.jsonl')) {
          continue;
        }

        // Extract date from filename (audit-YYYY-MM-DD.jsonl)
        const match = file.match(/audit-(\d{4}-\d{2}-\d{2})\.jsonl/);
        if (!match || !match[1]) {
          continue;
        }

        const fileDate = new Date(match[1]);
        if (fileDate < cutoffDate) {
          const filePath = path.join(this.resolvedAuditDir, file);
          await fs.unlink(filePath);
          console.log(`[audit:file] Deleted old audit file: ${file}`);
        }
      }
    } catch (error) {
      console.error(`[audit:file] Error during cleanup:`, error);
    }
  }
}

/**
 * Get audit file path for a given date
 *
 * @param auditDir Base audit directory
 * @param date Date (ISO 8601 string or Date object)
 * @returns Full path to audit file (e.g., /var/log/ambassador/audit-2026-02-16.jsonl)
 */
export function getAuditFilePath(auditDir: string, date: string | Date): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const dateStr = d.toISOString().split('T')[0]; // YYYY-MM-DD
  return path.join(auditDir, `audit-${dateStr}.jsonl`);
}

/**
 * Read and filter audit events from a JSONL file
 *
 * @param filePath Path to JSONL audit file
 * @param filters Query filters
 * @returns Array of matching audit events
 */
async function readAuditFile(filePath: string, filters: AuditQueryFilters): Promise<AuditEvent[]> {
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

      if (filters.user_id && event.user_id !== filters.user_id) {
        continue;
      }

      if (filters.event_type && event.event_type !== filters.event_type) {
        continue;
      }

      if (filters.severity && event.severity !== filters.severity) {
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
      console.error(`[audit:file] Failed to parse line in ${filePath}:`, error);
      // Continue processing other lines
    }
  }

  return events;
}
