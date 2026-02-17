/**
 * Pipeline tests
 *
 * Tests AAA pipeline orchestration with mock providers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Pipeline } from '../src/pipeline/index.js';
import type {
  AuthenticationProvider,
  AuthorizationProvider,
  AuditProvider,
  ProviderHealth,
  AuthRequest,
  AuthResult,
  SessionContext,
  AuthzRequest,
  AuthzDecision,
} from '../src/spi/index.js';
import type { ToolInvocationRequest, AuditEvent } from '@mcpambassador/protocol';

// Mock providers
class MockAuthenticationProvider implements AuthenticationProvider {
  id = 'mock-authn';
  shouldSucceed = true;

  async initialize(config: Record<string, unknown>): Promise<void> {
    // No-op
  }

  async authenticate(request: AuthRequest): Promise<AuthResult> {
    if (this.shouldSucceed) {
      return {
        success: true,
        session: {
          session_id: 'sess-123',
          client_id: 'client-456',
          user_id: 'user-789',
          auth_method: 'api_key',
          groups: ['developers'],
          attributes: {},
          issued_at: Date.now() / 1000,
          expires_at: (Date.now() + 3600000) / 1000,
        },
      };
    } else {
      return {
        success: false,
        error: {
          code: 'invalid_credentials',
          message: 'Authentication failed',
          provider: 'mock-authn',
        },
      };
    }
  }

  async healthCheck(): Promise<ProviderHealth> {
    return {
      status: 'healthy',
      message: 'Mock provider is healthy',
      last_checked: new Date().toISOString(),
    };
  }
}

class MockAuthorizationProvider implements AuthorizationProvider {
  id = 'mock-authz';
  shouldPermit = true;

  async initialize(config: Record<string, unknown>): Promise<void> {
    // No-op
  }

  async authorize(session: SessionContext, request: AuthzRequest): Promise<AuthzDecision> {
    if (this.shouldPermit) {
      return {
        decision: 'permit',
        reason: 'User is authorized',
        policy_id: 'test-policy',
      };
    } else {
      return {
        decision: 'deny',
        reason: 'Tool not in allowed list',
        policy_id: 'test-policy',
      };
    }
  }

  async listAuthorizedTools() {
    return [];
  }

  async healthCheck(): Promise<ProviderHealth> {
    return {
      status: 'healthy',
      message: 'Mock provider is healthy',
      last_checked: new Date().toISOString(),
    };
  }
}

class MockAuditProvider implements AuditProvider {
  id = 'mock-audit';
  events: AuditEvent[] = [];
  shouldFail = false;

  async initialize(config: Record<string, unknown>): Promise<void> {
    // No-op
  }

  async emit(event: AuditEvent): Promise<void> {
    if (this.shouldFail) {
      throw new Error('Audit emit failed');
    }
    this.events.push(event);
  }

  async flush(): Promise<void> {
    // No-op
  }

  async healthCheck(): Promise<ProviderHealth> {
    return {
      status: 'healthy',
      message: 'Mock provider is healthy',
      last_checked: new Date().toISOString(),
    };
  }
}

describe('Pipeline', () => {
  let authn: MockAuthenticationProvider;
  let authz: MockAuthorizationProvider;
  let audit: MockAuditProvider;
  let pipeline: Pipeline;

  beforeEach(() => {
    authn = new MockAuthenticationProvider();
    authz = new MockAuthorizationProvider();
    audit = new MockAuditProvider();
    pipeline = new Pipeline(authn, authz, audit, { audit_on_failure: 'buffer' });
  });

  it('should succeed with valid authentication and authorization', async () => {
    const request: ToolInvocationRequest = {
      client_id: 'client-456',
      tool_name: 'github.search_code',
      arguments: { query: 'auth' },
    };

    const authRequest: AuthRequest = {
      headers: {
        'x-api-key': 'test-key',
        'x-client-id': 'client-456',
      },
      sourceIp: '127.0.0.1',
    };

    const response = await pipeline.invoke(request, authRequest);

    // Should return placeholder response (M6 not implemented yet)
    expect(response.success).toBe(false);
    expect(response.error?.code).toBe('not_implemented');

    // Verify audit events
    expect(audit.events.length).toBeGreaterThan(0);
    const authSuccessEvent = audit.events.find(e => e.event_type === 'auth_success');
    expect(authSuccessEvent).toBeDefined();

    const authzPermitEvent = audit.events.find(e => e.event_type === 'authz_permit');
    expect(authzPermitEvent).toBeDefined();
  });

  it('should fail with invalid authentication', async () => {
    authn.shouldSucceed = false;

    const request: ToolInvocationRequest = {
      client_id: 'client-456',
      tool_name: 'github.search_code',
      arguments: {},
    };

    const authRequest: AuthRequest = {
      headers: {},
      sourceIp: '127.0.0.1',
    };

    await expect(pipeline.invoke(request, authRequest)).rejects.toThrow('Authentication failed');

    // Verify auth_failure audit event
    const authFailureEvent = audit.events.find(e => e.event_type === 'auth_failure');
    expect(authFailureEvent).toBeDefined();
  });

  it('should fail with authorization denial', async () => {
    authz.shouldPermit = false;

    const request: ToolInvocationRequest = {
      client_id: 'client-456',
      tool_name: 'github.create_repo',
      arguments: {},
    };

    const authRequest: AuthRequest = {
      headers: {
        'x-api-key': 'test-key',
      },
      sourceIp: '127.0.0.1',
    };

    await expect(pipeline.invoke(request, authRequest)).rejects.toThrow('not in allowed list');

    // Verify authz_deny audit event
    const authzDenyEvent = audit.events.find(e => e.event_type === 'authz_deny');
    expect(authzDenyEvent).toBeDefined();
  });

  it('should continue in buffer mode when audit fails', async () => {
    audit.shouldFail = true;

    const request: ToolInvocationRequest = {
      client_id: 'client-456',
      tool_name: 'github.search_code',
      arguments: {},
    };

    const authRequest: AuthRequest = {
      headers: {
        'x-api-key': 'test-key',
      },
      sourceIp: '127.0.0.1',
    };

    // Should not throw despite audit failures
    await expect(pipeline.invoke(request, authRequest)).resolves.toBeDefined();
  });

  it('should perform health check on all providers', async () => {
    const health = await pipeline.healthCheck();

    expect(health.authn).toBe('healthy');
    expect(health.authz).toBe('healthy');
    expect(health.audit).toBe('healthy');
  });
});
