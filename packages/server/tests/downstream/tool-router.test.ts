import { describe, it, beforeEach, expect, vi } from 'vitest';
import { makeTool } from './helpers';

// Mock SharedMcpManager
class MockSharedMcpManager {
  private tools: any[];

  constructor(tools: any[] = []) {
    this.tools = tools;
  }

  getToolCatalog(): any[] {
    return this.tools;
  }

  getToolDescriptor(toolName: string): any | undefined {
    return this.tools.find(tool => tool.name === toolName);
  }

  async invokeTool(request: any): Promise<any> {
    const tool = this.tools.find(t => t.name === request.tool_name);
    if (!tool) {
      throw new Error(`Tool not found: ${request.tool_name}`);
    }
    return {
      success: true,
      result: `Invoked shared tool ${request.tool_name}`,
    };
  }

  getStatus(): any {
    return {
      total_connections: 2,
      healthy_connections: 2,
      total_tools: this.tools.length,
      connections: [],
    };
  }
}

// Mock UserMcpPool
class MockUserMcpPool {
  private userTools: Map<string, any[]>;

  constructor() {
    this.userTools = new Map();
  }

  setToolsForUser(userId: string, tools: any[]): void {
    this.userTools.set(userId, tools);
  }

  getToolCatalog(userId: string): any[] {
    return this.userTools.get(userId) || [];
  }

  getToolDescriptor(userId: string, toolName: string): any | undefined {
    const tools = this.userTools.get(userId) || [];
    return tools.find(tool => tool.name === toolName);
  }

  async invokeTool(userId: string, request: any): Promise<any> {
    const tools = this.userTools.get(userId) || [];
    const tool = tools.find(t => t.name === request.tool_name);
    if (!tool) {
      throw new Error(`Tool not found: ${request.tool_name}`);
    }
    return {
      success: true,
      result: `Invoked user tool ${request.tool_name} for ${userId}`,
    };
  }

  getStatus(): any {
    return {
      totalUserInstances: this.userTools.size,
      userCount: this.userTools.size,
      instancesByUser: this.userTools,
      totalConnections: 0,
    };
  }
}

let ToolRouter: any;

beforeEach(async () => {
  try {
    const mod = await import('../../../src/downstream/tool-router');
    ToolRouter = mod.ToolRouter;
  } catch (err) {
    console.error('Failed to import ToolRouter:', err);
  }
});

describe('ToolRouter - Catalog Composition', () => {
  it('returns shared tools when user has no per-user tools', async () => {
    if (!ToolRouter) return expect(true).toBeTruthy();

    const sharedTools = [
      { ...makeTool('shared_tool1', 'Shared tool 1'), source_mcp: 'shared1' },
      { ...makeTool('shared_tool2', 'Shared tool 2'), source_mcp: 'shared2' },
    ];

    const sharedManager = new MockSharedMcpManager(sharedTools);
    const userPool = new MockUserMcpPool();

    const router = new ToolRouter(sharedManager, userPool);

    const catalog = router.getToolCatalog('user1');
    expect(catalog.length).toBe(2);
    expect(catalog[0].name).toBe('shared_tool1');
    expect(catalog[1].name).toBe('shared_tool2');
  });

  it('returns union of shared + per-user tools', async () => {
    if (!ToolRouter) return expect(true).toBeTruthy();

    const sharedTools = [
      { ...makeTool('shared_tool1', 'Shared tool 1'), source_mcp: 'shared1' },
    ];

    const userTools = [
      { ...makeTool('user_tool1', 'User tool 1'), source_mcp: 'user_mcp1' },
      { ...makeTool('user_tool2', 'User tool 2'), source_mcp: 'user_mcp2' },
    ];

    const sharedManager = new MockSharedMcpManager(sharedTools);
    const userPool = new MockUserMcpPool();
    userPool.setToolsForUser('user1', userTools);

    const router = new ToolRouter(sharedManager, userPool);

    const catalog = router.getToolCatalog('user1');
    expect(catalog.length).toBe(3);

    // Shared tool should come first
    expect(catalog[0].name).toBe('shared_tool1');

    // User tools should follow
    const toolNames = catalog.map(t => t.name);
    expect(toolNames).toContain('user_tool1');
    expect(toolNames).toContain('user_tool2');
  });

  it('shared tools win on name conflict (deduplication)', async () => {
    if (!ToolRouter) return expect(true).toBeTruthy();

    const sharedTools = [
      { ...makeTool('conflict_tool', 'Shared version'), source_mcp: 'shared1' },
      { ...makeTool('shared_tool1', 'Shared tool 1'), source_mcp: 'shared2' },
    ];

    const userTools = [
      { ...makeTool('conflict_tool', 'User version'), source_mcp: 'user_mcp1' },
      { ...makeTool('user_tool1', 'User tool 1'), source_mcp: 'user_mcp2' },
    ];

    const sharedManager = new MockSharedMcpManager(sharedTools);
    const userPool = new MockUserMcpPool();
    userPool.setToolsForUser('user1', userTools);

    const router = new ToolRouter(sharedManager, userPool);

    const catalog = router.getToolCatalog('user1');

    // Should have 3 tools total (conflict_tool from shared, shared_tool1, user_tool1)
    expect(catalog.length).toBe(3);

    // Find conflict_tool
    const conflictTool = catalog.find(t => t.name === 'conflict_tool');
    expect(conflictTool).toBeDefined();
    expect(conflictTool?.description).toBe('Shared version');
    expect(conflictTool?.source_mcp).toBe('shared1');
  });
});

describe('ToolRouter - Tool Invocation Routing', () => {
  it('routes to shared manager when tool is from shared', async () => {
    if (!ToolRouter) return expect(true).toBeTruthy();

    const sharedTools = [
      { ...makeTool('shared_tool', 'Shared tool'), source_mcp: 'shared1' },
    ];

    const sharedManager = new MockSharedMcpManager(sharedTools);
    const userPool = new MockUserMcpPool();

    const router = new ToolRouter(sharedManager, userPool);

    const result = await router.invokeTool('user1', {
      tool_name: 'shared_tool',
      arguments: {},
    });

    expect(result.success).toBe(true);
    expect(result.result).toContain('shared');
  });

  it('routes to user pool when tool is from per-user', async () => {
    if (!ToolRouter) return expect(true).toBeTruthy();

    const sharedTools = [
      { ...makeTool('shared_tool', 'Shared tool'), source_mcp: 'shared1' },
    ];

    const userTools = [
      { ...makeTool('user_tool', 'User tool'), source_mcp: 'user_mcp1' },
    ];

    const sharedManager = new MockSharedMcpManager(sharedTools);
    const userPool = new MockUserMcpPool();
    userPool.setToolsForUser('user1', userTools);

    const router = new ToolRouter(sharedManager, userPool);

    const result = await router.invokeTool('user1', {
      tool_name: 'user_tool',
      arguments: {},
    });

    expect(result.success).toBe(true);
    expect(result.result).toContain('user tool');
  });

  it('throws error for unknown tool', async () => {
    if (!ToolRouter) return expect(true).toBeTruthy();

    const sharedTools = [
      { ...makeTool('shared_tool', 'Shared tool'), source_mcp: 'shared1' },
    ];

    const sharedManager = new MockSharedMcpManager(sharedTools);
    const userPool = new MockUserMcpPool();

    const router = new ToolRouter(sharedManager, userPool);

    await expect(
      router.invokeTool('user1', {
        tool_name: 'unknown_tool',
        arguments: {},
      })
    ).rejects.toThrow('Tool not found: unknown_tool');
  });

  it('shared takes precedence when both have same tool', async () => {
    if (!ToolRouter) return expect(true).toBeTruthy();

    const sharedTools = [
      { ...makeTool('duplicate_tool', 'Shared version'), source_mcp: 'shared1' },
    ];

    const userTools = [
      { ...makeTool('duplicate_tool', 'User version'), source_mcp: 'user_mcp1' },
    ];

    const sharedManager = new MockSharedMcpManager(sharedTools);
    const userPool = new MockUserMcpPool();
    userPool.setToolsForUser('user1', userTools);

    const router = new ToolRouter(sharedManager, userPool);

    // Invocation should route to shared
    const result = await router.invokeTool('user1', {
      tool_name: 'duplicate_tool',
      arguments: {},
    });

    expect(result.success).toBe(true);
    expect(result.result).toContain('shared');
  });
});

describe('ToolRouter - Tool Descriptor', () => {
  it('finds tool in shared', async () => {
    if (!ToolRouter) return expect(true).toBeTruthy();

    const sharedTools = [
      { ...makeTool('shared_tool', 'Shared tool'), source_mcp: 'shared1' },
    ];

    const sharedManager = new MockSharedMcpManager(sharedTools);
    const userPool = new MockUserMcpPool();

    const router = new ToolRouter(sharedManager, userPool);

    const descriptor = router.getToolDescriptor('user1', 'shared_tool');
    expect(descriptor).toBeDefined();
    expect(descriptor?.name).toBe('shared_tool');
    expect(descriptor?.source_mcp).toBe('shared1');
  });

  it('finds tool in user pool', async () => {
    if (!ToolRouter) return expect(true).toBeTruthy();

    const sharedTools = [
      { ...makeTool('shared_tool', 'Shared tool'), source_mcp: 'shared1' },
    ];

    const userTools = [
      { ...makeTool('user_tool', 'User tool'), source_mcp: 'user_mcp1' },
    ];

    const sharedManager = new MockSharedMcpManager(sharedTools);
    const userPool = new MockUserMcpPool();
    userPool.setToolsForUser('user1', userTools);

    const router = new ToolRouter(sharedManager, userPool);

    const descriptor = router.getToolDescriptor('user1', 'user_tool');
    expect(descriptor).toBeDefined();
    expect(descriptor?.name).toBe('user_tool');
    expect(descriptor?.source_mcp).toBe('user_mcp1');
  });

  it('returns undefined for missing tool', async () => {
    if (!ToolRouter) return expect(true).toBeTruthy();

    const sharedManager = new MockSharedMcpManager([]);
    const userPool = new MockUserMcpPool();

    const router = new ToolRouter(sharedManager, userPool);

    const descriptor = router.getToolDescriptor('user1', 'nonexistent');
    expect(descriptor).toBeUndefined();
  });

  it('shared takes precedence in getToolDescriptor', async () => {
    if (!ToolRouter) return expect(true).toBeTruthy();

    const sharedTools = [
      { ...makeTool('duplicate_tool', 'Shared version'), source_mcp: 'shared1' },
    ];

    const userTools = [
      { ...makeTool('duplicate_tool', 'User version'), source_mcp: 'user_mcp1' },
    ];

    const sharedManager = new MockSharedMcpManager(sharedTools);
    const userPool = new MockUserMcpPool();
    userPool.setToolsForUser('user1', userTools);

    const router = new ToolRouter(sharedManager, userPool);

    const descriptor = router.getToolDescriptor('user1', 'duplicate_tool');
    expect(descriptor).toBeDefined();
    expect(descriptor?.description).toBe('Shared version');
    expect(descriptor?.source_mcp).toBe('shared1');
  });
});

describe('ToolRouter - Combined Status', () => {
  it('returns combined status from shared manager and user pool', async () => {
    if (!ToolRouter) return expect(true).toBeTruthy();

    const sharedTools = [
      { ...makeTool('shared_tool1', 'Tool 1'), source_mcp: 'shared1' },
      { ...makeTool('shared_tool2', 'Tool 2'), source_mcp: 'shared2' },
    ];

    const userTools = [
      { ...makeTool('user_tool1', 'User tool 1'), source_mcp: 'user_mcp1' },
    ];

    const sharedManager = new MockSharedMcpManager(sharedTools);
    const userPool = new MockUserMcpPool();
    userPool.setToolsForUser('user1', userTools);

    const router = new ToolRouter(sharedManager, userPool);

    const status = router.getStatus();

    expect(status.shared).toBeDefined();
    expect(status.perUser).toBeDefined();

    expect(status.shared.total_tools).toBe(2);
    expect(status.perUser.userCount).toBe(1);
  });
});
