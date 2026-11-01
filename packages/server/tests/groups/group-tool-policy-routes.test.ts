/**
 * ADR-025 admin API for per-tool group policy: PUT/POST/GET on group MCP grants, the known-tools
 * endpoint, validation matrix, 404s, authz, audit, and the marketplace effective-tool view.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import {
  compatSelect,
  compatUpdate,
  mcp_catalog,
  mcp_group_access_tools,
} from '@mcpambassador/core';
import { startTestServer, stopTestServer, type TestServerHandle } from '../admin-api/helpers.js';
import { createUser } from '../../src/auth/user-auth.js';

const NIL = '00000000-0000-4000-8000-000000000000';

describe('group tool policy admin API (ADR-025)', () => {
  let server: TestServerHandle;
  let mcpId: string;
  let groupId: string;
  let otherGroupId: string;
  const key = () => ({ 'X-Admin-Key': server.adminKey });
  const call = async (method: string, url: string, payload?: unknown, headers = key()) => {
    const res = await server.admin.inject({ method, url, headers, payload } as never);
    return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as any) : null };
  };
  const rules = async (): Promise<string[]> =>
    ((await compatSelect(server.db).from(mcp_group_access_tools)) as { tool_name: string }[])
      .map(r => r.tool_name)
      .sort();
  const listFor = async (gid: string) =>
    (await call('GET', `/v1/admin/groups/${gid}/mcps`)).body.data as Array<{
      mcp_id: string;
      tool_mode: string;
      tools: string[];
    }>;

  beforeAll(async () => {
    server = await startTestServer();
    const mk = await call('POST', '/v1/admin/mcps', {
      name: 'gtp-mcp',
      display_name: 'GTP',
      transport_type: 'stdio',
      config: { command: ['node', 'fixture.mjs'] },
      isolation_mode: 'shared',
    });
    mcpId = mk.body.data.mcp_id;
    await compatUpdate(server.db, mcp_catalog)
      .set({
        status: 'published',
        tool_catalog: JSON.stringify(['t1', 't2', 't3'].map(name => ({ name, description: name }))),
      })
      .where(eq(mcp_catalog.mcp_id, mcpId));
    groupId = (await call('POST', '/v1/admin/groups', { name: 'gtp-g1', status: 'active' })).body
      .data.group_id;
    otherGroupId = (await call('POST', '/v1/admin/groups', { name: 'gtp-g2', status: 'active' }))
      .body.data.group_id;
  });
  afterAll(async () => {
    await stopTestServer(server);
  });

  it('POST without a policy grants with tool_mode=all and no rules', async () => {
    const r = await call('POST', `/v1/admin/groups/${groupId}/mcps`, { mcp_id: mcpId });
    expect(r.status).toBe(201);
    expect(await listFor(groupId)).toMatchObject([{ mcp_id: mcpId, tool_mode: 'all', tools: [] }]);
    expect(await rules()).toEqual([]);
  });

  it('PUT sets allow, replaces atomically, and de-duplicates', async () => {
    const put = (tool_mode: string, tools: unknown) =>
      call('PUT', `/v1/admin/groups/${groupId}/mcps/${mcpId}/tools`, { tool_mode, tools });
    const a = await put('allow', ['t1', 't1', 't2']);
    expect(a.status).toBe(200);
    expect(a.body.data).toEqual({ tool_mode: 'allow', tools: ['t1', 't2'] });
    expect(await rules()).toEqual(['t1', 't2']);

    const b = await put('deny', ['t3']);
    expect(b.status).toBe(200);
    expect(await rules()).toEqual(['t3']);
    expect(await listFor(groupId)).toMatchObject([{ tool_mode: 'deny', tools: ['t3'] }]);

    const c = await put('all', []);
    expect(c.body.data).toEqual({ tool_mode: 'all', tools: [] });
    expect(await rules()).toEqual([]);
  });

  it('PUT validation matrix returns 400 and writes nothing', async () => {
    const url = `/v1/admin/groups/${groupId}/mcps/${mcpId}/tools`;
    const bad: unknown[] = [
      { tool_mode: 'bogus', tools: [] },
      { tool_mode: 'all', tools: ['t1'] },
      { tool_mode: 'allow', tools: [] },
      { tool_mode: 'deny', tools: [] },
      { tool_mode: 'deny', tools: 'nope' },
      { tool_mode: 'deny', tools: [''] },
      { tool_mode: 'deny', tools: ['a\u0000b'] },
      { tool_mode: 'deny', tools: ['a‮b'] },
      { tool_mode: 'deny', tools: ['a​b'] },
      { tool_mode: 'deny', tools: ['x'.repeat(129)] },
      { tool_mode: 'deny', tools: [42] },
      { tool_mode: 'deny', tools: Array.from({ length: 501 }, (_, i) => `t${i}`) },
      { tool_mode: 'deny', tools: ['t1'], extra: true },
      { tools: ['t1'] },
      { tool_mode: 'deny' },
    ];
    for (const payload of bad) {
      const r = await call('PUT', url, payload);
      expect(r.status, JSON.stringify(payload).slice(0, 80)).toBe(400);
    }
    expect(await rules()).toEqual([]);
  });

  it("an empty deny list is rejected on PUT and POST, pointing at tool_mode 'all'", async () => {
    const put = await call('PUT', `/v1/admin/groups/${groupId}/mcps/${mcpId}/tools`, {
      tool_mode: 'deny',
      tools: [],
    });
    expect(put.status).toBe(400);
    expect(JSON.stringify(put.body)).toContain("use tool_mode 'all' to grant every tool");
    const before = await listFor(otherGroupId);
    const post = await call('POST', `/v1/admin/groups/${otherGroupId}/mcps`, {
      mcp_id: mcpId,
      tool_mode: 'deny',
    });
    expect(post.status).toBe(400);
    expect(await listFor(otherGroupId)).toEqual(before);
    expect(await rules()).toEqual([]);
  });

  it('PUT accepts the full range of real tool-name shapes (exact, no normalisation)', async () => {
    const names = [
      'git.status',
      'repo/read',
      'two words',
      'naïve',
      'Café',
      'Mixed',
      'mixed',
      'x'.repeat(128),
    ];
    const r = await call('PUT', `/v1/admin/groups/${groupId}/mcps/${mcpId}/tools`, {
      tool_mode: 'deny',
      tools: names,
    });
    expect(r.status).toBe(200);
    expect(await rules()).toEqual([...names].sort());
    await call('PUT', `/v1/admin/groups/${groupId}/mcps/${mcpId}/tools`, {
      tool_mode: 'all',
      tools: [],
    });
  });

  it('PUT returns 404 when the group does not grant the MCP, and writes nothing', async () => {
    const r = await call('PUT', `/v1/admin/groups/${otherGroupId}/mcps/${mcpId}/tools`, {
      tool_mode: 'deny',
      tools: ['t1'],
    });
    expect(r.status).toBe(404);
    expect(
      (
        await call('PUT', `/v1/admin/groups/${NIL}/mcps/${mcpId}/tools`, {
          tool_mode: 'all',
          tools: [],
        })
      ).status
    ).toBe(404);
    expect(
      (
        await call('PUT', `/v1/admin/groups/${groupId}/mcps/${NIL}/tools`, {
          tool_mode: 'all',
          tools: [],
        })
      ).status
    ).toBe(404);
    expect(await rules()).toEqual([]);
  });

  it('PUT with a malformed id is a 400', async () => {
    const r = await call('PUT', `/v1/admin/groups/not-a-uuid/mcps/${mcpId}/tools`, {
      tool_mode: 'all',
      tools: [],
    });
    expect(r.status).toBe(400);
  });

  it('POST grants with a policy in one step; an invalid policy creates no grant', async () => {
    const bad = await call('POST', `/v1/admin/groups/${otherGroupId}/mcps`, {
      mcp_id: mcpId,
      tool_mode: 'allow',
      tools: [],
    });
    expect(bad.status).toBe(400);
    expect(await listFor(otherGroupId)).toEqual([]);

    const ok = await call('POST', `/v1/admin/groups/${otherGroupId}/mcps`, {
      mcp_id: mcpId,
      tool_mode: 'allow',
      tools: ['t2', 't1'],
    });
    expect(ok.status).toBe(201);
    expect(await listFor(otherGroupId)).toMatchObject([
      { mcp_id: mcpId, tool_mode: 'allow', tools: ['t1', 't2'] },
    ]);
    // duplicate grant: 409 and the existing rules are untouched
    const dup = await call('POST', `/v1/admin/groups/${otherGroupId}/mcps`, {
      mcp_id: mcpId,
      tool_mode: 'deny',
      tools: ['t3'],
    });
    expect(dup.status).toBe(409);
    expect(await rules()).toEqual(['t1', 't2']);
  });

  it('DELETE of the grant removes its rules', async () => {
    expect((await call('DELETE', `/v1/admin/groups/${otherGroupId}/mcps/${mcpId}`)).status).toBe(
      204
    );
    expect(await rules()).toEqual([]);
  });

  it('every new route requires admin auth', async () => {
    const none = {} as Record<string, string>;
    const put = await call(
      'PUT',
      `/v1/admin/groups/${groupId}/mcps/${mcpId}/tools`,
      { tool_mode: 'all', tools: [] },
      none as never
    );
    const get = await call('GET', `/v1/admin/mcps/${mcpId}/tools`, undefined, none as never);
    const wrong = await call('GET', `/v1/admin/mcps/${mcpId}/tools`, undefined, {
      'X-Admin-Key': 'nope',
    });
    expect([put.status, get.status, wrong.status]).toEqual([401, 401, 401]);
  });

  it('GET /mcps/:id/tools lists known names and flags orphan rules', async () => {
    await call('PUT', `/v1/admin/groups/${groupId}/mcps/${mcpId}/tools`, {
      tool_mode: 'deny',
      tools: ['t2', 'ghost'],
    });
    const r = await call('GET', `/v1/admin/mcps/${mcpId}/tools`);
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({
      mcp_id: mcpId,
      tools: [
        { name: 't1', orphan: false },
        { name: 't2', orphan: false },
        { name: 't3', orphan: false },
        { name: 'ghost', orphan: true },
      ],
    });
    expect((await call('GET', `/v1/admin/mcps/${NIL}/tools`)).status).toBe(404);
    expect((await call('GET', `/v1/admin/mcps/nope/tools`)).status).toBe(400);
  });

  it('writes an audit event with the added and removed names', async () => {
    await call('PUT', `/v1/admin/groups/${groupId}/mcps/${mcpId}/tools`, {
      tool_mode: 'allow',
      tools: ['t1', 't3'],
    });
    const file = path.join(server.dataDir, 'audit', 'audit.jsonl');
    // audit is flushed on an interval: poll for the line
    let events: Array<{ action?: string; metadata?: Record<string, unknown> }> = [];
    for (let i = 0; i < 60; i++) {
      events = fs.existsSync(file)
        ? fs
            .readFileSync(file, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map(l => JSON.parse(l) as (typeof events)[number])
        : [];
      if (
        events.some(
          e => e.action === 'group.mcp_tool_policy.set' && (e.metadata as any)?.count === 2
        )
      )
        break;
      await new Promise(r => setTimeout(r, 250));
    }
    const hits = events.filter(e => e.action === 'group.mcp_tool_policy.set');
    expect(hits.length).toBeGreaterThan(0);
    const m = hits[hits.length - 1]!.metadata!;
    expect(m).toMatchObject({
      group_id: groupId,
      mcp_id: mcpId,
      tool_mode: 'allow',
      count: 2,
      added: ['t1', 't3'],
      added_count: 2,
    });
    expect(JSON.stringify(m)).not.toMatch(/X-Admin-Key|admin_key/i);
  });

  it('the marketplace shows a user only the tools their groups offer (union)', async () => {
    const user = await createUser(server.db, {
      username: 'gtpuser',
      password: 'pass1234',
      display_name: 'U',
    });
    await call('POST', `/v1/admin/groups/${groupId}/members`, { user_id: user.user_id });
    await call('PUT', `/v1/admin/groups/${groupId}/mcps/${mcpId}/tools`, {
      tool_mode: 'allow',
      tools: ['t1'],
    });
    const login = await server.admin.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { username: 'gtpuser', password: 'pass1234' },
    } as never);
    const sc = login.headers['set-cookie'];
    const cookie = (Array.isArray(sc) ? sc[0]! : String(sc)).split(';')[0]!;
    const names = async (): Promise<string[]> => {
      const detail = await server.admin.inject({
        method: 'GET',
        url: `/v1/marketplace/${mcpId}`,
        headers: { cookie },
      } as never);
      expect(detail.statusCode).toBe(200);
      const list = await server.admin.inject({
        method: 'GET',
        url: '/v1/marketplace',
        headers: { cookie },
      } as never);
      const fromList = (JSON.parse(list.body).data as any[])
        .find(m => m.id === mcpId)
        .tools.map((t: any) => t.name);
      const fromDetail = JSON.parse(detail.body).data.tools.map((t: any) => t.name);
      expect(fromList).toEqual(fromDetail);
      return fromDetail;
    };
    expect(await names()).toEqual(['t1']);
    // a second granting group widens (union)
    await call('POST', `/v1/admin/groups/${otherGroupId}/members`, { user_id: user.user_id });
    await call('POST', `/v1/admin/groups/${otherGroupId}/mcps`, {
      mcp_id: mcpId,
      tool_mode: 'deny',
      tools: ['t1'],
    });
    expect(await names()).toEqual(['t1', 't2', 't3']);
  });
});
