export interface User {
  id: string;
  username: string;
  displayName?: string;
  email?: string;
  isAdmin: boolean;
  createdAt: string;
  lastLoginAt?: string;
}

export interface AuthResponse {
  user: User;
}

export interface ErrorResponse {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: unknown[];
  };
}

export interface Client {
  id: string;
  clientName: string;
  keyPrefix: string;
  status: 'active' | 'suspended' | 'revoked';
  profileId?: string;
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
}

export interface CreateClientRequest {
  client_name: string;
  profile_id?: string;
  expires_at?: string;
}

export interface CreateClientResponse {
  client: Client;
  plaintext_key: string;
}

export interface UpdateClientRequest {
  status?: 'active' | 'suspended' | 'revoked';
}

export interface Subscription {
  id: string;
  clientId: string;
  mcpId: string;
  mcpName: string;
  selectedTools?: string[];
  status: 'active' | 'suspended';
  createdAt: string;
  updatedAt: string;
}

export interface CreateSubscriptionRequest {
  mcp_id: string;
  selected_tools?: string[];
}

export interface UpdateSubscriptionRequest {
  selected_tools?: string[];
}

export interface McpEntry {
  id: string;
  name: string;
  description?: string;
  isolationMode: 'shared' | 'per-user';
  requiresUserCredentials: boolean;
  credentialSchema?: Record<string, unknown>;
  tools: McpTool[];
  createdAt: string;
  updatedAt: string;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    has_more: boolean;
    next_cursor: string | null;
    total_count: number;
  };
}

export interface AdminClient {
  client_id: string;
  client_name: string;
  key_prefix: string;
  owner_user_id: string;
  status: 'active' | 'suspended' | 'revoked';
  profile_id?: string;
  created_at: string;
  expires_at?: string;
  last_used_at?: string;
}

export interface CredentialStatus {
  mcpId: string;
  mcpName: string;
  hasCredentials: boolean;
  requiresCredentials: boolean;
  credentialSchema?: Record<string, unknown>;
  updatedAt?: string;
}

export interface SetCredentialsRequest {
  credentials: Record<string, string>;
}

export interface ChangePasswordRequest {
  current_password: string;
  new_password: string;
}

// Admin types
export interface AdminUser {
  user_id: string;
  username: string;
  display_name?: string;
  email?: string;
  is_admin: boolean;
  status: 'active' | 'suspended';
  created_at: string;
  last_login_at?: string;
}

export interface CreateUserRequest {
  username: string;
  password: string;
  display_name?: string;
  email?: string;
  is_admin?: boolean;
}

export interface UpdateUserRequest {
  display_name?: string;
  email?: string;
  is_admin?: boolean;
  status?: 'active' | 'suspended';
}

export interface Group {
  group_id: string;
  name: string;
  description?: string;
  created_at: string;
  updated_at: string;
}

export interface CreateGroupRequest {
  name: string;
  description?: string;
}

export interface UpdateGroupRequest {
  name?: string;
  description?: string;
}

export interface GroupMember {
  user_id: string;
  username: string;
  display_name?: string;
  added_at: string;
}

export interface McpCatalogEntry {
  mcp_id: string;
  name: string;
  display_name: string;
  description?: string;
  icon_url?: string;
  transport_type: 'stdio' | 'http' | 'sse';
  config: Record<string, unknown> | string;
  isolation_mode: 'shared' | 'per_user';
  status: 'draft' | 'published' | 'archived';
  validation_status?: 'pending' | 'valid' | 'invalid';
  requires_user_credentials: boolean;
  credential_schema?: Record<string, unknown>;
  tool_catalog?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
  tool_count?: number;
  validation_result?: Record<string, unknown>;
  last_validated_at?: string;
  created_at: string;
  updated_at: string;
}

export interface CreateMcpRequest {
  name: string;
  display_name: string;
  description?: string;
  icon_url?: string;
  transport_type: 'stdio' | 'http' | 'sse';
  config: Record<string, unknown>;
  isolation_mode?: 'shared' | 'per_user';
  requires_user_credentials?: boolean;
  credential_schema?: Record<string, unknown>;
}

export interface UpdateMcpRequest {
  display_name?: string;
  description?: string;
  icon_url?: string;
  transport_type?: 'stdio' | 'http' | 'sse';
  config?: Record<string, unknown>;
  isolation_mode?: 'shared' | 'per_user';
  requires_user_credentials?: boolean;
  credential_schema?: Record<string, unknown>;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  tools_discovered?: Array<{ name: string; description?: string }>;
}

export interface DiscoveryResult {
  status: 'success' | 'skipped' | 'error';
  tools_discovered: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
  tool_count: number;
  error_code?: string;
  message?: string;
  discovered_at: string;
  duration_ms: number;
  server_info?: {
    name?: string;
    version?: string;
    protocolVersion?: string;
  };
}

export interface AuditEvent {
  event_id: string;
  timestamp: string;
  event_type: string;
  severity: 'info' | 'warn' | 'error';
  client_id?: string;
  user_id?: string;
  source_ip: string;
  action: string;
  metadata: Record<string, unknown>;
}

export interface Session {
  session_id: string;
  user_id: string;
  username: string;
  created_at: string;
  expires_at: string;
  ip_address?: string;
}

export interface DownstreamStatus {
  total_connections: number;
  healthy_connections: number;
  total_tools: number;
  connections: Array<{
    name: string;
    status: string;
    tools: number;
  }>;
}

export interface KillSwitchResponse {
  target: string;
  enabled: boolean;
  timestamp: string;
}

export interface Profile {
  profile_id: string;
  name: string;
  description?: string;
  allowed_tools?: string[];
  created_at: string;
  updated_at: string;
}

// MCP Health Monitoring
export interface ErrorLogEntry {
  timestamp: string;
  message: string;
  level: 'error' | 'warn' | 'info';
}

export interface McpErrorLogResponse {
  name: string;
  transport: string;
  entries: ErrorLogEntry[];
  total_count: number;
}

export interface McpHealthDetail {
  // StdioMcpConnection detail shape
  pid?: number | null;
  pendingRequests?: number;
  uptime_ms?: number | null;
  processExited?: boolean;
  toolCount?: number;
  // HttpMcpConnection detail shape
  consecutiveFailures?: number;
  maxFailures?: number;
  templateUrl?: string | null;
}

export interface McpHealthEntry {
  name: string;
  transport: 'stdio' | 'http';
  connected: boolean;
  detail: McpHealthDetail;
  user_instances: number;
  last_error: string | null;     // M33.1 NEW
  error_count: number;           // M33.1 NEW
}

export interface McpHealthSummary {
  timestamp: string;
  shared: McpHealthEntry[];
  summary: {
    total_shared: number;
    healthy_shared: number;
    total_user_instances: number;
  };
}

export interface McpInstanceUserEntry {
  userId: string;
  status: string;
  spawnedAt: string;
  connected: boolean;
  toolCount: number;
  last_error: string | null;
  error_count: number;
  stderr_tail: ErrorLogEntry[];
}

export interface McpInstanceDetail {
  name: string;
  transport: 'stdio' | 'http';
  shared: {
    health: {
      name: string;
      transport: string;
      status: 'healthy' | 'degraded' | 'unhealthy';
      last_check: string;
      error?: string;
      tool_count?: number;
    };
    detail: McpHealthDetail;
    stderr_tail: ErrorLogEntry[];
    error_count: number;
  };
  user_instances: McpInstanceUserEntry[];
}

export interface McpRestartResult {
  name: string;
  restarted: boolean;
  connected: boolean;
  tool_count: number;
}

// New: Per-user instance data from GET /v1/admin/health/user-mcps (M33.2)
export interface UserMcpInstance {
  user_id: string;
  username: string;
  mcp_name: string;
  status: 'connected' | 'disconnected' | 'error';
  tool_count: number;
  spawned_at: string | null;
  uptime_ms: number | null;
  last_error: string | null;
  error_count: number;
}

export interface UserMcpSummary {
  timestamp: string;
  summary: {
    total_instances: number;
    active_users: number;
    total_users: number;
    total_tools_served: number;
    healthy_instances: number;
    unhealthy_instances: number;
  };
  instances: UserMcpInstance[];
}

// Catalog status from GET /v1/admin/catalog/status
export interface CatalogReloadStatus {
  has_changes: boolean;
  shared: {
    to_add: Array<{ name: string; transport_type: string }>;
    to_remove: Array<{ name: string; reason: string }>;
    to_update: Array<{ name: string; changed_fields: string[] }>;
    unchanged: string[];
  };
  per_user: {
    to_add: Array<{ name: string }>;
    to_remove: Array<{ name: string }>;
    to_update: Array<{ name: string }>;
  };
}

// Result from POST /v1/admin/catalog/apply
export interface CatalogApplyResult {
  timestamp: string;
  shared: {
    added: string[];
    removed: string[];
    updated: string[];
    unchanged: string[];
    errors: Array<{ name: string; action: string; error: string }>;
  };
  per_user: {
    configs_added: string[];
    configs_removed: string[];
    configs_updated: string[];
    active_users_affected: number;
    note: string;
  };
  summary: {
    total_changes: number;
    successful: number;
    failed: number;
  };
}
