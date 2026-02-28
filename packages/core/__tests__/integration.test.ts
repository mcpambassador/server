/**
 * M6.8 Integration Tests - AAA Pipeline End-to-End
 *
 * Tests complete AAA pipeline flow with mock MCP server:
 * - Client authentication (API key)
 * - Authorization checks (tool profile matching)
 * - Tool argument validation (M6.7)
 * - Tool invocation routing
 * - Audit event generation
 *
 * Unlike the Docker-based E2E tests in packages/server/tests/e2e/,
 * these tests run in-process with mock providers to validate
 * the core pipeline logic independently.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Pipeline, type PipelineToolInvocationRequest } from '../src/pipeline/index.js';
import type {
  AuthenticationProvider,
  AuthorizationProvider,
  AuditProvider,
  SessionContext,
  AuthRequest,
  AuthResult,
  AuthzRequest,
  AuthzDecision,
} from '../src/spi/index.js';
import type { AuditEvent, ToolDescriptor } from '@mcpambassador/protocol';
import type { ToolSchema } from '../src/validation/index.js';

/**
 * Mock Authentication Provider
 *
 * Simulates API key authentication for test clients.
 */
class TestAuthProvider implements AuthenticationProvider {
  readonly id = 'test_auth';

  private validKeys = new Map<string, SessionContext>([
    [
      'valid-api-key',
      {
        session_id: 'sess-123',
        client_id: 'client-abc',
        user_id: 'user-1',
        auth_method: 'api_key',
        groups: ['eng-profile'],
        attributes: {},
        issued_at: Math.floor(Date.now() / 1000),
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      },
    ],
  ]);

  async initialize(): Promise<void> {}

  async authenticate(request: AuthRequest): Promise<AuthResult> {
    const apiKey = request.headers['x-api-key'];

    const session = this.validKeys.get(apiKey || '');
    if (session) {
      return { success: true, session };
    }

    return {
      success: false,
      error: { code: 'invalid_credentials', message: 'Invalid API key', provider: 'test_auth' },
    };
  }

  async healthCheck(): Promise<{
    status: 'healthy' | 'degraded' | 'unhealthy';
    last_checked: string;
  }> {
    return { status: 'healthy', last_checked: new Date().toISOString() };
  }
}

/**
 * Mock Authorization Provider
 *
 * Simulates tool profile matching. Allows all tools in "eng-profile",
 * denies all others.
 */
class TestAuthzProvider implements AuthorizationProvider {
  readonly id = 'test_authz';

  private allowedTools = new Set([
    'filesystem.read_file',
    'filesystem.write_file',
    'github.search_code',
  ]);

  async initialize(): Promise<void> {}

  async authorize(session: SessionContext, request: AuthzRequest): Promise<AuthzDecision> {
    // Check if tool is in allowed list for this profile
    if (session.groups.includes('eng-profile') && this.allowedTools.has(request.tool_name)) {
      return {
        decision: 'permit',
        policy_id: 'eng-profile',
        reason: 'Tool allowed by eng-profile',
      };
    }

    return {
      decision: 'deny',
      policy_id: session.groups[0] || 'unknown',
      reason: `Tool ${request.tool_name} not in allowed list`,
    };
  }

  async listAuthorizedTools(
    session: SessionContext,
    allTools: ToolDescriptor[]
  ): Promise<ToolDescriptor[]> {
    // Return only tools that are in the allowed list
    return allTools.filter(tool => this.allowedTools.has(tool.name));
  }

  async healthCheck(): Promise<{
    status: 'healthy' | 'degraded' | 'unhealthy';
    last_checked: string;
  }> {
    return { status: 'healthy', last_checked: new Date().toISOString() };
  }
}

/**
 * Mock Audit Provider
 *
 * Captures audit events in memory for assertion.
 */
class TestAuditProvider implements AuditProvider {
  readonly id = 'test_audit';

  events: AuditEvent[] = [];

  async initialize(): Promise<void> {}

  async emit(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }

  async flush(): Promise<void> {}

  async healthCheck(): Promise<{
    status: 'healthy' | 'degraded' | 'unhealthy';
    last_checked: string;
  }> {
    return { status: 'healthy', last_checked: new Date().toISOString() };
  }

  reset() {
    this.events = [];
  }
}

/**
 * Mock Tool Router
 *
 * Simulates downstream MCP server responses.
 */
class MockToolRouter {
  async route(tool_name: string, args: Record<string, unknown>) {
    // Simulate successful tool invocation
    if (tool_name === 'filesystem.read_file') {
      return {
        content: [`File contents: ${args.path}`],
        mcpServer: 'mock-mcp',
        isError: false,
      };
    }

    if (tool_name === 'github.search_code') {
      return {
        content: [`Found 5 results for: ${args.query}`],
        mcpServer: 'mock-github-mcp',
        isError: false,
      };
    }

    return {
      content: null,
      isError: true,
      mcpServer: 'unknown',
    };
  }
}

/**
 * Test Fixtures
 */
const validAuthRequest = (): AuthRequest => ({
  headers: { 'x-api-key': 'valid-api-key' },
  sourceIp: '127.0.0.1',
});

const invalidAuthRequest = (): AuthRequest => ({
  headers: { 'x-api-key': 'invalid-key' },
  sourceIp: '127.0.0.1',
});

const testToolSchema: ToolSchema = {
  name: 'filesystem.read_file',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', maxLength: 1000 },
    },
    required: ['path'],
  },
};

// =============================================================================
// INTEGRATION TESTS
// =============================================================================

describe('AAA Pipeline Integration (M6.8)', () => {
  let authn: TestAuthProvider;
  let authz: TestAuthzProvider;
  let audit: TestAuditProvider;
  let pipeline: Pipeline;
  let router: MockToolRouter;

  beforeEach(() => {
    authn = new TestAuthProvider();
    authz = new TestAuthzProvider();
    audit = new TestAuditProvider();
    pipeline = new Pipeline(authn, authz, audit, { audit_on_failure: 'buffer' });
    router = new MockToolRouter();

    audit.reset();
  });

  // ===========================================================================
  // AUTHENTICATION TESTS
  // ===========================================================================

  describe('Authentication', () => {
    it('should authenticate valid API key', async () => {
      const request: PipelineToolInvocationRequest = {
        tool_name: 'filesystem.read_file',
        client_id: 'client-abc',
        arguments: { path: '/tmp/test.txt' },
      };

      const response = await pipeline.invoke(
        request,
        validAuthRequest(),
        router.route.bind(router),
        testToolSchema
      );

      expect(response.result).toBeDefined();
      expect(response.request_id).toBeDefined();

      // Check audit events
      const authSuccess = audit.events.find(e => (e.event_type as string) === 'auth_success');
      expect(authSuccess).toBeDefined();
      expect(authSuccess?.client_id).toBe('client-abc');
    });

    it('should reject invalid API key', async () => {
      const request: PipelineToolInvocationRequest = {
        tool_name: 'filesystem.read_file',
        client_id: 'client-abc',
        arguments: { path: '/tmp/test.txt' },
      };

      await expect(
        pipeline.invoke(request, invalidAuthRequest(), router.route.bind(router))
      ).rejects.toThrow('Invalid API key');

      // Check audit events
      const authFailure = audit.events.find(e => (e.event_type as string) === 'auth_failure');
      expect(authFailure).toBeDefined();
      expect(authFailure?.severity).toBe('warn');
    });
  });

  // ===========================================================================
  // AUTHORIZATION TESTS
  // ===========================================================================

  describe('Authorization', () => {
    it('should permit allowed tool', async () => {
      const request: PipelineToolInvocationRequest = {
        tool_name: 'filesystem.read_file',
        client_id: 'client-abc',
        arguments: { path: '/tmp/test.txt' },
      };

      const response = await pipeline.invoke(
        request,
        validAuthRequest(),
        router.route.bind(router),
        testToolSchema
      );

      expect(response.result).toBeDefined();

      // Check audit events
      const authzPermit = audit.events.find(e => (e.event_type as string) === 'authz_permit');
      expect(authzPermit).toBeDefined();
      expect(authzPermit?.authz_decision).toBe('permit');
      expect(authzPermit?.authz_policy).toBe('eng-profile');
    });

    it('should deny disallowed tool', async () => {
      const request: PipelineToolInvocationRequest = {
        tool_name: 'database.execute_query', // Not in allowed list
        client_id: 'client-abc',
        arguments: { query: 'SELECT * FROM users' },
      };

      await expect(
        pipeline.invoke(request, validAuthRequest(), router.route.bind(router))
      ).rejects.toThrow('not in allowed list');

      // Check audit events
      const authzDeny = audit.events.find(e => (e.event_type as string) === 'authz_deny');
      expect(authzDeny).toBeDefined();
      expect(authzDeny?.authz_decision).toBe('deny');
      expect(authzDeny?.severity).toBe('warn');
    });
  });

  // ===========================================================================
  // VALIDATION TESTS (M6.7)
  // ===========================================================================

  describe('Argument Validation', () => {
    it('should validate and pass correct arguments', async () => {
      const request: PipelineToolInvocationRequest = {
        tool_name: 'filesystem.read_file',
        client_id: 'client-abc',
        arguments: { path: '/tmp/test.txt' },
      };

      const response = await pipeline.invoke(
        request,
        validAuthRequest(),
        router.route.bind(router),
        testToolSchema
      );

      expect(response.result).toBeDefined();

      // Should have invoked tool successfully
      const toolEvent = audit.events.find(e => (e.event_type as string) === 'tool_invocation');
      expect(toolEvent).toBeDefined();
      expect(toolEvent?.tool_name).toBe('filesystem.read_file');
    });

    it('should reject missing required argument', async () => {
      const request: PipelineToolInvocationRequest = {
        tool_name: 'filesystem.read_file',
        client_id: 'client-abc',
        arguments: {}, // Missing 'path'
      };

      await expect(
        pipeline.invoke(request, validAuthRequest(), router.route.bind(router), testToolSchema)
      ).rejects.toThrow('Missing required argument');

      // Check validation failure audit event
      const validationError = audit.events.find(e => e.action === 'validation');
      expect(validationError).toBeDefined();
      expect(validationError?.severity).toBe('warn');
    });

    it('should reject argument with wrong type', async () => {
      const request: PipelineToolInvocationRequest = {
        tool_name: 'filesystem.read_file',
        client_id: 'client-abc',
        arguments: { path: 12345 }, // Should be string
      };

      await expect(
        pipeline.invoke(request, validAuthRequest(), router.route.bind(router), testToolSchema)
      ).rejects.toThrow('Type mismatch');
    });

    it('should reject argument exceeding max length', async () => {
      const request: PipelineToolInvocationRequest = {
        tool_name: 'filesystem.read_file',
        client_id: 'client-abc',
        arguments: { path: 'x'.repeat(1001) }, // Exceeds maxLength: 1000
      };

      await expect(
        pipeline.invoke(request, validAuthRequest(), router.route.bind(router), testToolSchema)
      ).rejects.toThrow('exceeds maximum length');
    });

    it('should reject disallowed patterns', async () => {
      const schemaWithRestrictions: ToolSchema = {
        name: 'filesystem.read_file',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
          },
          required: ['path'],
        },
      };

      const request: PipelineToolInvocationRequest = {
        tool_name: 'filesystem.read_file',
        client_id: 'client-abc',
        arguments: { path: '/tmp/$(whoami)' }, // Command injection attempt
      };

      await expect(
        pipeline.invoke(
          request,
          validAuthRequest(),
          router.route.bind(router),
          schemaWithRestrictions,
          { disallow_patterns: ['\\$\\(', '`'] } // ReDoS-protected patterns
        )
      ).rejects.toThrow('disallowed pattern');
    });
  });

  // ===========================================================================
  // TOOL INVOCATION TESTS
  // ===========================================================================

  describe('Tool Invocation', () => {
    it('should invoke tool and return result', async () => {
      const request: PipelineToolInvocationRequest = {
        tool_name: 'github.search_code',
        client_id: 'client-abc',
        arguments: { query: 'authentication' },
      };

      const githubSchema: ToolSchema = {
        name: 'github.search_code',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', maxLength: 500 },
          },
          required: ['query'],
        },
      };

      const response = await pipeline.invoke(
        request,
        validAuthRequest(),
        router.route.bind(router),
        githubSchema
      );

      expect(response.result).toEqual(['Found 5 results for: authentication']);
      expect(response.metadata?.mcp_server).toBe('mock-github-mcp');

      // Check audit trail
      const toolEvent = audit.events.find(e => (e.event_type as string) === 'tool_invocation');
      expect(toolEvent).toBeDefined();
      expect(toolEvent?.tool_name).toBe('github.search_code');
      expect(toolEvent?.metadata).toBeUndefined(); // No error
    });

    it('should record tool invocation duration', async () => {
      const request: PipelineToolInvocationRequest = {
        tool_name: 'filesystem.read_file',
        client_id: 'client-abc',
        arguments: { path: '/tmp/test.txt' },
      };

      const response = await pipeline.invoke(
        request,
        validAuthRequest(),
        router.route.bind(router),
        testToolSchema
      );

      expect(response.metadata?.duration_ms).toBeGreaterThanOrEqual(0);

      // Check audit event has duration
      const toolEvent = audit.events.find(e => (e.event_type as string) === 'tool_invocation');
      expect(toolEvent?.response_summary?.duration_ms).toBeGreaterThanOrEqual(0);
    });
  });

  // ===========================================================================
  // AUDIT TRAIL TESTS
  // ===========================================================================

  describe('Audit Trail', () => {
    it('should generate complete audit trail for successful request', async () => {
      const request: PipelineToolInvocationRequest = {
        tool_name: 'filesystem.read_file',
        client_id: 'client-abc',
        arguments: { path: '/tmp/test.txt' },
      };

      await pipeline.invoke(request, validAuthRequest(), router.route.bind(router), testToolSchema);

      // Should have: auth_success, authz_permit, tool_invocation
      expect(audit.events.length).toBeGreaterThanOrEqual(3);

      const eventTypes = audit.events.map(e => e.event_type as string);
      expect(eventTypes).toContain('auth_success');
      expect(eventTypes).toContain('authz_permit');
      expect(eventTypes).toContain('tool_invocation');
    });

    it('should generate audit trail for authentication failure', async () => {
      const request: PipelineToolInvocationRequest = {
        tool_name: 'filesystem.read_file',
        client_id: 'client-abc',
        arguments: { path: '/tmp/test.txt' },
      };

      await expect(
        pipeline.invoke(request, invalidAuthRequest(), router.route.bind(router))
      ).rejects.toThrow();

      // Should have auth_failure event
      const authFailure = audit.events.find(e => (e.event_type as string) === 'auth_failure');
      expect(authFailure).toBeDefined();
      expect(authFailure?.client_id).toBe('client-abc');
      expect(authFailure?.source_ip).toBe('127.0.0.1');
    });

    it('should generate audit trail for authorization denial', async () => {
      const request: PipelineToolInvocationRequest = {
        tool_name: 'database.execute_query',
        client_id: 'client-abc',
        arguments: { query: 'SELECT * FROM users' },
      };

      await expect(
        pipeline.invoke(request, validAuthRequest(), router.route.bind(router))
      ).rejects.toThrow();

      // Should have auth_success and authz_deny
      expect(audit.events.some(e => (e.event_type as string) === 'auth_success')).toBe(true);
      expect(audit.events.some(e => (e.event_type as string) === 'authz_deny')).toBe(true);
    });

    it('should include session context in all audit events', async () => {
      const request: PipelineToolInvocationRequest = {
        tool_name: 'filesystem.read_file',
        client_id: 'client-abc',
        arguments: { path: '/tmp/test.txt' },
      };

      await pipeline.invoke(request, validAuthRequest(), router.route.bind(router), testToolSchema);

      // All events after auth should have session context
      const authedEvents = audit.events.filter(e => (e.event_type as string) !== 'auth_failure');
      for (const event of authedEvents) {
        expect(event.session_id).toBeDefined();
        expect(event.client_id).toBe('client-abc');
        expect(event.user_id).toBeDefined();
        expect(event.auth_method).toBeDefined();
      }
    });
  });
});
