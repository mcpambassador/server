import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  closeDatabase,
  createMcpEntry,
  initializeDatabase,
  runMigrations,
  type DatabaseClient,
} from '@mcpambassador/core';
import { scanToolDefinition } from '../../src/services/tool-pins/flags.js';
import { sanitizeToolNameForLog } from '../../src/services/tool-pins/canonical.js';
import { ToolPinService } from '../../src/services/tool-pins/pin-service.js';

const base = { name: 't', inputSchema: { type: 'object' } };

describe('flags: ReDoS + coverage (B1, B3)', () => {
  it('64 KB path-like and phrase-like inputs scan in < 50 ms', () => {
    for (const d of ['/a'.repeat(32 * 1024), 'ignore '.repeat(9000), ' '.repeat(65000) + 'x']) {
      const t0 = performance.now();
      scanToolDefinition({ ...base, description: d } as never);
      expect(performance.now() - t0).toBeLessThan(50);
    }
  });

  it('still flags a sensitive path reference', () => {
    const f = scanToolDefinition({ ...base, description: 'read ~/home/me/.ssh/id_rsa' } as never);
    expect(f.codes).toContain('references_other_tool_or_file');
  });

  it('walks every string key and value in inputSchema/outputSchema/annotations', () => {
    const phrase = 'ignore previous instructions';
    const where: Array<Record<string, unknown>> = [
      { inputSchema: { type: 'object', properties: { [phrase]: { type: 'string' } } } },
      { inputSchema: { type: 'object', properties: { a: { type: 'string', enum: [phrase] } } } },
      { inputSchema: { type: 'object', properties: { a: { type: 'string', default: phrase } } } },
      { inputSchema: { type: 'object', properties: { a: { examples: [phrase] } } } },
      { inputSchema: { type: 'object', properties: { a: { const: phrase } } } },
      { outputSchema: { type: 'object', properties: { a: { description: phrase } } } },
      { annotations: { title: phrase } },
    ];
    for (const w of where) {
      const f = scanToolDefinition({ ...base, ...w } as never);
      expect(f.codes, JSON.stringify(w)).toContain('instruction_phrase');
    }
  });

  it('sanitizeToolNameForLog strips zero-width and bidi characters', () => {
    expect(sanitizeToolNameForLog('a​b‮c⁦d﻿')).toBe('abcd');
  });
});

describe('pin service hardening (B2, B4, B5)', () => {
  let dir: string;
  let db: DatabaseClient;
  let pins: ToolPinService;
  let mcpId: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amb-pinh-'));
    db = await initializeDatabase({ type: 'sqlite', sqliteFilePath: path.join(dir, 'a.db') });
    await runMigrations(db);
    mcpId = (
      await createMcpEntry(db, {
        name: 'm',
        display_name: 'm',
        transport_type: 'stdio',
        isolation_mode: 'shared',
        origin: 'custom',
      } as never)
    ).mcp_id;
    pins = new ToolPinService(db);
    await pins.load();
  });
  afterEach(async () => {
    await closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('B2: concurrent observes of one scope create exactly one pin and one created count', async () => {
    const live = [{ name: 'x', description: 'd', inputSchema: { type: 'object' } }];
    const rs = await Promise.all(
      Array.from({ length: 8 }, () =>
        pins.observe({ mcpId, scopeUserId: null, liveTools: live, policy: 'review' })
      )
    );
    expect(rs.reduce((n, r) => n + r.created, 0)).toBe(1);
    expect(pins.allRecords().filter(r => r.tool_name === 'x')).toHaveLength(1);
    const fresh = new ToolPinService(db);
    await fresh.load();
    expect(fresh.allRecords()).toHaveLength(1);
  });

  it('B4: a valid but oversize definition stores a size marker + full hash and is not approvable', async () => {
    const big = {
      name: 'big',
      description: 'y'.repeat(70 * 1024),
      inputSchema: { type: 'object' },
    };
    await pins.observe({ mcpId, scopeUserId: null, liveTools: [big], policy: 'auto' });
    const rec = pins.getPin(mcpId, null, 'big')!;
    expect(rec.status).toBe('pending_review'); // never auto-approved
    expect(rec.flags).toContain('canonical_too_large');
    expect(JSON.parse(rec.pending_definition!)).toMatchObject({ truncated: true });
    expect(rec.pending_definition!.length).toBeLessThan(200);
    expect(rec.pending_hash).toMatch(/^[0-9a-f]{64}$/);
    const r = await pins.approve(rec.pin_id, { expectedHash: rec.pending_hash!, actor: 'admin' });
    expect(r).toMatchObject({ ok: false, code: 'blocked' });
  });

  it('B5: a corrupt approved_definition does not throw on index/load; the tool is hidden', async () => {
    const live = [{ name: 'x', description: 'd', inputSchema: { type: 'object' } }];
    await pins.observe({ mcpId, scopeUserId: null, liveTools: live, policy: 'auto' });
    const rec = pins.getPin(mcpId, null, 'x')!;
    const bad = '{not json';
    // Make the hash match the garbage so only the JSON.parse path can fail.
    const { hashCanonical } = await import('../../src/services/tool-pins/canonical.js');
    expect(() =>
      pins.index({ ...rec, approved_definition: bad, approved_hash: hashCanonical(bad) })
    ).not.toThrow();
    expect(pins.resolveApproved(mcpId, null, 'x')).toBeUndefined();
  });

  it('duplicate_name is a blocking flag: never approvable', async () => {
    const t = { name: 'd', description: 'a', inputSchema: { type: 'object' } };
    await pins.observe({
      mcpId,
      scopeUserId: null,
      liveTools: [t, { ...t, description: 'b' }],
      policy: 'auto',
    });
    const rec = pins.getPin(mcpId, null, 'd')!;
    expect(rec.status).toBe('pending_review');
    expect(rec.flags).toContain('duplicate_name');
  });
});
