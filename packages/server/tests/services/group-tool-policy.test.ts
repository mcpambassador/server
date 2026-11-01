/**
 * ADR-025 / FB-032 per-tool group policy: oracle matrix across the surfaces, union semantics,
 * repository atomicity and cascades, and the 0006 -> 0007 migration.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AuthorizationError,
  addUserToGroup,
  closeDatabase,
  compatInsert,
  compatUpdate,
  clients as clientsTable,
  client_mcp_subscriptions,
  createGroup,
  createMcpEntry,
  deleteGroup,
  getGroupToolPolicies,
  grantGroupAccess,
  grantGroupAccessWithPolicy,
  initializeDatabase,
  mcp_catalog,
  mcp_group_access_tools,
  compatSelect,
  revokeGroupAccess,
  runMigrations,
  setGroupToolPolicy,
  tool_profiles,
  updateGroup,
  users,
  type DatabaseClient,
} from '@mcpambassador/core';
import { eq } from 'drizzle-orm';
import { ToolRouter } from '../../src/downstream/tool-router.js';
import { toolAccessForUser } from '../../src/services/mcp-access.js';
import { resolveEffectiveTools } from '../../src/services/catalog-resolver.js';
import { buildInvocationRouter, type ToolServiceDeps } from '../../src/services/tool-service.js';

let subs: Array<{ mcp_id: string; status: string; selected_tools?: string[] }> = [];
vi.mock('../../src/services/subscription-service.js', () => ({
  listClientSubscriptions: vi.fn(async () => subs),
}));

type Mode = 'all' | 'allow' | 'deny';
interface GroupSpec {
  mode: Mode;
  tools?: string[];
  status?: 'active' | 'suspended';
}

/** The oracle: what ADR-025 says a user with these groups may use (union over ACTIVE granting groups). */
function expectedPermitted(groups: GroupSpec[], tool: string): boolean {
  return groups
    .filter(g => (g.status ?? 'active') === 'active')
    .some(g => {
      const listed = (g.tools ?? []).includes(tool);
      return g.mode === 'all' || (g.mode === 'allow' && listed) || (g.mode === 'deny' && !listed);
    });
}

const tool = (name: string, source_mcp: string) => ({
  name,
  description: name,
  inputSchema: { type: 'object' },
  source_mcp,
});

const TOOLS = ['a', 'b', 'c'];

describe('per-tool group policy (ADR-025)', () => {
  let dir: string;
  let db: DatabaseClient;
  let router: ToolRouter;
  let mcpA: string;
  let mcpB: string;
  let seq = 0;
  let catalog: ReturnType<typeof tool>[];

  const mk = async (name: string): Promise<string> =>
    (
      await createMcpEntry(db, {
        name,
        display_name: name,
        transport_type: 'stdio',
        isolation_mode: 'shared',
      } as never)
    ).mcp_id;

  /** A fresh user holding mcpA through one group per spec. */
  async function seedUser(specs: GroupSpec[], mcpId = mcpA): Promise<string> {
    const userId = `u${++seq}`;
    const now = new Date().toISOString();
    await compatInsert(db, users).values({
      user_id: userId,
      username: `user-${userId}`,
      display_name: userId,
      created_at: now,
      updated_at: now,
    } as never);
    for (const [i, spec] of specs.entries()) {
      const g = await createGroup(db, {
        name: `g-${userId}-${i}`,
        description: '',
        status: spec.status ?? 'active',
        created_by: 'test',
      } as never);
      await addUserToGroup(db, { user_id: userId, group_id: g.group_id, assigned_by: 'test' });
      await grantGroupAccessWithPolicy(db, {
        mcp_id: mcpId,
        group_id: g.group_id,
        tool_mode: spec.mode,
        tools: spec.tools ?? [],
        actor: 'test',
      });
    }
    return userId;
  }

  const listed = async (userId: string): Promise<string[]> =>
    (await router.getIsolationAwareToolCatalog(db, userId, 'c1'))
      .filter(t => t.source_mcp === 'mcp-a')
      .map(t => t.name)
      .sort();

  const deps = (): ToolServiceDeps =>
    ({
      db,
      toolRouter: router,
      mcpManager: {
        getToolDescriptor: (n: string) => ({ source_mcp: 'mcp-a', name: n }),
        invokeTool: async () => ({ content: 'ok' }),
      },
      userPool: { getToolDescriptor: () => undefined },
    }) as unknown as ToolServiceDeps;

  const callable = async (userId: string, name: string): Promise<boolean> => {
    try {
      await buildInvocationRouter(deps(), userId, 'c1')(name, {});
      return true;
    } catch (e) {
      if (e instanceof AuthorizationError) return false;
      throw e;
    }
  };

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amb-gtp-'));
    db = await initializeDatabase({ type: 'sqlite', sqliteFilePath: path.join(dir, 'a.db') });
    await runMigrations(db);
    mcpA = await mk('mcp-a');
    mcpB = await mk('mcp-b');
    catalog = [...TOOLS.map(n => tool(n, 'mcp-a')), tool('b', 'mcp-b')];
    router = new ToolRouter(
      { getToolCatalog: () => catalog } as never,
      { getToolCatalog: () => [] } as never
    );
    subs = [{ mcp_id: mcpA, status: 'active' }];
    seq = 0;
  });
  afterEach(async () => {
    await closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ---- oracle matrix: single groups and every ordered pair, across list / call / helper ----------
  const SPECS: GroupSpec[] = [
    { mode: 'all' },
    { mode: 'allow', tools: ['a'] },
    { mode: 'allow', tools: ['b', 'c'] },
    { mode: 'deny', tools: ['a'] },
    { mode: 'deny', tools: ['b'] },
    { mode: 'deny', tools: ['a', 'b', 'c'] },
    { mode: 'allow', tools: ['ghost'] },
    { mode: 'deny', tools: ['ghost'] },
    { mode: 'allow', tools: ['a'], status: 'suspended' },
    { mode: 'all', status: 'suspended' },
  ];
  const combos: GroupSpec[][] = [
    ...SPECS.map(s => [s]),
    ...SPECS.flatMap(x => SPECS.map(y => [x, y])),
  ];

  it(`list, call and helper all match the oracle for ${combos.length} group combinations`, async () => {
    for (const groups of combos) {
      const userId = await seedUser(groups);
      const want = TOOLS.filter(t => expectedPermitted(groups, t));
      const label = JSON.stringify(groups);
      expect(await listed(userId), `list ${label}`).toEqual(want);
      const access = await toolAccessForUser(db, userId);
      for (const t of TOOLS) {
        expect(access.permits(mcpA, t), `helper ${label} ${t}`).toBe(want.includes(t));
        // list <=> call parity: a tool is callable exactly when it is listed
        expect(await callable(userId, t), `call ${label} ${t}`).toBe(want.includes(t));
      }
    }
  }, 120_000);

  it('a denied tool is indistinguishable from a nonexistent one at call time', async () => {
    const u = await seedUser([{ mode: 'deny', tools: ['a'] }]);
    const err = await buildInvocationRouter(deps(), u, 'c1')('a', {}).catch((e: Error) => e);
    const none = await buildInvocationRouter(
      deps(),
      u,
      'c1'
    )('does-not-exist', {}).catch((e: Error) => e);
    expect(err).toBeInstanceOf(AuthorizationError);
    expect((err as Error).message).toBe((none as Error).message);
  });

  it('two deny groups each offer the other group’s tool (union)', async () => {
    const u = await seedUser([
      { mode: 'deny', tools: ['a'] },
      { mode: 'deny', tools: ['b'] },
    ]);
    expect(await listed(u)).toEqual(['a', 'b', 'c']);
  });

  it('any group with all offers everything', async () => {
    const u = await seedUser([{ mode: 'allow', tools: ['a'] }, { mode: 'all' }]);
    expect(await listed(u)).toEqual(['a', 'b', 'c']);
  });

  it('a suspended group’s policy neither widens nor narrows', async () => {
    const u = await seedUser([
      { mode: 'allow', tools: ['a'] },
      { mode: 'all', status: 'suspended' },
    ]);
    expect(await listed(u)).toEqual(['a']);
  });

  it('a change applies to the next call with no cache (mid-session)', async () => {
    const u = await seedUser([{ mode: 'all' }]);
    expect(await listed(u)).toEqual(['a', 'b', 'c']);
    const [p] = await getGroupToolPolicies(db, [await onlyGroupOf(u)]);
    const r = await setGroupToolPolicy(db, {
      mcp_id: mcpA,
      group_id: p!.group_id,
      tool_mode: 'deny',
      tools: ['b'],
      actor: 't',
    });
    expect(r).toEqual({ found: true, added: ['b'], removed: [] });
    expect(await listed(u)).toEqual(['a', 'c']);
    expect(await callable(u, 'b')).toBe(false);
    await setGroupToolPolicy(db, {
      mcp_id: mcpA,
      group_id: p!.group_id,
      tool_mode: 'all',
      tools: [],
      actor: 't',
    });
    expect(await listed(u)).toEqual(['a', 'b', 'c']);
  });

  it('orphan rule names: allow of a ghost offers nothing, deny of a ghost offers everything', async () => {
    expect(await listed(await seedUser([{ mode: 'allow', tools: ['ghost'] }]))).toEqual([]);
    expect(await listed(await seedUser([{ mode: 'deny', tools: ['ghost'] }]))).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('default parity: a grant with no policy lists exactly the pre-policy set', async () => {
    const userId = 'legacy';
    const now = new Date().toISOString();
    await compatInsert(db, users).values({
      user_id: userId,
      username: 'legacy',
      display_name: 'l',
      created_at: now,
      updated_at: now,
    } as never);
    const g = await createGroup(db, {
      name: 'legacy-g',
      description: '',
      created_by: 't',
    } as never);
    await addUserToGroup(db, { user_id: userId, group_id: g.group_id, assigned_by: 't' });
    await grantGroupAccess(db, { mcp_id: mcpA, group_id: g.group_id, assigned_by: 't' });
    expect(await listed(userId)).toEqual(['a', 'b', 'c']);
    expect((await getGroupToolPolicies(db, [g.group_id]))[0]).toMatchObject({
      tool_mode: 'all',
      tools: [],
    });
  });

  it('policy applies per MCP BEFORE same-name dedupe: a denied tool does not shadow another MCP’s', async () => {
    // mcp-a offers a,b,c; mcp-b offers b. Deny b on mcp-a; the user holds both MCPs.
    const u = await seedUser([{ mode: 'deny', tools: ['b'] }]);
    const gB = await createGroup(db, {
      name: `gb-${u}`,
      description: '',
      created_by: 't',
    } as never);
    await addUserToGroup(db, { user_id: u, group_id: gB.group_id, assigned_by: 't' });
    await grantGroupAccess(db, { mcp_id: mcpB, group_id: gB.group_id, assigned_by: 't' });
    subs = [
      { mcp_id: mcpA, status: 'active' },
      { mcp_id: mcpB, status: 'active' },
    ];
    const cat = await router.getIsolationAwareToolCatalog(db, u, 'c1');
    expect(cat.map(t => `${t.source_mcp}.${t.name}`).sort()).toEqual([
      'mcp-a.a',
      'mcp-a.c',
      'mcp-b.b',
    ]);
  });

  it('selected_tools narrows further, after the group policy', async () => {
    const u = await seedUser([{ mode: 'allow', tools: ['a', 'b'] }]);
    subs = [{ mcp_id: mcpA, status: 'active', selected_tools: ['b', 'c'] }];
    expect(await listed(u)).toEqual(['b']);
  });

  it('tool-name shapes match byte-exactly: dots, slashes, spaces, unicode, mixed case', async () => {
    const odd = ['git.status', 'repo/read', 'two words', 'naïve', 'Café', 'MixedCase', 'mixedcase'];
    catalog = odd.map(n => tool(n, 'mcp-a'));
    const u = await seedUser([
      { mode: 'allow', tools: ['git.status', 'repo/read', 'two words', 'Café', 'MixedCase'] },
    ]);
    expect(await listed(u)).toEqual(
      ['Café', 'MixedCase', 'git.status', 'repo/read', 'two words'].sort()
    );
    // normalisation or case folding must NOT make 'naïve'/'mixedcase' or a decomposed 'Café' match
    catalog = [tool('Café', 'mcp-a'), tool('mixedcase', 'mcp-a')];
    expect(await listed(u)).toEqual([]);
  });

  it('resolveEffectiveTools applies the same policy', async () => {
    const now = new Date().toISOString();
    await compatInsert(db, tool_profiles).values({
      profile_id: 'p1',
      name: 'p1',
      description: '',
      created_at: now,
      updated_at: now,
    } as never);
    await compatUpdate(db, mcp_catalog)
      .set({
        status: 'published',
        tool_catalog: JSON.stringify(TOOLS.map(n => ({ name: n, description: n }))),
      })
      .where(eq(mcp_catalog.mcp_id, mcpA));
    const u = await seedUser([{ mode: 'deny', tools: ['a'] }]);
    await compatInsert(db, clientsTable).values({
      client_id: 'rc1',
      client_name: 'rc1',
      key_prefix: 'p',
      key_hash: 'h',
      user_id: u,
      profile_id: 'p1',
      status: 'active',
      created_at: now,
    } as never);
    await compatInsert(db, client_mcp_subscriptions).values({
      subscription_id: 'rs1',
      client_id: 'rc1',
      mcp_id: mcpA,
      status: 'active',
      subscribed_at: now,
      updated_at: now,
    } as never);
    expect((await resolveEffectiveTools(db, 'rc1')).map(t => t.name).sort()).toEqual(['b', 'c']);
  });

  // ---- repository --------------------------------------------------------------------------------
  async function onlyGroupOf(userId: string): Promise<string> {
    const rows = (await compatSelect(db).from(
      (await import('@mcpambassador/core')).user_groups
    )) as {
      user_id: string;
      group_id: string;
    }[];
    return rows.find(r => r.user_id === userId)!.group_id;
  }
  const ruleCount = async (): Promise<number> =>
    ((await compatSelect(db).from(mcp_group_access_tools)) as unknown[]).length;

  it('setGroupToolPolicy: found=false (and nothing written) when the group does not grant the MCP', async () => {
    const g = await createGroup(db, { name: 'lonely', description: '', created_by: 't' } as never);
    const r = await setGroupToolPolicy(db, {
      mcp_id: mcpA,
      group_id: g.group_id,
      tool_mode: 'deny',
      tools: ['a'],
      actor: 't',
    });
    expect(r.found).toBe(false);
    expect(await ruleCount()).toBe(0);
  });

  it('replace is a diff: added/removed reported, old rows gone', async () => {
    const u = await seedUser([{ mode: 'allow', tools: ['a', 'b'] }]);
    const gid = await onlyGroupOf(u);
    const r = await setGroupToolPolicy(db, {
      mcp_id: mcpA,
      group_id: gid,
      tool_mode: 'allow',
      tools: ['b', 'c'],
      actor: 't',
    });
    expect(r).toEqual({ found: true, added: ['c'], removed: ['a'] });
    expect((await getGroupToolPolicies(db, [gid]))[0]!.tools).toEqual(['b', 'c']);
    expect(await ruleCount()).toBe(2);
  });

  it('cascade: revoking the grant, deleting the group and deleting the MCP all drop the rules', async () => {
    const u1 = await seedUser([{ mode: 'deny', tools: ['a', 'b'] }]);
    const g1 = await onlyGroupOf(u1);
    await revokeGroupAccess(db, mcpA, g1);
    expect(await ruleCount()).toBe(0);

    const u2 = await seedUser([{ mode: 'deny', tools: ['a'] }]);
    expect(await ruleCount()).toBe(1);
    await deleteGroup(db, await onlyGroupOf(u2));
    expect(await ruleCount()).toBe(0);

    await seedUser([{ mode: 'allow', tools: ['a', 'c'] }]);
    expect(await ruleCount()).toBe(2);
    (db as never as { session: { client: { exec(s: string): void } } }).session.client.exec(
      `DELETE FROM mcp_catalog WHERE mcp_id = '${mcpA}'`
    );
    expect(await ruleCount()).toBe(0);
  });

  it('re-granting after a revoke starts from tool_mode=all (no stale rules)', async () => {
    const u = await seedUser([{ mode: 'deny', tools: ['a'] }]);
    const gid = await onlyGroupOf(u);
    await revokeGroupAccess(db, mcpA, gid);
    await grantGroupAccess(db, { mcp_id: mcpA, group_id: gid, assigned_by: 't' });
    expect(await listed(u)).toEqual(['a', 'b', 'c']);
  });

  it('grantGroupAccessWithPolicy is atomic: a duplicate grant leaves no half-written rules', async () => {
    const g = await createGroup(db, { name: 'atomic', description: '', created_by: 't' } as never);
    await grantGroupAccess(db, { mcp_id: mcpA, group_id: g.group_id, assigned_by: 't' });
    await expect(
      grantGroupAccessWithPolicy(db, {
        mcp_id: mcpA,
        group_id: g.group_id,
        tool_mode: 'allow',
        tools: ['a'],
        actor: 't',
      })
    ).rejects.toThrow();
    expect(await ruleCount()).toBe(0);
    expect((await getGroupToolPolicies(db, [g.group_id]))[0]!.tool_mode).toBe('all');
  });

  it('the tool_mode CHECK rejects unknown modes', async () => {
    const g = await createGroup(db, { name: 'chk', description: '', created_by: 't' } as never);
    await grantGroupAccess(db, { mcp_id: mcpA, group_id: g.group_id, assigned_by: 't' });
    const client = (db as never as { session: { client: { exec(s: string): void } } }).session
      .client;
    expect(() =>
      client.exec(
        `UPDATE mcp_group_access SET tool_mode = 'bogus' WHERE group_id = '${g.group_id}'`
      )
    ).toThrow();
  });

  it('a suspended then reactivated group restores its own policy', async () => {
    const u = await seedUser([{ mode: 'allow', tools: ['a'] }]);
    const gid = await onlyGroupOf(u);
    await updateGroup(db, gid, { status: 'suspended' } as never);
    expect(await listed(u)).toEqual([]);
    await updateGroup(db, gid, { status: 'active' } as never);
    expect(await listed(u)).toEqual(['a']);
  });
});

describe('migration 0007 on a populated 0006 database', () => {
  it('adds tool_mode=all to every existing grant and changes no counts', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amb-m7-'));
    const real = path.join(__dirname, '..', '..', '..', 'core', 'drizzle');
    const upTo6 = path.join(dir, 'm6');
    fs.mkdirSync(upTo6);
    for (const f of fs.readdirSync(real).filter(n => n < '0007')) {
      fs.copyFileSync(path.join(real, f), path.join(upTo6, f));
    }
    const db = await initializeDatabase({ type: 'sqlite', sqliteFilePath: path.join(dir, 'a.db') });
    try {
      await runMigrations(db, { migrationsDir: upTo6 });
      const raw = (
        db as never as {
          session: {
            client: {
              exec(s: string): void;
              prepare(s: string): { all(): Record<string, unknown>[] };
            };
          };
        }
      ).session.client;
      const ts = new Date().toISOString();
      raw.exec(
        `INSERT INTO groups (group_id, name, created_by, created_at, updated_at) VALUES ('g1','g1','t','${ts}','${ts}'), ('g2','g2','t','${ts}','${ts}');
         INSERT INTO mcp_catalog (mcp_id, name, display_name, transport_type, created_at, updated_at) VALUES ('m1','m1','m1','stdio','${ts}','${ts}'), ('m2','m2','m2','stdio','${ts}','${ts}');
         INSERT INTO mcp_group_access (mcp_id, group_id, assigned_at, assigned_by) VALUES ('m1','g1','${ts}','t'), ('m2','g1','${ts}','t'), ('m1','g2','${ts}','t');`
      );
      const before = raw.prepare('SELECT * FROM mcp_group_access ORDER BY mcp_id, group_id').all();
      expect(before).toHaveLength(3);

      await runMigrations(db); // applies 0007 exactly once
      const after = raw.prepare('SELECT * FROM mcp_group_access ORDER BY mcp_id, group_id').all();
      expect(after).toHaveLength(3);
      expect(after.map(r => r.tool_mode)).toEqual(['all', 'all', 'all']);
      for (const [i, b] of before.entries()) {
        expect({ ...after[i], tool_mode: undefined }).toEqual({ ...b, tool_mode: undefined });
      }
      expect(raw.prepare('SELECT COUNT(*) AS n FROM mcp_group_access_tools').all()[0]!.n).toBe(0);
      // idempotent re-run
      await runMigrations(db);
      expect(raw.prepare('SELECT COUNT(*) AS n FROM mcp_group_access').all()[0]!.n).toBe(3);
    } finally {
      await closeDatabase(db);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
