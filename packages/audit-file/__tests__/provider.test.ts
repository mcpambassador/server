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
});
