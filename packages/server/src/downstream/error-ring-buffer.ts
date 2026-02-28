/**
 * Error Ring Buffer
 *
 * M33.1: Circular buffer for capturing MCP connection errors, stderr output, and failure reasons.
 * Simple array-based implementation with fixed capacity.
 */

export interface ErrorLogEntry {
  timestamp: string; // ISO 8601
  message: string;
  level: 'error' | 'warn' | 'info';
}

/**
 * Circular buffer for error/stderr logging
 * Keeps last N entries, oldest entries are dropped when buffer is full
 */
export class ErrorRingBuffer {
  private entries: ErrorLogEntry[] = [];
  private readonly maxSize: number;

  constructor(maxSize = 50) {
    this.maxSize = maxSize;
  }

  /**
   * Add an entry to the buffer
   * If buffer is full, oldest entry is removed
   */
  push(message: string, level: ErrorLogEntry['level'] = 'error'): void {
    const entry: ErrorLogEntry = {
      timestamp: new Date().toISOString(),
      message,
      level,
    };

    this.entries.push(entry);

    // Trim to max size (remove oldest entries)
    if (this.entries.length > this.maxSize) {
      this.entries = this.entries.slice(-this.maxSize);
    }
  }

  /**
   * Get all entries in chronological order (oldest first)
   */
  getAll(): ErrorLogEntry[] {
    return [...this.entries];
  }

  /**
   * Get the most recent entry, or null if buffer is empty
   */
  getLast(): ErrorLogEntry | null {
    if (this.entries.length === 0) {
      return null;
    }
    return this.entries[this.entries.length - 1] ?? null;
  }

  /**
   * Get the N most recent entries
   */
  getRecent(count: number): ErrorLogEntry[] {
    return this.entries.slice(-count);
  }

  /**
   * Get total number of entries in buffer
   */
  getCount(): number {
    return this.entries.length;
  }

  /**
   * Clear all entries
   */
  clear(): void {
    this.entries = [];
  }
}
