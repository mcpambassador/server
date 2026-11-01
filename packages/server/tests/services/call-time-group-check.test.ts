/**
 * ADR-025 M2/M4 (TD-037): group grants are evaluated at call time for every MCP, and the check is
 * shared with subscribe. Filter, never mutate: re-granting restores access without re-subscribing.
 */
import { listSubscriptionScopes } from '../../src/services/agent-endpoint/bound-client.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AuthorizationError,
  closeDatabase,
  compatInsert,
  clients as clientsTable,
  client_mcp_subscriptions,
  createMcpEntry,
  initializeDatabase,
  revokeGroupAccess,
  grantGroupAccess,
  removeUserFromGroup,
  updateGroup,
  runMigrations,
  type DatabaseClient,
} from '@mcpambassador/core';
import { seedUserGrants } from '../helpers/grants.js';
import { ToolRouter } from '../../src/downstream/tool-router.js';
import { grantedMcpIdsForUser, userHasMcpAccess } from '../../src/services/mcp-access.js';
import { buildInvocationRouter, type ToolServiceDeps } from '../../src/services/tool-service.js';

let subs: Array<{ mcp_id: string; status: string; selected_tools?: string[] }> = [];
vi.mock('../../src/services/subscription-service.js', () => ({
  listClientSubscriptions: vi.fn(async () => subs),
}));

const tool = (name: string, source_mcp: string) => ({
  name,
  description: name,
  inputSchema: { type: 'object' },
  source_mcp,
});

describe('call-time group check (ADR-025 M2/M4)', () => {
  let dir: string;
  let db: DatabaseClient;
  let router: ToolRouter;
  let mcpA: string;
  let mcpB: string;
  let groupId: string;

  const mk = async (name: string): Promise<string> =>
    (
      await createMcpEntry(db, {
        name,
        display_name: name,
        transport_type: 'stdio',
        isolation_mode: 'shared',
      } as never)
    ).mcp_id;
  const names = async (): Promise<string[]> =>
    (await router.getIsolationAwareToolCatalog(db, 'u1', 'c1')).map(
      t => `${t.source_mcp}.${t.name}`
    );

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amb-grp-'));
    db = await initializeDatabase({ type: 'sqlite', sqliteFilePath: path.join(dir, 'a.db') });
    await runMigrations(db);
    mcpA = await mk('mcp-a');
    mcpB = await mk('mcp-b');
    const shared = {
      getToolCatalog: () => [tool('ta', 'mcp-a'), tool('tb', 'mcp-b')],
    };
    router = new ToolRouter(shared as never, { getToolCatalog: () => [] } as never);
    subs = [
      { mcp_id: mcpA, status: 'active' },
      { mcp_id: mcpB, status: 'active' },
    ];
    ({ groupId } = await seedUserGrants(db, 'u1', [mcpA, mcpB]));
  });
  afterEach(async () => {
    await closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('still-granted MCPs are identical to before', async () => {
    expect(await names()).toEqual(['mcp-a.ta', 'mcp-b.tb']);
  });

  it('an outlived grant (subscription kept, grant revoked) drops only that MCP', async () => {
    await revokeGroupAccess(db, mcpB, groupId);
    expect(await names()).toEqual(['mcp-a.ta']);
    expect(subs).toHaveLength(2); // filter, not mutate
  });

  it('re-granting restores access without touching the subscription', async () => {
    await revokeGroupAccess(db, mcpB, groupId);
    await grantGroupAccess(db, { mcp_id: mcpB, group_id: groupId, assigned_by: 'test' });
    expect(await names()).toEqual(['mcp-a.ta', 'mcp-b.tb']);
  });

  it('leaving the only granting group drops the MCP', async () => {
    await removeUserFromGroup(db, 'u1', groupId);
    expect(await names()).toEqual([]);
  });

  it('a suspended group grants nothing; reactivating restores access', async () => {
    await updateGroup(db, groupId, { status: 'suspended' } as never);
    expect(await names()).toEqual([]);
    expect(await userHasMcpAccess(db, 'u1', mcpA)).toBe(false);
    await updateGroup(db, groupId, { status: 'active' } as never);
    expect(await names()).toEqual(['mcp-a.ta', 'mcp-b.tb']);
  });

  it('a grant held through a second group still counts', async () => {
    await removeUserFromGroup(db, 'u1', groupId);
    const { groupId: g2 } = await seedUserGrantsExtra();
    expect(g2).toBeTruthy();
    expect(await names()).toEqual(['mcp-a.ta']);
  });

  it('the invocation router refuses a tool whose grant was revoked', async () => {
    await revokeGroupAccess(db, mcpB, groupId);
    const deps = {
      db,
      toolRouter: router,
      mcpManager: {},
      userPool: {},
    } as unknown as ToolServiceDeps;
    const invoke = buildInvocationRouter(deps, 'u1', 'c1');
    await expect(invoke('tb', {})).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('consent scopes drop MCPs the owner is no longer granted (and suspended groups)', async () => {
    const ts = new Date().toISOString();
    await compatInsert(db, clientsTable).values({
      client_id: 'cs1',
      client_name: 'cs1',
      key_prefix: 'p',
      key_hash: 'h',
      user_id: 'u1',
      status: 'active',
      created_at: ts,
    } as never);
    for (const [i, mcp_id] of [mcpA, mcpB].entries()) {
      await compatInsert(db, client_mcp_subscriptions).values({
        subscription_id: `cs-s${i}`,
        client_id: 'cs1',
        mcp_id,
        status: 'active',
        subscribed_at: ts,
        updated_at: ts,
      } as never);
    }
    const names = async (): Promise<string[]> =>
      (await listSubscriptionScopes(db, 'cs1')).map(x => x.name);
    expect(await names()).toEqual(['mcp-a', 'mcp-b']);
    await revokeGroupAccess(db, mcpB, groupId);
    expect(await names()).toEqual(['mcp-a']);
    await updateGroup(db, groupId, { status: 'suspended' } as never);
    expect(await names()).toEqual([]);
  });

  it('shared helper: subscribe-time and call-time agree', async () => {
    expect(await userHasMcpAccess(db, 'u1', mcpA)).toBe(true);
    await revokeGroupAccess(db, mcpA, groupId);
    expect(await userHasMcpAccess(db, 'u1', mcpA)).toBe(false);
    expect([...(await grantedMcpIdsForUser(db, 'u1'))]).toEqual([mcpB]);
    expect(await grantedMcpIdsForUser(db, 'nobody')).toEqual(new Set());
  });

  async function seedUserGrantsExtra(): Promise<{ groupId: string }> {
    const { createGroup, addUserToGroup } = await import('@mcpambassador/core');
    const g = await createGroup(db, { name: 'g2', description: '', created_by: 'test' } as never);
    await addUserToGroup(db, { user_id: 'u1', group_id: g.group_id, assigned_by: 'test' });
    await grantGroupAccess(db, { mcp_id: mcpA, group_id: g.group_id, assigned_by: 'test' });
    return { groupId: g.group_id };
  }
});
