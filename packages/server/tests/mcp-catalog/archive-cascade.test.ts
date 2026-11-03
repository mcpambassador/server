/**
 * TD-001: archiving a catalog entry and pausing its subscriptions is one transaction.
 * If pausing a subscription fails, the entry must stay published (no half-archived MCP).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  client_mcp_subscriptions,
  createMcpEntry,
  createSubscription,
  getMcpEntryById,
  listSubscriptionsForMcp,
  updateMcpEntry,
} from '@mcpambassador/core';
import { startTestServer, stopTestServer, type TestServerHandle } from '../admin-api/helpers.js';
import { createUser } from '../../src/auth/user-auth.js';
import { createUserClient } from '../../src/services/client-service.js';
import { archiveMcpEntry } from '../../src/services/mcp-catalog-service.js';

describe('archiveMcpEntry cascade is atomic (TD-001)', () => {
  let server: TestServerHandle;
  let clientId: string;

  beforeAll(async () => {
    server = await startTestServer();
    const user = await createUser(server.db, {
      username: 'archiveuser',
      password: 'pass1234',
      display_name: 'Archive User',
      email: 'archive@example.com',
    });
    clientId = (
      await createUserClient(server.db, {
        userId: user.user_id,
        clientName: 'archive-client',
        profileId: null,
        expiresAt: null,
      })
    ).client.client_id;
  });

  afterAll(async () => {
    await stopTestServer(server);
  });

  async function publishedMcpWithSubscription(name: string) {
    const mcp = await createMcpEntry(server.db, {
      name,
      display_name: name,
      transport_type: 'stdio',
      isolation_mode: 'shared',
    } as never);
    await updateMcpEntry(server.db, mcp.mcp_id, { status: 'published' });
    await createSubscription(server.db, { client_id: clientId, mcp_id: mcp.mcp_id });
    return mcp.mcp_id;
  }

  it('archives the entry and pauses its active subscriptions', async () => {
    const id = await publishedMcpWithSubscription(`arch-ok-${Date.now()}`);
    await archiveMcpEntry(server.db, id);
    expect((await getMcpEntryById(server.db, id))!.status).toBe('archived');
    const subs = await listSubscriptionsForMcp(server.db, id);
    expect(subs.map(s => s.status)).toEqual(['paused']);
  });

  it('keeps the MCP published (and the subscription active) when pausing a subscription throws', async () => {
    const id = await publishedMcpWithSubscription(`arch-fail-${Date.now()}`);

    // db whose UPDATE on the subscriptions table fails
    const failing = new Proxy(server.db as any, {
      get(target, prop, receiver) {
        if (prop !== 'update') return Reflect.get(target, prop, receiver);
        return (table: unknown) => {
          if (table === client_mcp_subscriptions) throw new Error('boom: updateSubscription');
          return target.update(table);
        };
      },
    });

    await expect(archiveMcpEntry(failing, id)).rejects.toThrow('boom');
    expect((await getMcpEntryById(server.db, id))!.status).toBe('published');
    const subs = await listSubscriptionsForMcp(server.db, id);
    expect(subs.map(s => s.status)).toEqual(['active']);
  });
});
