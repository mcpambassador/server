/**
 * Service Provider Interface (SPI) definitions
 *
 * Defines interfaces that all Authentication, Authorization, and Audit providers must implement.
 * Enables pluggable AAA modules per Architecture §5.
 *
 * @see Architecture §5 Service Provider Interface (SPI)
 * @see ADR-002 Pluggable AAA Module Architecture
 */

import type { AuditEvent, ToolDescriptor } from '@mcpambassador/protocol';

// ===== §5.1 Authentication SPI =====

/**
 * Authentication Provider Interface
 *
 * Implementations: ApiKeyAuthProvider (M4), JwtAuthProvider (Phase 2),
 *                  OidcAuthProvider (Phase 2), SamlAuthProvider (Phase 2),
 *                  MtlsAuthProvider (Phase 3)
 *
 * @see Architecture §5.1
 */
export interface AuthenticationProvider extends ProviderLifecycle {
  /** Unique provider identifier (e.g., "api_key", "oidc", "saml") */
  readonly id: string;

  /** Validate incoming request and return authenticated session */
  authenticate(request: AuthRequest): Promise<AuthResult>;

  /** Refresh existing session (optional, for token-based providers) */
  refresh?(refreshToken: string): Promise<AuthResult>;

  /** Revoke session or token (optional) */
  revoke?(sessionId: string): Promise<void>;
}

/**
 * Authentication request context
 */
export interface AuthRequest {
  /** HTTP headers (Authorization, X-API-Key, X-Client-Id, etc.) */
  headers: Record<string, string>;
  /** Client TLS certificate (for mTLS) */
  clientCert?: TlsCertificate;
  /** Source IP address */
  sourceIp: string;
}

/**
 * TLS certificate info for mTLS authentication
 */
export interface TlsCertificate {
  subject: string;
  issuer: string;
  fingerprint: string;
  validFrom: string;
  validTo: string;
}

/**
 * Authentication result
 */
export interface AuthResult {
  success: boolean;
  session?: SessionContext;
  error?: AuthError;
}

/**
 * Authentication error details (logged to audit, never exposed to client)
 */
export interface AuthError {
  code: string;
  message: string;
  provider: string;
  details?: Record<string, unknown>;
}

/**
 * Session context (created by AuthN, consumed by AuthZ)
 */
export interface SessionContext {
  /** Server-generated session UUID */
  session_id: string;
  /** Client ID from database */
  client_id: string;
  /** Linked user ID (null in Community API-key mode) */
  user_id?: string;
  /** Which provider authenticated this session */
  auth_method: string;
  /** User's groups (from IdP or local database) */
  groups: string[];
  /** Additional claims/attributes (IdP-specific) */
  attributes: Record<string, string>;
  /** Unix timestamp (seconds) */
  issued_at: number;
  /** Unix timestamp (seconds) */
  expires_at: number;
}

// ===== §5.2 Authorization SPI =====

/**
 * Authorization Provider Interface
 *
 * Implementations: LocalRbacProvider (M5), LdapAuthzProvider (Phase 2),
 *                  OpaAuthzProvider (Phase 3)
 *
 * @see Architecture §5.2
 */
export interface AuthorizationProvider extends ProviderLifecycle {
  /** Unique provider identifier (e.g., "local_rbac", "ldap", "opa") */
  readonly id: string;

  /** Check if session is authorized to invoke given tool */
  authorize(session: SessionContext, request: AuthzRequest): Promise<AuthzDecision>;

  /** Return full list of tools this session is authorized to use */
  listAuthorizedTools(
    session: SessionContext,
    allTools: ToolDescriptor[]
  ): Promise<ToolDescriptor[]>;
}

/**
 * Authorization request context
 */
export interface AuthzRequest {
  /** Fully qualified tool name (e.g., "github.search_code") */
  tool_name: string;
  /** Tool arguments (for argument-level policies in Phase 2+) */
  tool_arguments: Record<string, unknown>;
  /** Additional context (environment scope, time restrictions, etc.) */
  resource_context?: Record<string, string>;
}

/**
 * Authorization decision
 */
export interface AuthzDecision {
  /** Authorization decision */
  decision: 'permit' | 'deny' | 'conditional';
  /** Human-readable reason */
  reason: string;
  /** Policy ID that made this decision */
  policy_id?: string;
  /** Conditions for 'conditional' decisions (Phase 2) */
  conditions?: AuthzCondition[];
}

/**
 * Authorization condition (Phase 2 - argument transformations)
 */
export interface AuthzCondition {
  /** Condition type (e.g., "read_only", "redact_fields", "inject_param") */
  type: string;
  /** Condition-specific parameters */
  parameters: Record<string, unknown>;
}

// ===== §5.3 Audit SPI =====

/**
 * Audit Provider Interface
 *
 * Implementations: FileAuditProvider (M5), DatabaseAuditProvider (Phase 2),
 *                  SyslogAuditProvider (Phase 2), SiemAuditProvider (Phase 3)
 *
 * @see Architecture §5.3
 */
export interface AuditProvider extends ProviderLifecycle {
  /** Unique provider identifier (e.g., "file", "database", "syslog") */
  readonly id: string;

  /** Emit single audit event */
  emit(event: AuditEvent): Promise<void>;

  /** Emit batch of events (optional, for buffered providers) */
  emitBatch?(events: AuditEvent[]): Promise<void>;

  /** Flush any buffered events */
  flush(): Promise<void>;

  /** Query audit events (optional, for queryable providers) */
  query?(filters: AuditQueryFilters): Promise<AuditEvent[]>;
}

/**
 * Audit query filters
 */
export interface AuditQueryFilters {
  start_time?: string;
  end_time?: string;
  client_id?: string;
  user_id?: string;
  event_type?: string;
  severity?: string;
  limit?: number;
  cursor?: string;
}

// ===== §5.4 Common Provider Types =====

/**
 * Provider health status
 */
export interface ProviderHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  message?: string;
  latency_ms?: number;
  last_checked: string;
}

/**
 * Provider lifecycle interface (all providers must implement)
 */
export interface ProviderLifecycle {
  /** Initialize provider with configuration */
  initialize(config: Record<string, unknown>): Promise<void>;

  /** Health check */
  healthCheck(): Promise<ProviderHealth>;

  /** Shutdown gracefully (optional) */
  shutdown?(): Promise<void>;
}
