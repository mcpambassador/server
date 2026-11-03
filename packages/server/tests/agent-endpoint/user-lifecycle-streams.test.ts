/**
 * TD-025: suspending or deactivating a user closes that user's live agent streams right away
 * (not at the next token validation) and writes an `agent_streams_closed` audit event.
 * Grants are kept, so reactivation restores access.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { listAgentGrantsForUser } from '@mcpambassador/core';
import type { AgentStreamRegistry } from '../../src/services/agent-endpoint/index.js';
import {
  startAgentTestServer,
  stopAgentTestServer,
  agentEndpointOpts,
  createUser,
  loginSession,
  type AgentTestServer,
} from './helpers.js';
import { registerAdminClient, fullFlow, REDIRECT_URI } from './oauth-flow-helpers.js';

let s: AgentTestServer;
let clientId: string;

beforeAll(async () => {
  s = await startAgentTestServer(agentEndpointOpts());
  clientId = await registerAdminClient(s, {
    client_name: 'td025-client',
    redirect_uris: [REDIRECT_URI],
  });
});
afterAll(async () => {
  await stopAgentTestServer(s);
});

const streams = (): AgentStreamRegistry =>
  (s.server as unknown as { agentEndpointDeps: { streams: AgentStreamRegistry } }).agentEndpointDeps
    .streams;

/** A user with one live grant and one open (fake) stream on it. */
async function userWithOpenStream(
  prefix: string
): Promise<{ userId: string; grantId: string; aborted: () => boolean }> {
  const user = await createUser(s, prefix);
  const sess = await loginSession(s, user);
  await fullFlow(s, sess, clientId, { scopes: ['mcp:*'] });
  const grants = await listAgentGrantsForUser(s.db, user.userId);
  expect(grants).toHaveLength(1);
  const grantId = grants[0]!.grant_id;
  let aborted = false;
  expect(streams().acquire(grantId, 5, () => (aborted = true))).not.toBeNull();
  return { userId: user.userId, grantId, aborted: () => aborted };
}

async function waitForAudit(...needles: string[]): Promise<string> {
  const f = path.join(s.dataDir, 'audit', 'audit.jsonl');
  const deadline = Date.now() + 15_000;
  for (;;) {
    const lines = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n') : [];
    const hit = lines.find(l => needles.every(n => l.includes(n)));
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`audit line with ${needles.join(' + ')} not found`);
    await new Promise(r => setTimeout(r, 250));
  }
}

describe('user lifecycle closes live agent streams (TD-025)', () => {
  it('suspending a user aborts their open streams, audits it, and keeps the grant', async () => {
    const u = await userWithOpenStream('susp');
    const res = await s.admin.inject({
      method: 'PATCH',
      url: `/v1/admin/users/${u.userId}`,
      headers: { 'X-Admin-Key': s.adminKey },
      payload: { status: 'suspended' },
    });
    expect(res.statusCode).toBe(200);

    expect(u.aborted()).toBe(true);
    expect(streams().count(u.grantId)).toBe(0);
    await waitForAudit('agent_streams_closed', u.userId, 'user_suspended');

    const grants = await listAgentGrantsForUser(s.db, u.userId);
    expect(grants[0]!.revoked_at).toBeFalsy();
  });

  it('deactivating a user (DELETE) aborts their open streams and audits it', async () => {
    const u = await userWithOpenStream('deact');
    const res = await s.admin.inject({
      method: 'DELETE',
      url: `/v1/admin/users/${u.userId}`,
      headers: { 'X-Admin-Key': s.adminKey },
    });
    expect(res.statusCode).toBe(200);

    expect(u.aborted()).toBe(true);
    await waitForAudit('agent_streams_closed', u.userId, 'user_deactivated');
  });

  it("does not touch another user's streams, and a no-op status change closes nothing", async () => {
    const a = await userWithOpenStream('keep-a');
    const b = await userWithOpenStream('keep-b');
    const res = await s.admin.inject({
      method: 'PATCH',
      url: `/v1/admin/users/${a.userId}`,
      headers: { 'X-Admin-Key': s.adminKey },
      payload: { display_name: 'renamed' },
    });
    expect(res.statusCode).toBe(200);
    expect(a.aborted()).toBe(false);
    expect(b.aborted()).toBe(false);

    await s.admin.inject({
      method: 'PATCH',
      url: `/v1/admin/users/${a.userId}`,
      headers: { 'X-Admin-Key': s.adminKey },
      payload: { status: 'suspended' },
    });
    expect(a.aborted()).toBe(true);
    expect(b.aborted()).toBe(false);
  });
});
