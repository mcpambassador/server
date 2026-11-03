/**
 * TD-070: revoke must also cover a scope pin that is being created concurrently.
 * The in-flight observe has passed its revoked-hash check but has not inserted its row yet, so
 * revoke cannot find the pin to lock; the mcp-wide lock makes revoke wait for it instead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const gate = vi.hoisted(() => ({
  armed: false,
  u2: '' as string,
  reached: undefined as undefined | (() => void),
  release: undefined as undefined | Promise<void>,
}));

vi.mock('@mcpambassador/core', async importOriginal => {
  const orig = await importOriginal<typeof import('@mcpambassador/core')>();
  return {
    ...orig,
    insertToolPin: async (...a: Parameters<typeof orig.insertToolPin>) => {
      if (gate.armed && a[1].scope_user_id === gate.u2) {
        gate.armed = false;
        gate.reached?.();
        await gate.release;
      }
      return orig.insertToolPin(...a);
    },
  };
});

import {
  closeDatabase,
  createMcpEntry,
  initializeDatabase,
  runMigrations,
  type DatabaseClient,
} from '@mcpambassador/core';
import { createUser } from '../../src/auth/user-auth.js';
import { key as scopeLockKey, mcpWideKey } from '../../src/services/tool-pins/pin-service.js';
import { ToolPinService } from '../../src/services/tool-pins/pin-service.js';

const def = (description: string) => [
  { name: 'search', description, inputSchema: { type: 'object' } },
];

describe('revoke vs concurrent scope pin creation (TD-070)', () => {
  let dir: string;
  let db: DatabaseClient;
  let pins: ToolPinService;
  let mcpId: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amb-td070-'));
    db = await initializeDatabase({ type: 'sqlite', sqliteFilePath: path.join(dir, 'a.db') });
    await runMigrations(db);
    pins = new ToolPinService(db, () => undefined);
    await pins.load();
    mcpId = (
      await createMcpEntry(db, {
        name: 'm1',
        display_name: 'm1',
        transport_type: 'stdio',
        isolation_mode: 'shared',
        origin: 'custom',
      } as never)
    ).mcp_id;
  });
  afterEach(async () => {
    gate.armed = false;
    await closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a scope pin created while revoke is queued is revoked too', async () => {
    const u1Id = (
      await createUser(db, { username: 'u1', password: 'pass1234', display_name: 'u1' })
    ).user_id;
    const u2Id = (
      await createUser(db, { username: 'u2', password: 'pass1234', display_name: 'u2' })
    ).user_id;
    gate.u2 = u2Id;
    // shared pin approved at v0; u1 has its own approved v1 (the pin we revoke)
    await pins.observe({ mcpId, scopeUserId: null, liveTools: def('v0'), policy: 'auto' });
    await pins.observe({ mcpId, scopeUserId: u1Id, liveTools: def('v1'), policy: 'auto' });
    const u1 = pins.getPin(mcpId, u1Id, 'search')!;
    const hash = u1.approved_hash!;

    // u2 observes the same v1: it passes its revoked-hash check, then stalls just before inserting
    // its approved row. At this moment revoke cannot see a u2 pin to lock.
    let release!: () => void;
    gate.release = new Promise<void>(r => (release = r));
    const reached = new Promise<void>(r => (gate.reached = r));
    gate.armed = true;
    const u2Observe = pins.observe({
      mcpId,
      scopeUserId: u2Id,
      liveTools: def('v1'),
      policy: 'auto',
    });
    await reached;

    const revoke = pins.revoke(u1.pin_id, { expectedHash: hash, actor: 'admin' });
    // let revoke run as far as it can while u2's insert is still pending
    await new Promise(r => setTimeout(r, 50));
    release();
    await u2Observe;
    const r = await revoke;

    expect(r.ok).toBe(true);
    // the concurrently created u2 pin must be withdrawn as well, not left serving the revoked hash
    expect(pins.resolveApproved(mcpId, u1Id, 'search')).toBeUndefined();
    expect(pins.resolveApproved(mcpId, u2Id, 'search')).toBeUndefined();
    expect(pins.getPin(mcpId, u2Id, 'search')?.approved_hash ?? null).toBeNull();
    expect(pins.isRevoked(mcpId, 'search', hash)).toBe(true);
  });
});

describe('TD-070 lock key ordering', () => {
  it('the mcp-wide key sorts before every scope key of the same mcp and equals none', () => {
    const mcp = 'mcp-1';
    const scopes = [null, '', '0', 'a', 'user-1', '\u0001', 'zzz'];
    for (const sc of scopes) {
      const k = scopeLockKey(mcp, sc, '');
      expect(mcpWideKey(mcp) < k).toBe(true);
      expect(mcpWideKey(mcp)).not.toBe(k);
    }
    expect(mcpWideKey(mcp) < scopeLockKey(mcp, null, 'tool')).toBe(true);
  });
});
