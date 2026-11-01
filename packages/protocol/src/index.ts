/**
 * @mcpambassador/protocol
 *
 * Type-only package defining the API contract between Ambassador Client and Server.
 * Zero runtime dependencies. Follows semver for API versioning.
 *
 * SCOPE: this package describes the CLIENT-PORT (8443) wire format only —
 * /v1/sessions/*, /v1/tools, /v1/tools/invoke. Error replies on 8443 are flat
 * `{ error: string, message: string }` (see ErrorResponse).
 * The ADMIN/SPA API (9443) uses the `{ ok, data } | { ok: false, error }` envelope
 * defined in @mcpambassador/contracts.
 *
 * Source of truth is the live server. The client vendors a byte-identical copy of
 * this file; its CI fails if the copy differs from server main.
 *
 * @see Architecture §16.3 Protocol Package
 */

/**
 * API version constant
 */
export const API_VERSION = 'v1';

/**
 * Host tool enum - identifies the AI host application
 */
export type HostTool =
  | 'vscode'
  | 'claude-desktop'
  | 'claude-code'
  | 'opencode'
  | 'gemini-cli'
  | 'chatgpt'
  | 'custom';

/**
 * Authentication method enum
 */
export type AuthMethod = 'api_key' | 'jwt' | 'oidc' | 'saml' | 'mtls';

/**
 * Client status enum
 * @deprecated Retired with the API-key client model (POST /v1/clients/register returns 410).
 * Not part of the 8443 wire format; retained only for backward compatibility.
 */
export type ClientStatus = 'active' | 'suspended' | 'revoked';

/**
 * Event type enum for audit logging
 */
export type EventType =
  | 'client_registration'
  | 'authentication'
  | 'auth_success'
  | 'auth_failure'
  | 'tool_invocation'
  | 'tool_error'
  | 'authorization_decision'
  | 'authz_permit'
  | 'authz_deny'
  | 'profile_update'
  | 'admin_action'
  | 'error';

/**
 * Severity level for audit events
 */
export type Severity = 'info' | 'warn' | 'error' | 'critical';

/**
 * Session registration request (POST /v1/sessions/register)
 *
 * The preshared key (`amb_pk_*`) is issued to a user in the SPA.
 */
export interface RegistrationRequest {
  /** User preshared key (amb_pk_...) */
  preshared_key: string;
  /** Human-readable label (max 128 chars, sanitized to [a-zA-Z0-9 _.-]) */
  friendly_name: string;
  /** Host tool identifier */
  host_tool: HostTool;
}

/**
 * Session registration response (HTTP 201)
 *
 * `session_token` (amb_st_...) is sent on later requests in the `X-Session-Token` header.
 */
export interface RegistrationResponse {
  /** Server-generated session UUID */
  session_id: string;
  /** Session token (amb_st_...), returned only once */
  session_token: string;
  /** Session expiry (ISO 8601) */
  expires_at: string;
  /** Assigned tool profile ID */
  profile_id: string;
  /** Connection UUID for this client instance */
  connection_id: string;
}

/**
 * Heartbeat response (POST /v1/sessions/heartbeat)
 */
export interface HeartbeatResponse {
  status: 'ok';
  /** Current session status */
  session_status: string;
  /** New session expiry (ISO 8601) */
  expires_at: string;
}

/**
 * Disconnect response (DELETE /v1/sessions/connections/:connectionId)
 */
export interface DisconnectResponse {
  status: 'disconnected';
  connection_id: string;
}

/**
 * Tool catalog response (GET /v1/tools)
 *
 * Returns the merged tool catalog from all downstream MCPs,
 * filtered by the client's effective profile.
 */
export interface ToolCatalogResponse {
  /** Array of available tools */
  tools: ToolDescriptor[];
  /** API version */
  api_version: string;
  /** Server timestamp (ISO 8601) */
  timestamp: string;
}

/**
 * Tool descriptor (subset of MCP tool schema)
 */
export interface ToolDescriptor {
  /** Fully qualified tool name (e.g., "github.search_code") */
  name: string;
  /** Human-readable description */
  description: string;
  /** JSON Schema for tool arguments */
  input_schema: Record<string, unknown>;
  /** Optional metadata */
  metadata?: {
    /** Downstream MCP server name */
    mcp_server?: string;
    /** Tags for categorization */
    tags?: string[];
  };
}

/**
 * Tool invocation request (POST /v1/tools/invoke)
 *
 * @see Architecture §4.1 Pipeline Flow
 */
export interface ToolInvocationRequest {
  /** Fully qualified tool name */
  tool: string;
  /** Tool arguments (validated against input_schema) */
  arguments: Record<string, unknown>;
  /** Optional client-provided trace ID for correlation */
  trace_id?: string;
}

/**
 * Tool invocation response
 */
export interface ToolInvocationResponse {
  /** Tool execution result */
  result: unknown;
  /** Server-generated request ID (for audit trail) */
  request_id: string;
  /** Execution timestamp (ISO 8601) */
  timestamp: string;
  /** Optional metadata */
  metadata?: {
    /** Execution duration in milliseconds */
    duration_ms?: number;
    /** Downstream MCP server that handled the request */
    mcp_server?: string;
    /** Error message (if tool execution failed) */
    error?: string;
    /** Whether the invocation resulted in an error */
    is_error?: boolean;
  };
}

/**
 * Audit event schema
 *
 * @see Architecture §5.3 AuditEvent
 * @see Architecture §11 Audit Deep Dive
 */
export interface AuditEvent {
  /** Event UUID */
  event_id: string;
  /** Event timestamp (ISO 8601) */
  timestamp: string;
  /** Event type */
  event_type: EventType;
  /** Event severity */
  severity: Severity;
  /** Session ID (for grouping related events) */
  session_id?: string;
  /** Client UUID (if authenticated) */
  client_id?: string;
  /** User ID (Pro/Enterprise only) */
  user_id?: string;
  /** Authentication method used */
  auth_method?: AuthMethod;
  /** Source IP address */
  source_ip?: string;
  /** Tool name (for tool_invocation events) */
  tool_name?: string;
  /** Downstream MCP server */
  downstream_mcp?: string;
  /** Action performed */
  action: string;
  /** Request summary (JSON) */
  request_summary?: Record<string, unknown>;
  /** Response summary (JSON) */
  response_summary?: Record<string, unknown>;
  /** Authorization decision (permit/deny/conditional) */
  authz_decision?: 'permit' | 'deny' | 'conditional';
  /** Authorization policy that made the decision */
  authz_policy?: string;
  /** Ambassador node identifier (for multi-node deployments) */
  ambassador_node?: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Error response on the client port (8443): flat shape.
 *
 * `error` is a machine-readable code or HTTP status text (e.g. "rate_limit_exceeded",
 * "Unauthorized"); `message` is generic, with no internal details.
 */
export interface ErrorResponse {
  error: string;
  message: string;
}

/**
 * Kill switch notification (Server Sent Events, Phase 2)
 *
 * Sent via SSE when a tool or MCP is disabled by the server.
 *
 * @see Architecture §17.2 Server Push & Kill Switch Propagation
 */
export interface KillSwitchNotification {
  /** Notification type */
  type: 'tool_disabled' | 'tool_enabled' | 'mcp_offline' | 'mcp_online';
  /** Tool name (if tool-level kill switch) */
  tool?: string;
  /** MCP server name (if MCP-level kill switch) */
  mcp_server?: string;
  /** Reason for the change */
  reason?: string;
  /** Timestamp (ISO 8601) */
  timestamp: string;
}

/**
 * Pagination metadata for list responses
 *
 * @see Architecture §16.4 Admin API Design Principles
 */
export interface PaginationMetadata {
  /** Cursor for next page (undefined if no more results) */
  next_cursor?: string;
  /** Whether more results exist */
  has_more: boolean;
  /** Total count (optional, expensive to compute) */
  total_count?: number;
}

/**
 * Standard list response envelope
 */
export interface ListResponse<T> {
  /** Array of items */
  data: T[];
  /** Pagination metadata */
  pagination: PaginationMetadata;
}
