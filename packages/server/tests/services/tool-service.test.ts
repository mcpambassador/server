import { describe, it, expect, vi } from 'vitest';
import { AuthorizationError } from '@mcpambassador/core';
import {
  listPermittedTools,
  invokeTool,
  buildInvocationRouter,
  resolveSessionUserId,
  SessionStateError,
  SessionBindingError,
  type ToolServiceDeps,
} from '../../src/services/tool-service.js';

const session = {
  session_id: 's1',
  client_id: 'c1',
  user_id: 'u1',
  profile_id: 'p1',
  auth_method: 'preshared_key',
} as any;

function mkDeps(over: Partial<Record<string, any>> = {}) {
  const catalog = over.catalog ?? [
    { name: 'a.read', description: 'r', inputSchema: { type: 'object' }, source_mcp: 'a' },
    { name: 'a.write', description: 'w', inputSchema: { type: 'object' }, source_mcp: 'a' },
    { name: 'u.tool', description: 'u', inputSchema: { type: 'object' }, source_mcp: 'u' },
  ];
  const deps = {
    db: {
      query: {
        user_sessions: {
          findFirst: vi.fn(async () => (over.noSession ? undefined : { user_id: 'u1' })),
        },
      },
    },
    authz: {
      authorize: vi.fn(async (_s: any, r: any) =>
        (over.deny ?? []).includes(r.tool_name)
          ? { decision: 'deny', reason: 'no' }
          : { decision: 'permit' }
      ),
    },
    pipeline: {
      invoke: vi.fn(async (req: any, _a: any, router: any) => {
        const r = await router(req.tool_name, req.arguments);
        return {
          result: r.content,
          request_id: 'r',
          timestamp: 't',
          metadata: { mcp_server: r.mcpServer },
        };
      }),
    },
    toolRouter: { getIsolationAwareToolCatalog: vi.fn(async () => catalog) },
    mcpManager: {
      getToolDescriptor: vi.fn((n: string) =>
        n.startsWith('a.') ? { source_mcp: 'a' } : undefined
      ),
      invokeTool: vi.fn(async () => ({ content: 'shared-ok', isError: false })),
    },
    userPool: {
      getToolDescriptor: vi.fn((_u: string, n: string) =>
        n === 'u.tool' ? { source_mcp: 'u' } : undefined
      ),
      invokeTool: vi.fn(async () => ({ content: 'user-ok', isError: false })),
    },
  };
  return deps as unknown as ToolServiceDeps & typeof deps;
}

describe('resolveSessionUserId', () => {
  it('returns user id', async () => {
    expect(await resolveSessionUserId(mkDeps().db, session)).toBe('u1');
  });
  it('throws SessionStateError when session record missing', async () => {
    await expect(
      resolveSessionUserId(mkDeps({ noSession: true }).db, session)
    ).rejects.toBeInstanceOf(SessionStateError);
  });
});

describe('listPermittedTools', () => {
  it('maps catalog to protocol descriptors and filters denied tools', async () => {
    const deps = mkDeps({ deny: ['a.write'] });
    const tools = await listPermittedTools(deps, session, 'u1');
    expect(tools.map(t => t.name)).toEqual(['a.read', 'u.tool']);
    expect(tools[0]).toEqual({
      name: 'a.read',
      description: 'r',
      input_schema: { type: 'object' },
      metadata: { mcp_server: 'a' },
    });
    expect(deps.toolRouter.getIsolationAwareToolCatalog).toHaveBeenCalledWith(deps.db, 'u1', 'c1');
  });
  it('rejects sessions without client binding', async () => {
    await expect(
      listPermittedTools(mkDeps(), { ...session, client_id: '' }, 'u1')
    ).rejects.toBeInstanceOf(SessionBindingError);
  });
});

describe('buildInvocationRouter', () => {
  it('routes to shared MCP when source matches', async () => {
    const deps = mkDeps();
    const r = await buildInvocationRouter(deps, 'u1', 'c1')('a.read', { x: 1 });
    expect(r).toEqual({ content: 'shared-ok', isError: false, mcpServer: 'a' });
    expect(deps.mcpManager.invokeTool).toHaveBeenCalledWith({
      tool_name: 'a.read',
      arguments: { x: 1 },
    });
  });
  it('routes to the per-user pool when source matches', async () => {
    const deps = mkDeps();
    const r = await buildInvocationRouter(deps, 'u1', 'c1')('u.tool', {});
    expect(r.content).toBe('user-ok');
    expect(deps.userPool.invokeTool).toHaveBeenCalledWith('u1', {
      tool_name: 'u.tool',
      arguments: {},
    });
  });
  it('denies tools not in the subscription catalog', async () => {
    await expect(buildInvocationRouter(mkDeps(), 'u1', 'c1')('nope', {})).rejects.toBeInstanceOf(
      AuthorizationError
    );
  });
  it('denies on name collision where neither manager matches the allowed source', async () => {
    const deps = mkDeps({
      catalog: [{ name: 'dup', description: '', inputSchema: {}, source_mcp: 'x' }],
    });
    deps.mcpManager.getToolDescriptor = vi.fn(() => ({ source_mcp: 'other' })) as any;
    deps.userPool.getToolDescriptor = vi.fn(() => ({ source_mcp: 'other2' })) as any;
    await expect(buildInvocationRouter(deps, 'u1', 'c1')('dup', {})).rejects.toBeInstanceOf(
      AuthorizationError
    );
    expect(deps.mcpManager.invokeTool).not.toHaveBeenCalled();
    expect(deps.userPool.invokeTool).not.toHaveBeenCalled();
  });
});

describe('invokeTool', () => {
  it('passes request, authRequest and router to the pipeline', async () => {
    const deps = mkDeps();
    const authReq = { headers: { 'x-session-token': 't' }, sourceIp: '1.2.3.4' };
    const res = await invokeTool(
      deps,
      session,
      'u1',
      { tool: 'a.read', arguments: { q: 1 } },
      authReq
    );
    expect(res.result).toBe('shared-ok');
    const [req, ar] = (deps.pipeline.invoke as any).mock.calls[0];
    expect(req).toEqual({ tool_name: 'a.read', client_id: 'c1', arguments: { q: 1 } });
    expect(ar).toBe(authReq);
  });
  it('propagates pipeline errors unchanged', async () => {
    const deps = mkDeps();
    (deps.pipeline.invoke as any).mockRejectedValueOnce(new AuthorizationError('x'));
    await expect(
      invokeTool(
        deps,
        session,
        'u1',
        { tool: 'a.read', arguments: {} },
        { headers: {}, sourceIp: '' }
      )
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
  it('rejects sessions without client binding before invoking', async () => {
    const deps = mkDeps();
    await expect(
      invokeTool(
        deps,
        { ...session, client_id: undefined },
        'u1',
        { tool: 'a', arguments: {} },
        {
          headers: {},
          sourceIp: '',
        }
      )
    ).rejects.toBeInstanceOf(SessionBindingError);
    expect(deps.pipeline.invoke).not.toHaveBeenCalled();
  });
});
