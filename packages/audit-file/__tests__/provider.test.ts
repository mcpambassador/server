/**
 * FileAuditProvider Tests
 *
 * Tests audit logging including:
 * - Event buffering and flushing to audit.jsonl
 * - Daily log rotation (audit.jsonl → audit-YYYY-MM-DD.jsonl)
 * - Query filtering across active and archive files
 * - Retention policy cleanup
 * - Buffer overflow handling
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FileAuditProvider, getAuditFilePath, utcDateString } from '../src/index.js';
import type { AuditEvent } from '@mcpambassador/protocol';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Path of the active (current-day) log file inside testDir. */
function activeFile(testDir: string): string {
  return path.join(testDir, 'audit.jsonl');
}

/** Path of a date-stamped archive file inside testDir. */
function archiveFile(testDir: string, dateStr: string): string {
  return path.join(testDir, `audit-${dateStr}.jsonl`);
}

/** Minimal valid AuditEvent fixture. */
function makeEvent(id: string, timestamp: string, overrides?: Partial<AuditEvent>): AuditEvent {
  return {
    event_id: id,
    timestamp,
    event_type: 'tool_invocation',
    severity: 'info',
    action: 'test',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

describe('FileAuditProvider', () => {
  let provider: FileAuditProvider;
  let testDir: string;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `audit-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    provider = new FileAuditProvider({
      auditDir: testDir,
      retention: 7,
      flushInterval: 100,
    });

    await provider.initialize({ provider_type: 'audit', provider_id: 'file_jsonl' });
  });

  afterEach(async () => {
    await provider.shutdown();
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch (error) {
      console.warn(`Failed to clean up test directory: ${testDir}`, error);
    }
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // emit() / flush() — active file writes
  // -------------------------------------------------------------------------

  describe('emit() and flush()', () => {
    it('should write events to audit.jsonl (active file)', async () => {
      const event = makeEvent('evt-123', '2026-02-16T10:00:00.000Z', {
        client_id: 'client-123',
        tool_name: 'github.search_code',
      });

      await provider.emit(event);
      await provider.flush();

      const content = await fs.readFile(activeFile(testDir), 'utf-8');
      expect(content).toContain('"event_id":"evt-123"');
      expect(content).toContain('"tool_name":"github.search_code"');
    });

    it('should not create date-stamped files during a normal flush', async () => {
      await provider.emit(makeEvent('evt-1', new Date().toISOString()));
      await provider.flush();

      const files = await fs.readdir(testDir);
      const archives = files.filter(f => /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
      expect(archives).toHaveLength(0);
    });

    it('should auto-flush when buffer reaches 100 events', async () => {
      const ts = '2026-02-16T10:00:00.000Z';
      for (let i = 0; i < 100; i++) {
        await provider.emit(makeEvent(`evt-${i}`, ts));
      }

      // Should auto-flush without an explicit flush() call
      const content = await fs.readFile(activeFile(testDir), 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines.length).toBe(100);
    });

    it('should write all events from emitBatch() to audit.jsonl', async () => {
      const events: AuditEvent[] = [
        makeEvent('evt-1', '2026-02-16T10:00:00.000Z'),
        makeEvent('evt-2', '2026-02-16T10:00:01.000Z'),
      ];

      await provider.emitBatch(events);
      await provider.flush();

      const content = await fs.readFile(activeFile(testDir), 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines.length).toBe(2);
      expect(lines[0]).toContain('evt-1');
      expect(lines[1]).toContain('evt-2');
    });

    it('should append multiple flushes to the same active file', async () => {
      const ts = new Date().toISOString();
      await provider.emit(makeEvent('evt-1', ts));
      await provider.flush();

      await provider.emit(makeEvent('evt-2', ts));
      await provider.flush();

      const content = await fs.readFile(activeFile(testDir), 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines.length).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // Log rotation
  // -------------------------------------------------------------------------

  describe('Log rotation', () => {
    it('should rotate audit.jsonl to a date-stamped archive when the date changes', async () => {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const yesterdayStr = utcDateString(yesterday);

      // Simulate the state after yesterday's run: audit.jsonl exists with yesterday's data
      // and the provider's cached date is yesterday.
      await fs.writeFile(
        activeFile(testDir),
        JSON.stringify(makeEvent('evt-old', yesterday.toISOString())) + '\n',
        { mode: 0o600 }
      );
      (provider as any).currentDateStr = yesterdayStr;

      // Flush a today event — triggers rotation first
      await provider.emit(makeEvent('evt-today', new Date().toISOString()));
      await provider.flush();

      // Yesterday's content should now be in the date-stamped archive
      const archive = archiveFile(testDir, yesterdayStr);
      await expect(fs.access(archive)).resolves.toBeUndefined();
      const archiveContent = await fs.readFile(archive, 'utf-8');
      expect(archiveContent).toContain('evt-old');

      // The active file should contain today's event
      const activeContent = await fs.readFile(activeFile(testDir), 'utf-8');
      expect(activeContent).toContain('evt-today');

      // The cached date should be updated to today
      const todayStr = utcDateString(new Date());
      expect((provider as any).currentDateStr).toBe(todayStr);
    });

    it('should write new events to audit.jsonl after rotation', async () => {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const yesterdayStr = utcDateString(yesterday);

      // Pre-write an "old" active file
      await fs.writeFile(activeFile(testDir), '{"event_id":"old"}\n', { mode: 0o600 });
      (provider as any).currentDateStr = yesterdayStr;

      // Now flush a new event — triggers rotation then writes to fresh audit.jsonl
      await provider.emit(makeEvent('evt-new', new Date().toISOString()));
      await provider.flush();

      const content = await fs.readFile(activeFile(testDir), 'utf-8');
      expect(content).toContain('evt-new');
      expect(content).not.toContain('old');
    });

    it('should not rotate when active file does not exist', async () => {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const yesterdayStr = utcDateString(yesterday);

      // Force yesterday's date but leave no active file
      (provider as any).currentDateStr = yesterdayStr;

      // Flush a new event — no audit.jsonl to rename, should proceed without error
      await provider.emit(makeEvent('evt-1', new Date().toISOString()));
      await provider.flush();

      // No archive for yesterday created (nothing to rotate)
      await expect(fs.access(archiveFile(testDir, yesterdayStr))).rejects.toThrow();

      // Today's event is in the active file
      const content = await fs.readFile(activeFile(testDir), 'utf-8');
      expect(content).toContain('evt-1');
    });

    it('should span a rotation correctly — old events stay in archive, new in active', async () => {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const yesterdayStr = utcDateString(yesterday);

      // Simulate yesterday's accumulated events
      await fs.writeFile(activeFile(testDir), '{"event_id":"day-1-evt"}\n', { mode: 0o600 });
      (provider as any).currentDateStr = yesterdayStr;

      // Emit a today event — causes rotation
      await provider.emit(makeEvent('day-2-evt', new Date().toISOString()));
      await provider.flush();

      const archiveContent = await fs.readFile(archiveFile(testDir, yesterdayStr), 'utf-8');
      expect(archiveContent).toContain('day-1-evt');

      const activeContent = await fs.readFile(activeFile(testDir), 'utf-8');
      expect(activeContent).toContain('day-2-evt');
      expect(activeContent).not.toContain('day-1-evt');
    });
  });

  // -------------------------------------------------------------------------
  // getAuditFilePath helper
  // -------------------------------------------------------------------------

  describe('getAuditFilePath()', () => {
    it('should return correct archive path for ISO timestamp string', () => {
      const filePath = getAuditFilePath('/var/log/audit', '2026-02-16T10:00:00.000Z');
      expect(filePath).toBe('/var/log/audit/audit-2026-02-16.jsonl');
    });

    it('should accept Date objects', () => {
      const date = new Date('2026-02-16T10:00:00.000Z');
      const filePath = getAuditFilePath('/var/log/audit', date);
      expect(filePath).toBe('/var/log/audit/audit-2026-02-16.jsonl');
    });
  });

  // -------------------------------------------------------------------------
  // Retention policy
  // -------------------------------------------------------------------------

  describe('Retention policy', () => {
    it('should delete archive files older than retention on startup', async () => {
      // Create an 8-day-old archive (beyond 7-day retention)
      const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      const oldDateStr = utcDateString(oldDate);
      const oldFilePath = archiveFile(testDir, oldDateStr);
      await fs.writeFile(oldFilePath, '{"event_id":"old-event"}\n');

      // Create a recent archive (1 day old, within retention)
      const recentDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
      const recentDateStr = utcDateString(recentDate);
      const recentFilePath = archiveFile(testDir, recentDateStr);
      await fs.writeFile(recentFilePath, '{"event_id":"recent-event"}\n');

      // Reinitialize to trigger startup cleanup
      await provider.shutdown();
      provider = new FileAuditProvider({ auditDir: testDir, retention: 7 });
      await provider.initialize({ provider_type: 'audit', provider_id: 'file_jsonl' });

      // Old archive should be gone
      await expect(fs.access(oldFilePath)).rejects.toThrow();

      // Recent archive should survive
      await expect(fs.access(recentFilePath)).resolves.toBeUndefined();
    });

    it('should never delete the active audit.jsonl during cleanup', async () => {
      // Write something to the active file
      await fs.writeFile(activeFile(testDir), '{"event_id":"active"}\n', { mode: 0o600 });

      // Reinitialize — cleanup runs but should not touch audit.jsonl
      await provider.shutdown();
      provider = new FileAuditProvider({ auditDir: testDir, retention: 0 }); // retention=0 → delete everything old
      await provider.initialize({ provider_type: 'audit', provider_id: 'file_jsonl' });

      await expect(fs.access(activeFile(testDir))).resolves.toBeUndefined();
    });

    it('should delete old archives on rotation as well as startup', async () => {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const yesterdayStr = utcDateString(yesterday);

      // Plant a stale archive that is beyond retention
      const staleDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      const staleDateStr = utcDateString(staleDate);
      const staleFilePath = archiveFile(testDir, staleDateStr);
      await fs.writeFile(staleFilePath, '{"event_id":"stale"}\n');

      // Prepare for rotation by setting yesterday's date and a current file
      await fs.writeFile(activeFile(testDir), '{"event_id":"yesterday"}\n', { mode: 0o600 });
      (provider as any).currentDateStr = yesterdayStr;

      // Flush today's event — triggers rotation and then cleanup
      await provider.emit(makeEvent('today', new Date().toISOString()));
      await provider.flush();

      // Stale archive should be cleaned up by the post-rotation cleanup
      await expect(fs.access(staleFilePath)).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // query() — active file + archives
  // -------------------------------------------------------------------------

  describe('query()', () => {
    beforeEach(async () => {
      // Write yesterday's events into an archive
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const yesterdayStr = utcDateString(yesterday);
      const event1 = makeEvent('evt-1', `${yesterdayStr}T10:00:00.000Z`, {
        client_id: 'client-123',
        event_type: 'tool_invocation',
        tool_name: 'github.search_code',
      });
      const event2 = makeEvent('evt-2', `${yesterdayStr}T11:00:00.000Z`, {
        client_id: 'client-456',
        event_type: 'auth_failure',
        severity: 'warning',
      });
      await fs.writeFile(
        archiveFile(testDir, yesterdayStr),
        [event1, event2].map(e => JSON.stringify(e)).join('\n') + '\n',
        { mode: 0o600 }
      );

      // Write today's events to the active file using the actual current time so that
      // all query end_time values (set to "now") are guaranteed to be >= this timestamp.
      const event3 = makeEvent('evt-3', new Date(Date.now() - 1000).toISOString(), {
        client_id: 'client-123',
        event_type: 'tool_invocation',
        tool_name: 'slack.post_message',
      });
      await fs.writeFile(activeFile(testDir), JSON.stringify(event3) + '\n', { mode: 0o600 });
    });

    it('should return events from both archive and active file', async () => {
      const results = await provider.query({
        start_time: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
        end_time: new Date().toISOString(),
      });

      const ids = results.map(e => e.event_id);
      expect(ids).toContain('evt-1');
      expect(ids).toContain('evt-2');
      expect(ids).toContain('evt-3');
    });

    it('should filter by client_id', async () => {
      const results = await provider.query({
        start_time: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
        end_time: new Date().toISOString(),
        client_id: 'client-123',
      });

      expect(results.length).toBe(2);
      expect(results.every(e => e.client_id === 'client-123')).toBe(true);
    });

    it('should filter by event_type', async () => {
      const results = await provider.query({
        start_time: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
        end_time: new Date(Date.now() + 60 * 1000).toISOString(),
        event_type: 'auth_failure',
      });

      expect(results.length).toBe(1);
      expect(results[0]!.event_id).toBe('evt-2');
    });

    it('should filter by severity', async () => {
      const results = await provider.query({
        start_time: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
        end_time: new Date(Date.now() + 60 * 1000).toISOString(),
        severity: 'warning',
      });

      expect(results.length).toBe(1);
      expect(results[0]!.event_id).toBe('evt-2');
    });

    it('should respect limit parameter', async () => {
      const results = await provider.query({
        start_time: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
        end_time: new Date(Date.now() + 60 * 1000).toISOString(),
        limit: 2,
      });

      expect(results.length).toBe(2);
    });

    it('should return empty array for date range with no events', async () => {
      const results = await provider.query({
        start_time: '2020-01-01T00:00:00.000Z',
        end_time: '2020-01-02T00:00:00.000Z',
      });

      expect(results.length).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Buffer size limits
  // -------------------------------------------------------------------------

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
          await defaultProvider.emit(makeEvent(`evt-${i}`, '2026-02-16T10:00:00.000Z'));
        }

        // Attempt flush (should fail due to read-only dir)
        await defaultProvider.flush();

        // Restore permissions and flush
        await fs.chmod(testDir, 0o700);
        await defaultProvider.flush();

        const content = await fs.readFile(activeFile(testDir), 'utf-8');
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
      const testProvider = new FileAuditProvider({
        auditDir: testDir,
        maxBufferSize: 10,
        flushInterval: 100,
      });

      await testProvider.initialize({ provider_type: 'audit', provider_id: 'file_jsonl' });

      await fs.chmod(testDir, 0o555);

      try {
        for (let i = 0; i < 20; i++) {
          await testProvider.emit(makeEvent(`evt-${i}`, '2026-02-16T10:00:00.000Z'));
        }

        await testProvider.flush();

        await fs.chmod(testDir, 0o700);
        await testProvider.flush();

        const content = await fs.readFile(activeFile(testDir), 'utf-8');
        const lines = content.trim().split('\n');

        // Should have 10 events (oldest 10 dropped)
        expect(lines.length).toBe(10);
        const firstEvent = JSON.parse(lines[0]!) as AuditEvent;
        expect(firstEvent.event_id).toBe('evt-10');
      } finally {
        await fs.chmod(testDir, 0o700);
        await testProvider.shutdown();
      }
    });

    it('should allow custom maxBufferSize in constructor', async () => {
      const testProvider = new FileAuditProvider({
        auditDir: testDir,
        maxBufferSize: 50,
        flushInterval: 100,
      });

      await testProvider.initialize({ provider_type: 'audit', provider_id: 'file_jsonl' });

      await fs.chmod(testDir, 0o555);

      try {
        for (let i = 0; i < 100; i++) {
          await testProvider.emit(makeEvent(`evt-${i}`, '2026-02-16T10:00:00.000Z'));
        }

        await testProvider.flush();

        await fs.chmod(testDir, 0o700);
        await testProvider.flush();

        const content = await fs.readFile(activeFile(testDir), 'utf-8');
        const lines = content.trim().split('\n');

        expect(lines.length).toBe(50);
        const firstEvent = JSON.parse(lines[0]!) as AuditEvent;
        expect(firstEvent.event_id).toBe('evt-50');
      } finally {
        await fs.chmod(testDir, 0o700);
        await testProvider.shutdown();
      }
    });

    it('should not affect normal flush behavior when disk is healthy', async () => {
      const testProvider = new FileAuditProvider({
        auditDir: testDir,
        maxBufferSize: 10,
        flushInterval: 100,
      });

      await testProvider.initialize({ provider_type: 'audit', provider_id: 'file_jsonl' });

      for (let i = 0; i < 5; i++) {
        await testProvider.emit(makeEvent(`evt-${i}`, '2026-02-16T10:00:00.000Z'));
      }

      await testProvider.flush();

      const content = await fs.readFile(activeFile(testDir), 'utf-8');
      const lines = content.trim().split('\n');

      expect(lines.length).toBe(5);
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

      await fs.chmod(testDir, 0o555);

      try {
        for (let i = 0; i < 15; i++) {
          await testProvider.emit(makeEvent(`evt-${i}`, '2026-02-16T10:00:00.000Z'));
        }

        await testProvider.flush();

        await fs.chmod(testDir, 0o700);
        await testProvider.flush();

        const content = await fs.readFile(activeFile(testDir), 'utf-8');
        const lines = content.trim().split('\n');

        expect(lines.length).toBe(10);
        const firstEvent = JSON.parse(lines[0]!) as AuditEvent;
        expect(firstEvent.event_id).toBe('evt-5');
      } finally {
        await fs.chmod(testDir, 0o700);
        await testProvider.shutdown();
      }
    });
  });

  // -------------------------------------------------------------------------
  // First-startup correctness
  // -------------------------------------------------------------------------

  describe('First startup (no existing files)', () => {
    it('should initialize cleanly with an empty audit directory', async () => {
      const freshDir = path.join(os.tmpdir(), `audit-fresh-${Date.now()}`);
      const freshProvider = new FileAuditProvider({ auditDir: freshDir, retention: 7 });

      await expect(
        freshProvider.initialize({ provider_type: 'audit', provider_id: 'file_jsonl' })
      ).resolves.toBeUndefined();

      await freshProvider.emit(makeEvent('evt-1', new Date().toISOString()));
      await freshProvider.flush();

      const content = await fs.readFile(path.join(freshDir, 'audit.jsonl'), 'utf-8');
      expect(content).toContain('evt-1');

      await freshProvider.shutdown();
      await fs.rm(freshDir, { recursive: true, force: true });
    });
  });

  // -------------------------------------------------------------------------
  // Startup with existing rotated archives
  // -------------------------------------------------------------------------

  describe('Startup with existing rotated archives', () => {
    it('should clean up stale archives found from previous runs', async () => {
      const archiveDir = path.join(os.tmpdir(), `audit-archive-${Date.now()}`);
      await fs.mkdir(archiveDir, { recursive: true });

      // Plant stale archives
      const stale1 = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
      const stale2 = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
      const stale1Path = archiveFile(archiveDir, utcDateString(stale1));
      const stale2Path = archiveFile(archiveDir, utcDateString(stale2));
      await fs.writeFile(stale1Path, '{"event_id":"s1"}\n');
      await fs.writeFile(stale2Path, '{"event_id":"s2"}\n');

      // Plant a recent archive (within retention)
      const recent = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      const recentPath = archiveFile(archiveDir, utcDateString(recent));
      await fs.writeFile(recentPath, '{"event_id":"r1"}\n');

      const archiveProvider = new FileAuditProvider({ auditDir: archiveDir, retention: 7 });
      await archiveProvider.initialize({ provider_type: 'audit', provider_id: 'file_jsonl' });

      await expect(fs.access(stale1Path)).rejects.toThrow();
      await expect(fs.access(stale2Path)).rejects.toThrow();
      await expect(fs.access(recentPath)).resolves.toBeUndefined();

      await archiveProvider.shutdown();
      await fs.rm(archiveDir, { recursive: true, force: true });
    });
  });
});
