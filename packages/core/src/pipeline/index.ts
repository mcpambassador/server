/**
 * AAA Pipeline Orchestrator
 * 
 * Coordinates Authentication → Authorization → Audit → Tool Routing → Audit.
 * 
 * @see Architecture §4 AAA Pipeline Architecture
 * @see Architecture §4.2 Pipeline Failure Behavior
 */

import { v4 as uuidv4 } from 'uuid';
import type {
  AuthenticationProvider,
  AuthorizationProvider,
  AuditProvider,
  SessionContext,
  AuthRequest,
  AuthzRequest,
} from '../spi/index.js';
import type {
  ToolInvocationRequest,
  ToolInvocationResponse,
  AuditEvent,
  Severity,
  EventType,
} from '@mcpambassador/protocol';
import { logger } from '../utils/logger.js';
import {
  AuthenticationError,
  AuthorizationError,
  ServiceUnavailableError,
  ValidationError,
} from '../utils/errors.js';

/**
 * Pipeline configuration
 */
export interface PipelineConfig {
  /** Audit failure behavior: 'block' (fail-closed) or 'buffer' (fail-open) */
  audit_on_failure: 'block' | 'buffer';
}

/**
 * AAA Pipeline orchestrator
 * 
 * Fail-closed by default for all providers (§4.2).
 */
export class Pipeline {
  private config: PipelineConfig;

  constructor(
    private authn: AuthenticationProvider,
    private authz: AuthorizationProvider,
    private audit: AuditProvider,
    config?: Partial<PipelineConfig>
  ) {
    this.config = {
      audit_on_failure: config?.audit_on_failure || 'buffer',
    };
  }

  /**
   * Process tool invocation through AAA pipeline
   * 
   * Flow: AuthN → AuthZ → Audit → Route → Audit
   * 
   * @param request Tool invocation request
   * @param authRequest Authentication request context
   * @param router Optional routing function to invoke downstream MCP (M6 injection)
   * @returns Tool invocation response
   * @throws AuthenticationError, AuthorizationError, ServiceUnavailableError
   */
  async invoke(
    request: ToolInvocationRequest,
    authRequest: AuthRequest,
    router?: (toolName: string, args: Record<string, unknown>) => Promise<{ content: unknown; isError?: boolean; mcpServer?: string }>
  ): Promise<ToolInvocationResponse> {
    // F-SEC-M3-012: Input validation
    if (!request.tool_name || !request.client_id) {
      throw new ValidationError('Missing required fields: tool_name and client_id');
    }
    if (typeof request.tool_name !== 'string' || typeof request.client_id !== 'string') {
      throw new ValidationError('tool_name and client_id must be strings');
    }
    
    const startTime = Date.now();
    let session: SessionContext | undefined;

    try {
      // ===== Stage 1: Authentication =====
      logger.debug(`[pipeline] AuthN: client_id=${request.client_id}`);
      
      const authResult = await this.authn.authenticate(authRequest);
      
      if (!authResult.success || !authResult.session) {
        // AuthN failure — audit and reject
        await this.emitAuditEvent({
          event_id: uuidv4(),
          timestamp: new Date().toISOString(),
          event_type: 'auth_failure',
          severity: 'warn',
          session_id: 'anonymous',
          client_id: request.client_id,
          auth_method: this.authn.id,
          source_ip: authRequest.sourceIp,
          action: 'authentication',
          authz_decision: undefined,
          request_summary: { tool_name: request.tool_name },
        });
        
        throw new AuthenticationError(
          authResult.error?.message || 'Authentication failed'
        );
      }
      
      session = authResult.session;
      
      // Log successful auth
      await this.emitAuditEvent({
        event_id: uuidv4(),
        timestamp: new Date().toISOString(),
        event_type: 'auth_success',
        severity: 'info',
        session_id: session.session_id,
        client_id: session.client_id,
        user_id: session.user_id,
        auth_method: session.auth_method,
        source_ip: authRequest.sourceIp,
        action: 'authentication',
        authz_decision: undefined,
      });

      // ===== Stage 2: Authorization =====
      logger.debug(`[pipeline] AuthZ: tool=${request.tool_name}, client=${session.client_id}`);
      
      const authzRequest: AuthzRequest = {
        tool_name: request.tool_name,
        tool_arguments: request.arguments,
      };
      
      const authzDecision = await this.authz.authorize(session, authzRequest);
      
      // Log authz decision
      await this.emitAuditEvent({
        event_id: uuidv4(),
        timestamp: new Date().toISOString(),
        event_type: authzDecision.decision === 'permit' ? 'authz_permit' : 'authz_deny',
        severity: authzDecision.decision === 'deny' ? 'warn' : 'info',
        session_id: session.session_id,
        client_id: session.client_id,
        user_id: session.user_id,
        auth_method: session.auth_method,
        source_ip: authRequest.sourceIp,
        action: 'authorization',
        tool_name: request.tool_name,
        authz_decision: authzDecision.decision,
        authz_policy: authzDecision.policy_id,
        request_summary: { reason: authzDecision.reason },
      });
      
      if (authzDecision.decision === 'deny') {
        throw new AuthorizationError(authzDecision.reason);
      }

      // ===== Stage 3: Tool Routing (M6) =====
      logger.debug(`[pipeline] Route: tool=${request.tool_name}`);
      
      let response: ToolInvocationResponse;
      const requestId = uuidv4();
      
      if (!router) {
        // No router provided - return error
        response = {
          result: null,
          request_id: requestId,
          timestamp: new Date().toISOString(),
          metadata: {
            error: 'Router not configured',
          },
        };
      } else {
        try {
          // Route to downstream MCP
          const mcpResponse = await router(request.tool_name, request.arguments);
          
          response = {
            result: mcpResponse.content,
            request_id: requestId,
            timestamp: new Date().toISOString(),
            metadata: {
              duration_ms: Date.now() - startTime,
              mcp_server: mcpResponse.mcpServer,
              is_error: mcpResponse.isError,
            },
          };
        } catch (routingError) {
          // Tool routing failed
          logger.error(`[pipeline] Routing error: ${routingError}`);
          response = {
            result: null,
            request_id: requestId,
            timestamp: new Date().toISOString(),
            metadata: {
              duration_ms: Date.now() - startTime,
              error: routingError instanceof Error ? routingError.message : String(routingError),
            },
          };
        }
      }

      // ===== Stage 4: Audit Tool Invocation =====
      const duration = Date.now() - startTime;
      const hasError = response.metadata?.error || response.metadata?.is_error;
      
      await this.emitAuditEvent({
        event_id: uuidv4(),
        timestamp: new Date().toISOString(),
        event_type: hasError ? 'tool_error' : 'tool_invocation',
        severity: hasError ? 'error' : 'info',
        session_id: session.session_id,
        client_id: session.client_id,
        user_id: session.user_id,
        auth_method: session.auth_method,
        source_ip: authRequest.sourceIp,
        action: 'tool_invocation',
        tool_name: request.tool_name,
        authz_decision: 'permit',
        response_summary: {
          status: hasError ? 'error' : 'success',
          duration_ms: duration,
        },
        metadata: hasError ? { error: response.metadata?.error } : undefined,
      });

      return response;
    } catch (error) {
      // F-SEC-M3-010: Only emit pipeline_error audit event if NOT already emitted by AuthN/AuthZ
      // AuthenticationError and AuthorizationError have already logged specific audit events
      if (!(error instanceof AuthenticationError) && !(error instanceof AuthorizationError)) {
        const duration = Date.now() - startTime;
        await this.emitAuditEvent({
          event_id: uuidv4(),
          timestamp: new Date().toISOString(),
          event_type: 'tool_error',
          severity: 'error',
          session_id: session?.session_id || 'anonymous',
          client_id: request.client_id,
          user_id: session?.user_id,
          auth_method: session?.auth_method || 'unknown',
          source_ip: authRequest.sourceIp,
          action: 'pipeline_error',
          tool_name: request.tool_name,
          authz_decision: undefined,
          response_summary: {
            status: 'error',
            duration_ms: duration,
          },
          metadata: {
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }

      throw error;
    }
  }

  /**
   * Emit audit event with failure handling
   * 
   * Per §4.2: Audit failure can be fail-closed (block) or fail-open (buffer).
   */
  private async emitAuditEvent(event: AuditEvent): Promise<void> {
    try {
      await this.audit.emit(event);
    } catch (error) {
      logger.error('[pipeline] Audit emit failed:', error);
      
      if (this.config.audit_on_failure === 'block') {
        // Fail closed — block the request
        throw new ServiceUnavailableError('Audit system unavailable');
      } else {
        // Fail open — log warning and continue
        logger.warn('[pipeline] Audit failure in buffer mode - request continues');
      }
    }
  }

  /**
   * Health check for all pipeline components
   */
  async healthCheck(): Promise<{
    authn: string;
    authz: string;
    audit: string;
  }> {
    const [authnHealth, authzHealth, auditHealth] = await Promise.all([
      this.authn.healthCheck(),
      this.authz.healthCheck(),
      this.audit.healthCheck(),
    ]);

    return {
      authn: authnHealth.status,
      authz: authzHealth.status,
      audit: auditHealth.status,
    };
  }
}

