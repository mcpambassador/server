import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../client';
import type {
  AdminUser,
  CreateUserRequest,
  UpdateUserRequest,
  Group,
  CreateGroupRequest,
  UpdateGroupRequest,
  GroupMember,
  McpCatalogEntry,
  CreateMcpRequest,
  UpdateMcpRequest,
  ValidationResult,
  DiscoveryResult,
  AuditEvent,
  Session,
  DownstreamStatus,
  KillSwitchResponse,
  Profile,
  PaginatedResponse,
  AdminClient,
  McpHealthSummary,
  McpInstanceDetail,
  McpRestartResult,
  UserMcpSummary,
  CatalogReloadStatus,
  CatalogApplyResult,
  McpErrorLogResponse,
} from '../types';

// Users
export function useAdminUsers(cursor?: string, limit = 50) {
  return useQuery({
    queryKey: ['admin', 'users', cursor, limit],
    queryFn: () =>
      apiClient.get<PaginatedResponse<AdminUser>>('/v1/admin/users', {
        params:
          cursor || limit !== 50
            ? {
                ...(cursor ? { cursor } : {}),
                limit: String(limit),
              }
            : undefined,
      }),
  });
}

export function useAdminUser(userId: string) {
  return useQuery({
    queryKey: ['admin', 'users', userId],
    queryFn: () => apiClient.get<AdminUser>(`/v1/admin/users/${userId}`),
    enabled: !!userId,
  });
}

export function useAdminUserGroups(userId: string) {
  return useQuery({
    queryKey: ['admin', 'users', userId, 'groups'],
    queryFn: async () => {
      const response = await apiClient.get<
        Array<{ group_id: string; name: string; description?: string | null; assigned_at: string }>
      >(`/v1/admin/users/${userId}/groups`);
      return response;
    },
    enabled: !!userId,
  });
}

export function useCreateUser() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: CreateUserRequest) => apiClient.post<AdminUser>('/v1/admin/users', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
    },
  });
}

export function useUpdateUser() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ userId, data }: { userId: string; data: UpdateUserRequest }) =>
      apiClient.patch<AdminUser>(`/v1/admin/users/${userId}`, data),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'users', variables.userId] });
    },
  });
}

export function useDeleteUser() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (userId: string) => apiClient.delete(`/v1/admin/users/${userId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
    },
  });
}

export function useResetPassword() {
  return useMutation({
    mutationFn: ({ userId, newPassword }: { userId: string; newPassword: string }) =>
      apiClient.post<{ message: string; user_id: string }>(
        `/v1/admin/users/${userId}/reset-password`,
        {
          new_password: newPassword,
        }
      ),
  });
}

// Groups
export function useAdminGroups() {
  return useQuery({
    queryKey: ['admin', 'groups'],
    queryFn: () => apiClient.get<PaginatedResponse<Group>>('/v1/admin/groups'),
  });
}

export function useAdminGroup(groupId: string) {
  return useQuery({
    queryKey: ['admin', 'groups', groupId],
    queryFn: () => apiClient.get<Group>(`/v1/admin/groups/${groupId}`),
    enabled: !!groupId,
  });
}

export function useCreateGroup() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: CreateGroupRequest) => apiClient.post<Group>('/v1/admin/groups', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'groups'] });
    },
  });
}

export function useUpdateGroup() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ groupId, data }: { groupId: string; data: UpdateGroupRequest }) =>
      apiClient.patch<Group>(`/v1/admin/groups/${groupId}`, data),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'groups'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'groups', variables.groupId] });
    },
  });
}

export function useDeleteGroup() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (groupId: string) => apiClient.delete(`/v1/admin/groups/${groupId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'groups'] });
    },
  });
}

// Group Members
export function useGroupMembers(groupId: string) {
  return useQuery({
    queryKey: ['admin', 'groups', groupId, 'members'],
    queryFn: () => apiClient.get<GroupMember[]>(`/v1/admin/groups/${groupId}/members`),
    enabled: !!groupId,
  });
}

export function useAddGroupMember() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ groupId, userId }: { groupId: string; userId: string }) =>
      apiClient.post<{ message: string }>(`/v1/admin/groups/${groupId}/members`, {
        user_id: userId,
      }),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: ['admin', 'groups', variables.groupId, 'members'],
      });
    },
  });
}

export function useRemoveGroupMember() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ groupId, userId }: { groupId: string; userId: string }) =>
      apiClient.delete(`/v1/admin/groups/${groupId}/members/${userId}`),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: ['admin', 'groups', variables.groupId, 'members'],
      });
    },
  });
}

// Group MCPs
export function useGroupMcps(groupId: string) {
  return useQuery({
    queryKey: ['admin', 'groups', groupId, 'mcps'],
    queryFn: () => apiClient.get<McpCatalogEntry[]>(`/v1/admin/groups/${groupId}/mcps`),
    enabled: !!groupId,
  });
}

export function useAssignGroupMcp() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ groupId, mcpId }: { groupId: string; mcpId: string }) =>
      apiClient.post<{ message: string }>(`/v1/admin/groups/${groupId}/mcps`, { mcp_id: mcpId }),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'groups', variables.groupId, 'mcps'] });
    },
  });
}

export function useRemoveGroupMcp() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ groupId, mcpId }: { groupId: string; mcpId: string }) =>
      apiClient.delete(`/v1/admin/groups/${groupId}/mcps/${mcpId}`),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'groups', variables.groupId, 'mcps'] });
    },
  });
}

// MCP Catalog
export function useAdminMcps(filters?: {
  cursor?: string;
  limit?: number;
  status?: 'draft' | 'published' | 'archived';
  isolation_mode?: 'shared' | 'per_user';
}) {
  return useQuery({
    queryKey: ['admin', 'mcps', filters],
    queryFn: () =>
      apiClient.get<PaginatedResponse<McpCatalogEntry>>('/v1/admin/mcps', {
        params: filters
          ? {
              ...(filters.cursor ? { cursor: filters.cursor } : {}),
              ...(filters.limit ? { limit: String(filters.limit) } : {}),
              ...(filters.status ? { status: filters.status } : {}),
              ...(filters.isolation_mode ? { isolation_mode: filters.isolation_mode } : {}),
            }
          : undefined,
      }),
  });
}

export function useAdminMcp(mcpId: string) {
  return useQuery({
    queryKey: ['admin', 'mcps', mcpId],
    queryFn: () => apiClient.get<McpCatalogEntry>(`/v1/admin/mcps/${mcpId}`),
    enabled: !!mcpId,
  });
}

export function useCreateMcp() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: CreateMcpRequest) => apiClient.post<McpCatalogEntry>('/v1/admin/mcps', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'mcps'] });
    },
  });
}

export function useUpdateMcp() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ mcpId, data }: { mcpId: string; data: UpdateMcpRequest }) =>
      apiClient.patch<McpCatalogEntry>(`/v1/admin/mcps/${mcpId}`, data),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'mcps'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'mcps', variables.mcpId] });
    },
  });
}

export function useDeleteMcp() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (mcpId: string) => apiClient.delete(`/v1/admin/mcps/${mcpId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'mcps'] });
    },
  });
}

export function useValidateMcp() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (mcpId: string) =>
      apiClient.post<ValidationResult>(`/v1/admin/mcps/${mcpId}/validate`),
    onSuccess: (_, mcpId) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'mcps'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'mcps', mcpId] });
    },
  });
}

export function useDiscoverTools() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ mcpId, credentials }: { mcpId: string; credentials?: Record<string, string> }) =>
      apiClient.post<DiscoveryResult>(`/v1/admin/mcps/${mcpId}/discover`, { credentials }),
    onSuccess: (_, { mcpId }) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'mcps'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'mcps', mcpId] });
      queryClient.invalidateQueries({ queryKey: ['marketplace'] });
    },
  });
}

export function usePublishMcp() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (mcpId: string) =>
      apiClient.post<McpCatalogEntry>(`/v1/admin/mcps/${mcpId}/publish`),
    onSuccess: (_, mcpId) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'mcps'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'mcps', mcpId] });
    },
  });
}

export function useArchiveMcp() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (mcpId: string) =>
      apiClient.post<McpCatalogEntry>(`/v1/admin/mcps/${mcpId}/archive`),
    onSuccess: (_, mcpId) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'mcps'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'mcps', mcpId] });
    },
  });
}

// Profiles
export function useAdminProfiles() {
  return useQuery({
    queryKey: ['admin', 'profiles'],
    queryFn: () => apiClient.get<PaginatedResponse<Profile>>('/v1/admin/profiles'),
  });
}

export function useAdminProfile(profileId: string) {
  return useQuery({
    queryKey: ['admin', 'profiles', profileId],
    queryFn: () => apiClient.get<Profile>(`/v1/admin/profiles/${profileId}`),
    enabled: !!profileId,
  });
}

export function useCreateProfile() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: { name: string; description?: string; allowed_tools?: string[] }) =>
      apiClient.post<Profile>('/v1/admin/profiles', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'profiles'] });
    },
  });
}

export function useUpdateProfile() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ profileId, data }: { profileId: string; data: Partial<Profile> }) =>
      apiClient.patch<Profile>(`/v1/admin/profiles/${profileId}`, data),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'profiles'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'profiles', variables.profileId] });
    },
  });
}

export function useDeleteProfile() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (profileId: string) => apiClient.delete(`/v1/admin/profiles/${profileId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'profiles'] });
    },
  });
}

// Audit Events
export function useAuditEvents(filters?: {
  start_time?: string;
  end_time?: string;
  client_id?: string;
  event_type?: string;
  user_id?: string;
  limit?: number;
  cursor?: string;
}) {
  return useQuery({
    queryKey: ['admin', 'audit', filters],
    queryFn: () =>
      apiClient.get<PaginatedResponse<AuditEvent>>('/v1/audit/events', {
        params: filters
          ? {
              ...(filters.start_time ? { start_time: filters.start_time } : {}),
              ...(filters.end_time ? { end_time: filters.end_time } : {}),
              ...(filters.client_id ? { client_id: filters.client_id } : {}),
              ...(filters.event_type ? { event_type: filters.event_type } : {}),
              ...(filters.user_id ? { user_id: filters.user_id } : {}),
              ...(filters.limit ? { limit: String(filters.limit) } : {}),
              ...(filters.cursor ? { cursor: filters.cursor } : {}),
            }
          : undefined,
      }),
  });
}

// Downstream Status
export function useDownstream() {
  return useQuery({
    queryKey: ['admin', 'downstream'],
    queryFn: () => apiClient.get<DownstreamStatus>('/v1/admin/downstream'),
  });
}

// Kill Switches
export function useKillSwitch() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ target, enabled }: { target: string; enabled: boolean }) =>
      apiClient.post<KillSwitchResponse>(`/v1/admin/kill-switch/${target}`, { enabled }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'clients'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'mcps'] });
    },
  });
}

// Admin Clients
export function useAdminClients(cursor?: string, limit = 50) {
  return useQuery({
    queryKey: ['admin', 'clients', cursor, limit],
    queryFn: () =>
      apiClient.get<PaginatedResponse<AdminClient>>('/v1/admin/clients', {
        params:
          cursor || limit !== 50
            ? {
                ...(cursor ? { cursor } : {}),
                limit: String(limit),
              }
            : undefined,
      }),
  });
}

// Admin Sessions
export function useAdminSessions() {
  return useQuery({
    queryKey: ['admin', 'sessions'],
    queryFn: () => apiClient.get<PaginatedResponse<Session>>('/v1/admin/sessions'),
  });
}

export function useKillSession() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (sessionId: string) => apiClient.delete(`/v1/admin/sessions/${sessionId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'sessions'] });
    },
  });
}

// System Operations
export function useRotateHmac() {
  return useMutation({
    mutationFn: () =>
      apiClient.post<{ message: string; timestamp: string }>('/v1/admin/rotate-hmac-secret'),
  });
}

export function useRotateCredentialKey() {
  return useMutation({
    mutationFn: () =>
      apiClient.post<{ message: string; timestamp: string }>('/v1/admin/rotate-credential-key'),
  });
}

// MCP Health Monitoring
export function useAdminMcpHealth() {
  return useQuery({
    queryKey: ['admin', 'health', 'mcps'],
    queryFn: () => apiClient.get<McpHealthSummary>('/v1/admin/health/mcps'),
    refetchInterval: 60000, // Auto-refresh every 60 seconds
  });
}

export function useAdminMcpInstances(mcpName: string) {
  return useQuery({
    queryKey: ['admin', 'health', 'mcps', mcpName, 'instances'],
    queryFn: () =>
      apiClient.get<McpInstanceDetail>(
        `/v1/admin/health/mcps/${encodeURIComponent(mcpName)}/instances`
      ),
    enabled: !!mcpName,
  });
}

export function useRestartMcp() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (mcpName: string) =>
      apiClient.post<McpRestartResult>(
        `/v1/admin/health/mcps/${encodeURIComponent(mcpName)}/restart`
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'health'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'downstream'] });
    },
  });
}

// MCP Error Logs (M33.1)
export function useAdminMcpLogs(mcpName: string) {
  return useQuery({
    queryKey: ['admin', 'health', 'logs', mcpName],
    queryFn: () =>
      apiClient.get<McpErrorLogResponse>(
        `/v1/admin/health/mcps/${encodeURIComponent(mcpName)}/logs`
      ),
    enabled: !!mcpName,
    // Stop polling when the query enters an error state (e.g., 404 for non-connected MCPs)
    refetchInterval: query => (query.state.status === 'error' ? false : 30000),
  });
}

export function useClearMcpLogs() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (mcpName: string) =>
      apiClient.delete(`/v1/admin/health/mcps/${encodeURIComponent(mcpName)}/logs`),
    onSuccess: (_data, mcpName) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'health', 'logs', mcpName] });
    },
  });
}

export function useRestartUserMcp() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, mcpName }: { userId: string; mcpName: string }) =>
      apiClient.post(
        `/v1/admin/health/user-mcps/${encodeURIComponent(userId)}/mcps/${encodeURIComponent(mcpName)}/restart`
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'health'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'user-mcps'] });
    },
  });
}

// User MCP Instances (M33.2)
export function useUserMcpInstances() {
  return useQuery({
    queryKey: ['admin', 'user-mcps'],
    queryFn: () => apiClient.get<UserMcpSummary>('/v1/admin/health/user-mcps'),
    refetchInterval: 60000,
  });
}

// Catalog Reload Status (M33.2)
export function useCatalogStatus() {
  return useQuery({
    queryKey: ['admin', 'catalog-status'],
    queryFn: () => apiClient.get<CatalogReloadStatus>('/v1/admin/catalog/status'),
    refetchInterval: 60000,
  });
}

// Apply Catalog Changes (M33.2)
export function useApplyCatalogChanges() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiClient.post<CatalogApplyResult>('/v1/admin/catalog/apply'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'catalog-status'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'health'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'downstream'] });
    },
  });
}
