/**
 * Audit Buffer — In-Memory Ring + File Spill
 *
 * Implements buffered audit event collection with overflow protection.
 *
 * @see Architecture §11 Audit Architecture
 * @see ADR-004 Decision 5 (Audit Buffer)
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */

import fs from 'fs/promises';
import path from 'path';
import type { AuditEvent } from '@mcpambassador/protocol';
import { logger } from '../utils/logger.js';
import { AmbassadorError } from '../utils/errors.js';

/**
 * Audit buffer configuration
 */
export interface AuditBufferConfig {
  /** Ring buffer size (default: 10,000 events) */
  size: number;
  /** Flush interval in milliseconds (default: 5000ms) */
  flush_interval_ms: number;
  /** Enable spill to disk on overflow (default: true) */
  spill_to_disk: boolean;
  /** Spill file path (default: ./data/audit-spill.jsonl - F-SEC-M3-005) */
  spill_path?: string;
  /** Maximum spill file size in bytes (default: 100MB - F-SEC-M3-006) */
  max_spill_size_bytes?: number;
}

/**
 * Audit buffer statistics
 */
export interface AuditBufferStats {
  total_received: number;
  total_flushed: number;
  total_dropped: number;
  total_spilled: number;
  current_size: number;
  buffer_capacity: number;
  overflow_events: number;
}

/**
 * Flush callback type
 */
export type FlushCallback = (events: AuditEvent[]) => Promise<void>;

/**
 * In-memory ring buffer + file spill for audit events
 */
export class AuditBuffer {
  private buffer: AuditEvent[] = [];
  private config: AuditBufferConfig;
  private flushCallback: FlushCallback;

  // Statistics
  private stats: AuditBufferStats = {
    total_received: 0,
    total_flushed: 0,
    total_dropped: 0,
    total_spilled: 0,
    current_size: 0,
    buffer_capacity: 0,
    overflow_events: 0,
  };

  // Flush timer
  private flushTimer?: NodeJS.Timeout;

  // Spill file handle
  private spillFileHandle?: fs.FileHandle;
  private spillFileSize: number = 0;
  private readonly maxSpillSize: number;

  constructor(config: AuditBufferConfig, flushCallback: FlushCallback) {
    this.config = config;
    this.flushCallback = flushCallback;
    this.stats.buffer_capacity = config.size;
    this.maxSpillSize = config.max_spill_size_bytes || 100 * 1024 * 1024; // 100MB default

    logger.info(
      `[audit-buffer] Initialized with size=${config.size}, flush_interval=${config.flush_interval_ms}ms, spill=${config.spill_to_disk}, max_spill=${this.maxSpillSize}`
    );
  }

  /**
   * Start automatic flush timer
   */
  start(): void {
    if (this.flushTimer) {
      return; // Already started
    }

    this.flushTimer = setInterval(() => {
      this.flush().catch(err => {
        logger.error('[audit-buffer] Auto-flush error:', err);
      });
    }, this.config.flush_interval_ms);

    logger.info('[audit-buffer] Auto-flush started');
  }

  /**
   * Stop automatic flush timer
   */
  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
      logger.info('[audit-buffer] Auto-flush stopped');
    }
  }

  /**
   * Add event to buffer
   *
   * @param event Audit event to buffer
   */
  async add(event: AuditEvent): Promise<void> {
    this.stats.total_received++;

    // Check if buffer is full
    if (this.buffer.length >= this.config.size) {
      this.stats.overflow_events++;

      if (this.config.spill_to_disk) {
        // Spill oldest event to disk
        const oldest = this.buffer.shift();
        if (oldest) {
          await this.spillEvent(oldest);
          this.stats.total_spilled++;
        }
      } else {
        // Drop oldest event
        this.buffer.shift();
        this.stats.total_dropped++;
        logger.warn('[audit-buffer] Buffer overflow - event dropped (spill disabled)');
      }
    }

    // Add new event
    this.buffer.push(event);
    this.stats.current_size = this.buffer.length;
  }

  /**
   * Flush buffered events to callback
   */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) {
      return; // Nothing to flush
    }

    const events = this.buffer.splice(0, this.buffer.length);
    this.stats.current_size = 0;

    try {
      await this.flushCallback(events);
      this.stats.total_flushed += events.length;
      logger.debug(`[audit-buffer] Flushed ${events.length} events`);
    } catch (error) {
      // Re-add events to buffer if flush fails
      this.buffer.unshift(...events);
      this.stats.current_size = this.buffer.length;

      if (error instanceof Error) {
        throw new AmbassadorError(
          `Failed to flush audit events: ${error.message}`,
          'audit_flush_error'
        );
      }
      throw error;
    }
  }

  /**
   * Spill event to disk
   */
  private async spillEvent(event: AuditEvent): Promise<void> {
    try {
      if (!this.spillFileHandle) {
        const spillPath = this.config.spill_path || './data/audit-spill.jsonl'; // F-SEC-M3-005: not /tmp

        // Ensure directory exists
        await fs.mkdir(path.dirname(spillPath), { recursive: true });

        // Check if file exists and validate it's not a symlink (F-SEC-M3-005)
        try {
          const stats = await fs.lstat(spillPath);
          if (stats.isSymbolicLink()) {
            throw new Error('Spill file is a symlink - rejecting for security');
          }
          this.spillFileSize = stats.size;
        } catch (error: unknown) {
          // File doesn't exist yet, that's OK
          if (error && typeof error === 'object' && 'code' in error && error.code !== 'ENOENT') {
            throw error;
          }
          this.spillFileSize = 0;
        }

        // Open with restricted permissions (F-SEC-M3-004)
        this.spillFileHandle = await fs.open(spillPath, 'a', 0o600);
        logger.info(`[audit-buffer] Opened spill file: ${spillPath} (mode 0600)`);
      }

      // Check spill file size limit (F-SEC-M3-006)
      if (this.spillFileSize >= this.maxSpillSize) {
        logger.warn(
          `[audit-buffer] Spill file size limit reached (${this.maxSpillSize} bytes) - switching to drop mode`
        );
        this.stats.total_dropped++;
        return;
      }

      const line = JSON.stringify(event) + '\n';
      const bytesWritten = Buffer.byteLength(line, 'utf-8');
      await this.spillFileHandle.write(line);
      this.spillFileSize += bytesWritten;
    } catch (error) {
      logger.error('[audit-buffer] Failed to spill event to disk:', error);
      this.stats.total_dropped++;
    }
  }

  /**
   * Get buffer statistics
   */
  getStats(): AuditBufferStats {
    return { ...this.stats };
  }

  /**
   * Shutdown buffer gracefully
   */
  async shutdown(): Promise<void> {
    this.stop();
    await this.flush();

    if (this.spillFileHandle) {
      await this.spillFileHandle.close();
      this.spillFileHandle = undefined;
      logger.info('[audit-buffer] Spill file closed');
    }

    logger.info('[audit-buffer] Shutdown complete');
  }
}
