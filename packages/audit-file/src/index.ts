/**
 * @mcpambassador/audit-file
 *
 * File-based Audit Provider (Phase 1)
 *
 * Writes audit events to a single `audit.jsonl` (the "current" file).
 * At the start of each new UTC day, the current file is renamed to
 * `audit-YYYY-MM-DD.jsonl` and a fresh `audit.jsonl` is started.
 * Files older than the configured retention period are deleted.
 *
 * @see Architecture §5.3 AuditProvider
 * @see Architecture §11 Audit Deep Dive
 */

/* eslint-disable @typescript-eslint/no-misused-promises, prefer-const, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any */

import type { AuditProvider, AuditQueryFilters, ProviderHealth } from '@mcpambassador/core';
import { logger } from '@mcpambassador/core';
import type { AuditEvent } from '@mcpambassador/protocol';
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import path from 'path';
import { createInterface } from 'readline';

/** Name of the active (current-day) audit log file. */
const CURRENT_AUDIT_FILE = 'audit.jsonl';

/**
 * File-based Audit Provider
 *
 * Appends audit events to a single active JSONL file (`audit.jsonl`).
 * At each UTC day boundary the active file is renamed to a date-stamped
 * archive (`audit-YYYY-MM-DD.jsonl`) and a fresh `audit.jsonl` is opened.
 * Archives older than `retention` days are deleted on rotation and startup.
 *
 * Configuration:
 * - auditDir: Directory to store audit files (default: ./audit-logs)
 * - retention: Number of days to retain rotated archive files (default: 90)
 * - flushInterval: Milliseconds between auto-flushes (default: 5000)
 * - maxBufferSize: Maximum number of events held in memory (default: 1000)
 */
export class FileAuditProvider implements AuditProvider {
  readonly id = 'file_jsonl';

  private auditDir: string;
  private resolvedAuditDir: string = ''; // Validated absolute path
  private retention: number = 90; // days
  private flushInterval: number = 5000; // ms
  private maxBufferSize: number = 1000; // events
  private buffer: AuditEvent[] = [];
  private flushTimer?: NodeJS.Timeout;
  private isShuttingDown = false;
  private isFlushing = false; // Flush lock to prevent concurrent flushes (F-SEC-M5-004)

  /**
   * Cached UTC date string (YYYY-MM-DD) for the last written event.
   * Compared cheaply on every flush to detect day rollover without stat() calls.
   */
  private currentDateStr: string = '';

  constructor(config?: {
    auditDir?: string;
    retention?: number;
    flushInterval?: number;
    maxBufferSize?: number;
  }) {
    this.auditDir = config?.auditDir || './audit-logs';
    if (config?.retention !== undefined) {
      this.retention = config.retention;
    }
    if (config?.flushInterval !== undefined) {
      this.flushInterval = config.flushInterval;
    }
    if (config?.maxBufferSize !== undefined) {
      this.maxBufferSize = config.maxBufferSize;
    }
  }

  /**
   * Initialize provider (required by ProviderLifecycle)
   *
   * Creates audit directory, cleans up stale archive files, and starts
   * the periodic flush timer.
   */
  async initialize(_config: Record<string, unknown>): Promise<void> {
    // Validate and resolve audit directory path (F-SEC-M5-002)
    await this.validateAuditDir();

    // Ensure audit directory exists with restricted permissions
    await fs.mkdir(this.resolvedAuditDir, { recursive: true, mode: 0o700 });

    // Seed the cached date from the current wall clock so the first flush
    // does not spuriously trigger rotation when the provider starts mid-day.
    this.currentDateStr = utcDateString(new Date());

    logger.info(
      {
        dir: this.resolvedAuditDir,
        retention_days: this.retention,
        flush_interval_ms: this.flushInterval,
        max_buffer_size: this.maxBufferSize,
      },
      '[audit:file] Initialized'
    );

    // Clean up stale rotated archive files from previous runs.
    await this.cleanupOldFiles();

    // Start periodic flush
    this.flushTimer = setInterval(async () => {
      if (this.buffer.length > 0 && !this.isFlushing) {
        await this.flush();
      }
    }, this.flushInterval);
  }

  /**
   * Validate audit directory path (F-SEC-M5-002)
   *
   * Ensures auditDir is resolved to an absolute path and does not traverse
   * outside an allowed base directory. Protects against path traversal attacks.
   */
  private async validateAuditDir(): Promise<void> {
    // Resolve to absolute path
    this.resolvedAuditDir = path.resolve(this.auditDir);

    // For Phase 1, we allow any absolute path but validate no '..' components
    // remain after resolution. In Phase 2/3, consider restricting to a specific
    // base directory.
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

    logger.info('[audit:file] Shutdown complete');
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
      logger.warn({ event_id: event.event_id }, '[audit:file] Cannot emit event during shutdown');
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
      logger.warn({ event_count: events.length }, '[audit:file] Cannot emit batch during shutdown');
      return;
    }

    this.buffer.push(...events);

    // Auto-flush if buffer is large
    if (this.buffer.length >= 100) {
      await this.flush();
    }
  }

  /**
   * Enforce maximum buffer size by dropping oldest events
   *
   * When the buffer exceeds maxBufferSize, removes oldest events
   * and logs a warning with the count of dropped events.
   */
  private enforceBufferLimit(): void {
    if (this.buffer.length > this.maxBufferSize) {
      const droppedCount = this.buffer.length - this.maxBufferSize;
      this.buffer = this.buffer.slice(droppedCount);
      logger.warn(
        { dropped_count: droppedCount, max_buffer_size: this.maxBufferSize },
        '[audit:file] Buffer overflow: dropped oldest events'
      );
    }
  }

  /**
   * Rotate the active audit file if the UTC date has advanced since the last flush.
   *
   * Renames `audit.jsonl` → `audit-YYYY-MM-DD.jsonl` (using the *previous* date)
   * so the archive name matches the events it contains.  After renaming, the
   * old `currentDateStr` is updated to `todayStr` and stale archives are purged.
   *
   * This method is called once per flush — before any bytes are appended — so the
   * check is a cheap string comparison with no filesystem I/O in the common case.
   *
   * @param todayStr UTC date string for the current flush (YYYY-MM-DD)
   */
  private async rotateIfNeeded(todayStr: string): Promise<void> {
    // Common path: same day — nothing to do.
    if (this.currentDateStr === '' || this.currentDateStr === todayStr) {
      return;
    }

    const previousDateStr = this.currentDateStr;
    const currentFilePath = path.join(this.resolvedAuditDir, CURRENT_AUDIT_FILE);
    const archivePath = path.join(this.resolvedAuditDir, `audit-${previousDateStr}.jsonl`);

    // Only rotate if the active file exists (it may not on first run).
    try {
      await fs.access(currentFilePath);
    } catch {
      // No current file — nothing to rotate, just advance the date.
      this.currentDateStr = todayStr;
      return;
    }

    try {
      await fs.rename(currentFilePath, archivePath);
      logger.info(
        { previous_date: previousDateStr, archive: archivePath },
        '[audit:file] Rotated audit log'
      );
    } catch (error) {
      logger.error(
        { error, current_file: currentFilePath, archive: archivePath },
        '[audit:file] Failed to rotate audit log'
      );
      // Do not update currentDateStr — next flush will retry the rotation.
      return;
    }

    // Advance the cached date only after a successful rename.
    this.currentDateStr = todayStr;

    // Purge archives that exceed the retention window.
    await this.cleanupOldFiles();
  }

  /**
   * Flush buffered events to disk
   *
   * Writes all buffered events to `audit.jsonl` (the active log file).
   * Before writing, checks whether the UTC date has changed since the last
   * flush; if so, the existing file is rotated to a date-stamped archive.
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
      const todayStr = utcDateString(new Date());

      // Rotate the log file if the UTC date has advanced.
      await this.rotateIfNeeded(todayStr);

      // All events in this flush go to the single active file.
      const filePath = path.join(this.resolvedAuditDir, CURRENT_AUDIT_FILE);
      const lines = toFlush.map(e => JSON.stringify(e)).join('\n') + '\n';

      try {
        await fs.appendFile(filePath, lines, { encoding: 'utf-8', mode: 0o600 });
      } catch (error) {
        logger.error({ file_path: filePath, error }, '[audit:file] Failed to write to file');
        // Re-buffer failed events (F-SEC-M5-004)
        this.buffer.unshift(...toFlush);
        this.enforceBufferLimit();
        return;
      }

      logger.info({ event_count: toFlush.length }, '[audit:file] Flushed events to disk');
    } catch (error) {
      logger.error({ error }, '[audit:file] Flush error');
      // Re-buffer all events on general error
      this.buffer.unshift(...toFlush);
      this.enforceBufferLimit();
    } finally {
      this.isFlushing = false;
    }
  }

  /**
   * Query audit events from JSONL files
   *
   * Reads the active `audit.jsonl` plus any date-stamped archive files that
   * fall within the requested date range.
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

    // Generate list of archive dates to scan (all but today — today is audit.jsonl)
    const today = utcDateString(new Date());
    const datesToScan: string[] = [];
    let currentDate = new Date(startDate);
    while (currentDate <= endDate) {
      const dateStr = utcDateString(currentDate);
      if (dateStr && dateStr !== today) {
        datesToScan.push(dateStr);
      }
      currentDate.setUTCDate(currentDate.getUTCDate() + 1);
    }

    // Read each archive date file
    for (const date of datesToScan) {
      const filePath = path.join(this.resolvedAuditDir, `audit-${date}.jsonl`);

      try {
        const events = await readAuditFile(filePath, filters);
        results.push(...events);

        if (results.length >= limit) {
          break;
        }
      } catch (error) {
        // File might not exist (no events on that day) — this is okay
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          logger.error({ file_path: filePath, error }, '[audit:file] Error reading file');
        }
      }
    }

    // Also read the active file if the date range could include today and limit not yet reached.
    // The active file always uses the current wall-clock date, so include it whenever endDate
    // is on or after the start of today (UTC). readAuditFile will apply timestamp filters, so
    // events outside the requested range are naturally excluded.
    if (results.length < limit) {
      const startOfToday = new Date(today); // YYYY-MM-DDT00:00:00.000Z
      if (endDate >= startOfToday) {
        const activeFilePath = path.join(this.resolvedAuditDir, CURRENT_AUDIT_FILE);
        try {
          const events = await readAuditFile(activeFilePath, filters);
          results.push(...events);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            logger.error(
              { file_path: activeFilePath, error },
              '[audit:file] Error reading active file'
            );
          }
        }
      }
    }

    // Apply limit
    return results.slice(0, limit);
  }

  /**
   * Delete rotated archive files that fall outside the retention window.
   *
   * Only touches files matching the `audit-YYYY-MM-DD.jsonl` pattern —
   * the active `audit.jsonl` is never deleted here.
   *
   * Deletion is logged at debug level (high-frequency operational detail).
   */
  private async cleanupOldFiles(): Promise<void> {
    try {
      const files = await fs.readdir(this.resolvedAuditDir);
      const cutoffDate = new Date(Date.now() - this.retention * 24 * 60 * 60 * 1000);
      let deletedCount = 0;

      for (const file of files) {
        // Only consider rotated archive files, not the active audit.jsonl
        const match = file.match(/^audit-(\d{4}-\d{2}-\d{2})\.jsonl$/);
        if (!match || !match[1]) {
          continue;
        }

        const fileDate = new Date(match[1]);
        if (fileDate < cutoffDate) {
          const filePath = path.join(this.resolvedAuditDir, file);
          try {
            await fs.unlink(filePath);
            deletedCount++;
            logger.debug({ file }, '[audit:file] Deleted expired archive');
          } catch (unlinkError) {
            logger.error({ file, error: unlinkError }, '[audit:file] Failed to delete archive');
          }
        }
      }

      if (deletedCount > 0) {
        logger.debug(
          { deleted_count: deletedCount, retention_days: this.retention },
          '[audit:file] Retention cleanup complete'
        );
      }
    } catch (error) {
      logger.error({ error }, '[audit:file] Error during cleanup');
    }
  }
}

// ===== Helpers =====

/**
 * Return the UTC date string (YYYY-MM-DD) for the given Date object.
 *
 * @param date Date to format
 * @returns UTC date string, e.g. "2026-04-19"
 */
export function utcDateString(date: Date): string {
  return date.toISOString().split('T')[0]!;
}

/**
 * Get the path to a rotated archive file for a given date.
 *
 * Used in tests and external tooling. The active log is always `audit.jsonl`;
 * this function returns the name of the archive produced after rotation.
 *
 * @param auditDir Base audit directory
 * @param date Date string (YYYY-MM-DD) or Date object
 * @returns Full path to the rotated archive file
 */
export function getAuditFilePath(auditDir: string, date: string | Date): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const dateStr = utcDateString(d);
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
      logger.error({ file_path: filePath, error }, '[audit:file] Failed to parse line');
      // Continue processing other lines
    }
  }

  return events;
}
