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
  error: string;
  message?: string;
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
  cursor?: string;
  hasMore: boolean;
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
