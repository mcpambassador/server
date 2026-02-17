/**
 * Audit buffer tests
 *
 * Tests ring buffer overflow, spill to disk, flush behavior.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { AuditBuffer } from '../src/audit/buffer.js';
import type { AuditEvent } from '@mcpambassador/protocol';

describe('AuditBuffer', () => {
  let tempDir: string;
  let spillPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'audit-buffer-test-'));
    spillPath = path.join(tempDir, 'spill.jsonl');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function createMockEvent(id: string): AuditEvent {
    return {
      event_id: id,
      timestamp: new Date().toISOString(),
      event_type: 'tool_invocation',
      severity: 'info',
      session_id: 'sess-123',
      client_id: 'client-456',
      auth_method: 'api_key',
      source_ip: '127.0.0.1',
      action: 'test',
    };
  }

  it('should buffer events and flush', async () => {
    const flushed: AuditEvent[] = [];
    const flushCallback = async (events: AuditEvent[]) => {
      flushed.push(...events);
    };

    const buffer = new AuditBuffer(
      {
        size: 100,
        flush_interval_ms: 100,
        spill_to_disk: false,
      },
      flushCallback
    );

    await buffer.add(createMockEvent('event-1'));
    await buffer.add(createMockEvent('event-2'));

    await buffer.flush();

    expect(flushed).toHaveLength(2);
    expect(flushed[0]!.event_id).toBe('event-1');
    expect(flushed[1]!.event_id).toBe('event-2');

    await buffer.shutdown();
  });

  it('should drop events on overflow when spill disabled', async () => {
    const flushed: AuditEvent[] = [];
    const flushCallback = async (events: AuditEvent[]) => {
      flushed.push(...events);
    };

    const buffer = new AuditBuffer(
      {
        size: 3,
        flush_interval_ms: 1000,
        spill_to_disk: false,
      },
      flushCallback
    );

    await buffer.add(createMockEvent('event-1'));
    await buffer.add(createMockEvent('event-2'));
    await buffer.add(createMockEvent('event-3'));
    await buffer.add(createMockEvent('event-4')); // Should drop event-1

    const stats = buffer.getStats();
    expect(stats.total_received).toBe(4);
    expect(stats.total_dropped).toBe(1);
    expect(stats.overflow_events).toBe(1);

    await buffer.shutdown();
  });

  it('should spill events to disk on overflow', async () => {
    const flushed: AuditEvent[] = [];
    const flushCallback = async (events: AuditEvent[]) => {
      flushed.push(...events);
    };

    const buffer = new AuditBuffer(
      {
        size: 3,
        flush_interval_ms: 1000,
        spill_to_disk: true,
        spill_path: spillPath,
      },
      flushCallback
    );

    await buffer.add(createMockEvent('event-1'));
    await buffer.add(createMockEvent('event-2'));
    await buffer.add(createMockEvent('event-3'));
    await buffer.add(createMockEvent('event-4')); // Should spill event-1

    const stats = buffer.getStats();
    expect(stats.total_received).toBe(4);
    expect(stats.total_spilled).toBe(1);
    expect(stats.overflow_events).toBe(1);

    // Verify spill file exists
    const spillContent = await fs.readFile(spillPath, 'utf-8');
    expect(spillContent).toContain('event-1');

    await buffer.shutdown();
  });

  it('should auto-flush on interval', async () => {
    vi.useFakeTimers();

    const flushed: AuditEvent[] = [];
    const flushCallback = async (events: AuditEvent[]) => {
      flushed.push(...events);
    };

    const buffer = new AuditBuffer(
      {
        size: 100,
        flush_interval_ms: 100,
        spill_to_disk: false,
      },
      flushCallback
    );

    buffer.start();

    await buffer.add(createMockEvent('event-1'));
    await buffer.add(createMockEvent('event-2'));

    // Fast-forward time
    vi.advanceTimersByTime(100);

    // Wait for flush
    await vi.runAllTimersAsync();

    expect(flushed.length).toBeGreaterThan(0);

    await buffer.shutdown();
    vi.useRealTimers();
  });

  it('should re-buffer events if flush fails', async () => {
    let failFlush = true;
    const flushCallback = async (events: AuditEvent[]) => {
      if (failFlush) {
        throw new Error('Flush failed');
      }
    };

    const buffer = new AuditBuffer(
      {
        size: 100,
        flush_interval_ms: 1000,
        spill_to_disk: false,
      },
      flushCallback
    );

    await buffer.add(createMockEvent('event-1'));

    // First flush should fail
    await expect(buffer.flush()).rejects.toThrow('Flush failed');

    // Events should still be in buffer
    const stats = buffer.getStats();
    expect(stats.current_size).toBe(1);

    // Second flush should succeed
    failFlush = false;
    await buffer.flush();
    expect(buffer.getStats().current_size).toBe(0);

    await buffer.shutdown();
  });

  it('should track statistics correctly', async () => {
    const flushed: AuditEvent[] = [];
    const flushCallback = async (events: AuditEvent[]) => {
      flushed.push(...events);
    };

    const buffer = new AuditBuffer(
      {
        size: 100,
        flush_interval_ms: 1000,
        spill_to_disk: false,
      },
      flushCallback
    );

    await buffer.add(createMockEvent('event-1'));
    await buffer.add(createMockEvent('event-2'));
    await buffer.add(createMockEvent('event-3'));

    let stats = buffer.getStats();
    expect(stats.total_received).toBe(3);
    expect(stats.current_size).toBe(3);

    await buffer.flush();

    stats = buffer.getStats();
    expect(stats.total_flushed).toBe(3);
    expect(stats.current_size).toBe(0);

    await buffer.shutdown();
  });
});
