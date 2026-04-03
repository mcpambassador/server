/**
 * FileAuditProvider Tests
 *
 * Tests audit logging including:
 * - Event buffering and flushing
 * - Daily file rotation
 * - Query filtering
 * - Retention policy
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FileAuditProvider, getAuditFilePath } from '../src/index.js';
import type { AuditEvent } from '@mcpambassador/protocol';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

describe('FileAuditProvider', () => {
  let provider: FileAuditProvider;
  let testDir: string;

  beforeEach(async () => {
    // Create temporary test directory
    testDir = path.join(os.tmpdir(), `audit-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    provider = new FileAuditProvider({
      auditDir: testDir,
      retention: 7, // 7 days for testing
      flushInterval: 100, // 100ms for testing (fast flush)
    });

    await provider.initialize({ provider_type: 'audit', provider_id: 'file_jsonl' });
  });

  afterEach(async () => {
    await provider.shutdown();

    // Clean up test directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch (error) {
      console.warn(`Failed to clean up test directory: ${testDir}`, error);
    }
  });

  describe('emit() and flush()', () => {
    it('should write events to JSONL file', async () => {
      const event: AuditEvent = {
        event_id: 'evt-123',
        timestamp: '2026-02-16T10:00:00.000Z',
        event_type: 'tool_invocation',
        severity: 'info',
        session_id: 'sess-123',
        client_id: 'client-123',
        action: 'invoke_tool',
        tool_name: 'github.search_code',
      };

      await provider.emit(event);
      await provider.flush();

      // Check file exists
      const filePath = getAuditFilePath(testDir, event.timestamp);
      const content = await fs.readFile(filePath, 'utf-8');

      expect(content).toContain('"event_id":"evt-123"');
      expect(content).toContain('"tool_name":"github.search_code"');
    });

    it('should auto-flush when buffer reaches 100 events', async () => {
      // Emit 100 events
      for (let i = 0; i < 100; i++) {
        await provider.emit({
          event_id: `evt-${i}`,
          timestamp: '2026-02-16T10:00:00.000Z',
          event_type: 'tool_invocation',
          severity: 'info',
          action: 'test',
        });
      }

      // Should auto-flush without explicit flush() call
      const filePath = getAuditFilePath(testDir, '2026-02-16');
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.trim().split('\n');

      expect(lines.length).toBe(100);
    });

    it('should group events by date when flushing', async () => {
      const event1: AuditEvent = {
        event_id: 'evt-1',
        timestamp: '2026-02-16T10:00:00.000Z',
        event_type: 'tool_invocation',
        severity: 'info',
        action: 'test',
      };

      const event2: AuditEvent = {
        event_id: 'evt-2',
        timestamp: '2026-02-17T10:00:00.000Z',
        event_type: 'tool_invocation',
        severity: 'info',
        action: 'test',
      };

      await provider.emit(event1);
      await provider.emit(event2);
      await provider.flush();

      // Check both files exist
      const file1 = await fs.readFile(getAuditFilePath(testDir, '2026-02-16'), 'utf-8');
      const file2 = await fs.readFile(getAuditFilePath(testDir, '2026-02-17'), 'utf-8');

      expect(file1).toContain('evt-1');
      expect(file2).toContain('evt-2');
    });

    it('should handle emitBatch()', async () => {
      const events: AuditEvent[] = [
        {
          event_id: 'evt-1',
          timestamp: '2026-02-16T10:00:00.000Z',
          event_type: 'tool_invocation',
          severity: 'info',
          action: 'test',
        },
        {
          event_id: 'evt-2',
          timestamp: '2026-02-16T10:00:01.000Z',
          event_type: 'tool_invocation',
          severity: 'info',
          action: 'test',
        },
      ];

      await provider.emitBatch(events);
      await provider.flush();

      const filePath = getAuditFilePath(testDir, '2026-02-16');
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.trim().split('\n');

      expect(lines.length).toBe(2);
    });
  });

  describe('query()', () => {
    beforeEach(async () => {
      // Set up test data
      const events: AuditEvent[] = [
        {
          event_id: 'evt-1',
          timestamp: '2026-02-16T10:00:00.000Z',
          event_type: 'tool_invocation',
          severity: 'info',
          client_id: 'client-123',
          action: 'test',
          tool_name: 'github.search_code',
        },
        {
          event_id: 'evt-2',
          timestamp: '2026-02-16T11:00:00.000Z',
          event_type: 'auth_failure',
          severity: 'warning',
          client_id: 'client-456',
          action: 'test',
        },
        {
          event_id: 'evt-3',
          timestamp: '2026-02-17T10:00:00.000Z',
          event_type: 'tool_invocation',
          severity: 'info',
          client_id: 'client-123',
          action: 'test',
          tool_name: 'slack.post_message',
        },
      ];

      await provider.emitBatch(events);
      await provider.flush();
    });

    it('should query all events in date range', async () => {
      const results = await provider.query({
        start_time: '2026-02-16T00:00:00.000Z',
        end_time: '2026-02-18T00:00:00.000Z',
      });

      expect(results.length).toBe(3);
      expect(results.map(e => e.event_id)).toEqual(['evt-1', 'evt-2', 'evt-3']);
    });

    it('should filter by client_id', async () => {
      const results = await provider.query({
        start_time: '2026-02-16T00:00:00.000Z',
        end_time: '2026-02-18T00:00:00.000Z',
        client_id: 'client-123',
      });

      expect(results.length).toBe(2);
      expect(results.every(e => e.client_id === 'client-123')).toBe(true);
    });

    it('should filter by event_type', async () => {
      const results = await provider.query({
        start_time: '2026-02-16T00:00:00.000Z',
        end_time: '2026-02-18T00:00:00.000Z',
        event_type: 'auth_failure',
      });

      expect(results.length).toBe(1);
      expect(results[0].event_id).toBe('evt-2');
    });

    it('should filter by severity', async () => {
      const results = await provider.query({
        start_time: '2026-02-16T00:00:00.000Z',
        end_time: '2026-02-18T00:00:00.000Z',
        severity: 'warning',
      });

      expect(results.length).toBe(1);
      expect(results[0].event_id).toBe('evt-2');
    });

    it('should respect limit parameter', async () => {
      const results = await provider.query({
        start_time: '2026-02-16T00:00:00.000Z',
        end_time: '2026-02-18T00:00:00.000Z',
        limit: 2,
      });

      expect(results.length).toBe(2);
    });

    it('should handle non-existent date range', async () => {
      const results = await provider.query({
        start_time: '2026-01-01T00:00:00.000Z',
        end_time: '2026-01-02T00:00:00.000Z',
      });

      expect(results.length).toBe(0);
    });
  });

  describe('File rotation', () => {
    it('should use correct filename format', () => {
      const filePath = getAuditFilePath('/var/log/audit', '2026-02-16T10:00:00.000Z');
      expect(filePath).toBe('/var/log/audit/audit-2026-02-16.jsonl');
    });

    it('should handle Date objects', () => {
      const date = new Date('2026-02-16T10:00:00.000Z');
      const filePath = getAuditFilePath('/var/log/audit', date);
      expect(filePath).toBe('/var/log/audit/audit-2026-02-16.jsonl');
    });
  });

  describe('Retention policy', () => {
    it('should delete old audit files', async () => {
      // Create old audit file (8 days ago, beyond 7-day retention)
      const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      const oldDateStr = oldDate.toISOString().split('T')[0];
      const oldFilePath = path.join(testDir, `audit-${oldDateStr}.jsonl`);
      await fs.writeFile(oldFilePath, '{"event_id":"old-event"}\n');

      // Create recent file (1 day ago, within retention)
      const recentDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
      const recentDateStr = recentDate.toISOString().split('T')[0];
      const recentFilePath = path.join(testDir, `audit-${recentDateStr}.jsonl`);
      await fs.writeFile(recentFilePath, '{"event_id":"recent-event"}\n');

      // Reinitialize provider to trigger cleanup
      await provider.shutdown();
      provider = new FileAuditProvider({ auditDir: testDir, retention: 7 });
      await provider.initialize({ provider_type: 'audit', provider_id: 'file_jsonl' });

      // Wait for cleanup to complete
      await new Promise(resolve => setTimeout(resolve, 100));

      // Old file should be deleted
      await expect(fs.access(oldFilePath)).rejects.toThrow();

      // Recent file should still exist
      await expect(fs.access(recentFilePath)).resolves.toBeUndefined();
    });
  });

  describe('Buffer size limits', () => {
    it('should respect default maxBufferSize of 1000', async () => {
      const defaultProvider = new FileAuditProvider({
        auditDir: testDir,
        flushInterval: 10000, // Long flush interval to prevent auto-flush
      });
      await defaultProvider.initialize({ provider_type: 'audit', provider_id: 'file_jsonl' });

      // Make directory read-only to force flush failures
      await fs.chmod(testDir, 0o555);

      try {
        // Add 1001 events to exceed default max of 1000
        for (let i = 0; i < 1001; i++) {
          await defaultProvider.emit({
            event_id: `evt-${i}`,
            timestamp: '2026-02-16T10:00:00.000Z',
            event_type: 'tool_invocation',
            severity: 'info',
            action: 'test',
          });
        }

        // Attempt flush (should fail due to read-only dir)
        await defaultProvider.flush();

        // Restore permissions and flush
        await fs.chmod(testDir, 0o700);
        await defaultProvider.flush();

        const filePath = getAuditFilePath(testDir, '2026-02-16');
        const content = await fs.readFile(filePath, 'utf-8');
        const lines = content.trim().split('\n');

        // Should have 1000 events (oldest dropped)
        expect(lines.length).toBe(1000);
        // First event should be evt-1 (evt-0 was dropped)
        const firstEvent = JSON.parse(lines[0]!) as AuditEvent;
        expect(firstEvent.event_id).toBe('evt-1');
      } finally {
        await fs.chmod(testDir, 0o700);
        await defaultProvider.shutdown();
      }
    });

    it('should drop oldest events when buffer exceeds maxBufferSize during failed flush', async () => {
      // Create provider with small maxBufferSize for testing
      const testProvider = new FileAuditProvider({
        auditDir: testDir,
        maxBufferSize: 10,
        flushInterval: 100,
      });

      await testProvider.initialize({ provider_type: 'audit', provider_id: 'file_jsonl' });

      // Make the directory read-only to force flush failures
      await fs.chmod(testDir, 0o555);

      try {
        // Emit 20 events (should exceed maxBufferSize of 10)
        for (let i = 0; i < 20; i++) {
          await testProvider.emit({
            event_id: `evt-${i}`,
            timestamp: '2026-02-16T10:00:00.000Z',
            event_type: 'tool_invocation',
            severity: 'info',
            action: 'test',
          });
        }

        // Attempt flush (should fail due to read-only dir)
        await testProvider.flush();

        // Buffer should be capped at 10 due to enforceBufferLimit
        // Verify by restoring write permissions and flushing
        await fs.chmod(testDir, 0o700);
        await testProvider.flush();

        const filePath = getAuditFilePath(testDir, '2026-02-16');
        const content = await fs.readFile(filePath, 'utf-8');
        const lines = content.trim().split('\n');

        // Should have 10 events (oldest 10 dropped)
        expect(lines.length).toBe(10);
        // First event should be evt-10 (evt-0 to evt-9 were dropped)
        const firstEvent = JSON.parse(lines[0]!) as AuditEvent;
        expect(firstEvent.event_id).toBe('evt-10');
      } finally {
        // Restore write permissions for cleanup
        await fs.chmod(testDir, 0o700);
        await testProvider.shutdown();
      }
    });

    it('should allow custom maxBufferSize in constructor', async () => {
      const customProvider = new FileAuditProvider({
        auditDir: testDir,
        maxBufferSize: 50,
        flushInterval: 100,
      });

      await customProvider.initialize({ provider_type: 'audit', provider_id: 'file_jsonl' });

      // Make the directory read-only to force flush failures
      await fs.chmod(testDir, 0o555);

      try {
        // Emit 100 events (should exceed maxBufferSize of 50)
        for (let i = 0; i < 100; i++) {
          await customProvider.emit({
            event_id: `evt-${i}`,
            timestamp: '2026-02-16T10:00:00.000Z',
            event_type: 'tool_invocation',
            severity: 'info',
            action: 'test',
          });
        }

        // Attempt flush
        await customProvider.flush();

        // Restore permissions and flush
        await fs.chmod(testDir, 0o700);
        await customProvider.flush();

        const filePath = getAuditFilePath(testDir, '2026-02-16');
        const content = await fs.readFile(filePath, 'utf-8');
        const lines = content.trim().split('\n');

        // Should have 50 events
        expect(lines.length).toBe(50);
        // First event should be evt-50 (evt-0 to evt-49 were dropped)
        const firstEvent = JSON.parse(lines[0]!) as AuditEvent;
        expect(firstEvent.event_id).toBe('evt-50');
      } finally {
        await fs.chmod(testDir, 0o700);
        await customProvider.shutdown();
      }
    });

    it('should not affect normal flush behavior when disk is healthy', async () => {
      const testProvider = new FileAuditProvider({
        auditDir: testDir,
        maxBufferSize: 10,
        flushInterval: 100,
      });

      await testProvider.initialize({ provider_type: 'audit', provider_id: 'file_jsonl' });

      // Emit 5 events (below maxBufferSize)
      for (let i = 0; i < 5; i++) {
        await testProvider.emit({
          event_id: `evt-${i}`,
          timestamp: '2026-02-16T10:00:00.000Z',
          event_type: 'tool_invocation',
          severity: 'info',
          action: 'test',
        });
      }

      await testProvider.flush();

      const filePath = getAuditFilePath(testDir, '2026-02-16');
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.trim().split('\n');

      // Should have all 5 events
      expect(lines.length).toBe(5);
      // All events should be present
      expect(lines[0]).toContain('evt-0');
      expect(lines[4]).toContain('evt-4');

      await testProvider.shutdown();
    });

    it('should drop only excess events, not all', async () => {
      const testProvider = new FileAuditProvider({
        auditDir: testDir,
        maxBufferSize: 10,
        flushInterval: 100,
      });

      await testProvider.initialize({ provider_type: 'audit', provider_id: 'file_jsonl' });

      // Make directory read-only to force failure
      await fs.chmod(testDir, 0o555);

      try {
        // Emit 15 events (5 over limit of 10)
        for (let i = 0; i < 15; i++) {
          await testProvider.emit({
            event_id: `evt-${i}`,
            timestamp: '2026-02-16T10:00:00.000Z',
            event_type: 'tool_invocation',
            severity: 'info',
            action: 'test',
          });
        }

        // Attempt flush
        await testProvider.flush();

        // Restore permissions and flush
        await fs.chmod(testDir, 0o700);
        await testProvider.flush();

        const filePath = getAuditFilePath(testDir, '2026-02-16');
        const content = await fs.readFile(filePath, 'utf-8');
        const lines = content.trim().split('\n');

        // Should have 10 events (exactly at limit)
        expect(lines.length).toBe(10);
        // First remaining event should be evt-5 (evt-0 to evt-4 were dropped)
        const firstEvent = JSON.parse(lines[0]!) as AuditEvent;
        expect(firstEvent.event_id).toBe('evt-5');
      } finally {
        await fs.chmod(testDir, 0o700);
        await testProvider.shutdown();
      }
    });
  });
});
