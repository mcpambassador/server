import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  addUserToGroup,
  closeDatabase,
  compatInsert,
  createGroup,
  createMcpEntry,
  grantGroupAccess,
  users,
  initializeDatabase,
  runMigrations,
  type DatabaseClient,
} from '@mcpambassador/core';
import { ToolRouter } from '../../src/downstream/tool-router.js';
import { KillSwitchManager } from '../../src/admin/kill-switch-manager.js';
import { toolKillSwitchTarget } from '@mcpambassador/contracts';

let subs: Array<{ mcp_id: string; status: string }> = [];
vi.mock('../../src/services/subscription-service.js', () => ({
  listClientSubscriptions: vi.fn(async () => subs),
}));

// ADR-025 M1 / reviewer S1: the tool switch applies BEFORE the first-wins dedupe, so killing alpha/fetch
// leaves beta/fetch listed.
describe('ToolRouter tool kill switch (before dedupe)', () => {
  let dir: string;
  let db: DatabaseClient;
  const tool = (name: string, source_mcp: string) => ({
    name,
    description: name,
    inputSchema: { type: 'object' },
    source_mcp,
  });

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amb-tksr-'));
    db = await initializeDatabase({ type: 'sqlite', sqliteFilePath: path.join(dir, 'a.db') });
    await runMigrations(db);
  });
  afterEach(async () => {
    await closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('killing alpha/fetch leaves beta/fetch listed (default first-wins and keepShadowed)', async () => {
    const mk = async (name: string): Promise<string> =>
      (
        await createMcpEntry(db, {
          name,
          display_name: name,
          transport_type: 'stdio',
          isolation_mode: 'shared',
        } as never)
      ).mcp_id;
    const alpha = await mk('alpha');
    const beta = await mk('beta');
    // ADR-025 M2/M4: grants are checked at list time, so u1 needs a group that grants both MCPs.
    const now = new Date().toISOString();
    await compatInsert(db, users).values({
      user_id: 'u1',
      username: 'u1',
      display_name: 'u1',
      created_at: now,
      updated_at: now,
    } as never);
    const g = await createGroup(db, { name: 'g-ks', description: '', created_by: 't' } as never);
    await addUserToGroup(db, { user_id: 'u1', group_id: g.group_id, assigned_by: 't' });
    for (const m of [alpha, beta])
      await grantGroupAccess(db, { mcp_id: m, group_id: g.group_id, assigned_by: 't' });
    subs = [
      { mcp_id: alpha, status: 'active' },
      { mcp_id: beta, status: 'active' },
    ];
    const shared = {
      getToolCatalog: () => [tool('fetch', 'alpha'), tool('read', 'alpha'), tool('fetch', 'beta')],
    };
    const router = new ToolRouter(shared as never, { getToolCatalog: () => [] } as never);
    const ks = new KillSwitchManager();
    router.setKillSwitch(ks);
    const ids = async (o?: { keepShadowed?: boolean }): Promise<string[]> =>
      (await router.getIsolationAwareToolCatalog(db, 'u1', 'c1', o)).map(
        t => `${t.source_mcp}/${t.name}`
      );

    expect(await ids()).toEqual(['alpha/fetch', 'alpha/read']); // baseline: alpha wins the name
    await ks.set(toolKillSwitchTarget(alpha, 'fetch'), true, 'a');
    expect(await ids()).toEqual(['alpha/read', 'beta/fetch']);
    expect(await ids({ keepShadowed: true })).toEqual(['alpha/read', 'beta/fetch']);
    // the name is keyed on mcp_id: a switch built from the MCP name matches nothing
    await ks.set(toolKillSwitchTarget('alpha', 'read'), true, 'a');
    expect(await ids()).toContain('alpha/read');
  });
});
