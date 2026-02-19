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
  AuditEvent,
  Session,
  DownstreamStatus,
  KillSwitchResponse,
  Profile,
  PaginatedResponse,
  AdminClient,
} from '../types';

// Users
export function useAdminUsers(cursor?: string, limit = 50) {
  return useQuery({
    queryKey: ['admin', 'users', cursor, limit],
    queryFn: () =>
      apiClient.get<PaginatedResponse<AdminUser>>('/v1/admin/users', {
        params: cursor || limit !== 50 ? { 
          ...(cursor ? { cursor } : {}),
          limit: String(limit),
        } : undefined,
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

export function useCreateUser() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (data: CreateUserRequest) =>
      apiClient.post<AdminUser>('/v1/admin/users', data),
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
    mutationFn: (userId: string) =>
      apiClient.delete(`/v1/admin/users/${userId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
    },
  });
}

export function useResetPassword() {
  return useMutation({
    mutationFn: ({ userId, newPassword }: { userId: string; newPassword: string }) =>
      apiClient.post<{ message: string; user_id: string }>(`/v1/admin/users/${userId}/reset-password`, {
        new_password: newPassword,
      }),
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
    queryFn: () => apiClient.get<{ data: Group }>(`/v1/admin/groups/${groupId}`).then(res => res.data),
    enabled: !!groupId,
  });
}

export function useCreateGroup() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (data: CreateGroupRequest) =>
      apiClient.post<{ data: Group }>('/v1/admin/groups', data).then(res => res.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'groups'] });
    },
  });
}

export function useUpdateGroup() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ groupId, data }: { groupId: string; data: UpdateGroupRequest }) =>
      apiClient.patch<{ data: Group }>(`/v1/admin/groups/${groupId}`, data).then(res => res.data),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'groups'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'groups', variables.groupId] });
    },
  });
}

export function useDeleteGroup() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (groupId: string) =>
      apiClient.delete(`/v1/admin/groups/${groupId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'groups'] });
    },
  });
}

// Group Members
export function useGroupMembers(groupId: string) {
  return useQuery({
    queryKey: ['admin', 'groups', groupId, 'members'],
    queryFn: () => apiClient.get<{ data: GroupMember[] }>(`/v1/admin/groups/${groupId}/members`).then(res => res.data),
    enabled: !!groupId,
  });
}

export function useAddGroupMember() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ groupId, userId }: { groupId: string; userId: string }) =>
      apiClient.post<{ data: { message: string } }>(`/v1/admin/groups/${groupId}/members`, { user_id: userId }),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'groups', variables.groupId, 'members'] });
    },
  });
}

export function useRemoveGroupMember() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ groupId, userId }: { groupId: string; userId: string }) =>
      apiClient.delete(`/v1/admin/groups/${groupId}/members/${userId}`),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'groups', variables.groupId, 'members'] });
    },
  });
}

// Group MCPs
export function useGroupMcps(groupId: string) {
  return useQuery({
    queryKey: ['admin', 'groups', groupId, 'mcps'],
    queryFn: () => apiClient.get<{ data: McpCatalogEntry[] }>(`/v1/admin/groups/${groupId}/mcps`).then(res => res.data),
    enabled: !!groupId,
  });
}

export function useAssignGroupMcp() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ groupId, mcpId }: { groupId: string; mcpId: string }) =>
      apiClient.post<{ data: { message: string } }>(`/v1/admin/groups/${groupId}/mcps`, { mcp_id: mcpId }),
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
        params: filters ? {
          ...(filters.cursor ? { cursor: filters.cursor } : {}),
          ...(filters.limit ? { limit: String(filters.limit) } : {}),
          ...(filters.status ? { status: filters.status } : {}),
          ...(filters.isolation_mode ? { isolation_mode: filters.isolation_mode } : {}),
        } : undefined,
      }),
  });
}

export function useAdminMcp(mcpId: string) {
  return useQuery({
    queryKey: ['admin', 'mcps', mcpId],
    queryFn: () => apiClient.get<{ data: McpCatalogEntry }>(`/v1/admin/mcps/${mcpId}`).then(res => res.data),
    enabled: !!mcpId,
  });
}

export function useCreateMcp() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (data: CreateMcpRequest) =>
      apiClient.post<{ data: McpCatalogEntry }>('/v1/admin/mcps', data).then(res => res.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'mcps'] });
    },
  });
}

export function useUpdateMcp() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ mcpId, data }: { mcpId: string; data: UpdateMcpRequest }) =>
      apiClient.patch<{ data: McpCatalogEntry }>(`/v1/admin/mcps/${mcpId}`, data).then(res => res.data),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'mcps'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'mcps', variables.mcpId] });
    },
  });
}

export function useDeleteMcp() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (mcpId: string) =>
      apiClient.delete(`/v1/admin/mcps/${mcpId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'mcps'] });
    },
  });
}

export function useValidateMcp() {
  return useMutation({
    mutationFn: (mcpId: string) =>
      apiClient.post<{ data: ValidationResult }>(`/v1/admin/mcps/${mcpId}/validate`).then(res => res.data),
  });
}

export function usePublishMcp() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (mcpId: string) =>
      apiClient.post<{ data: McpCatalogEntry }>(`/v1/admin/mcps/${mcpId}/publish`).then(res => res.data),
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
      apiClient.post<{ data: McpCatalogEntry }>(`/v1/admin/mcps/${mcpId}/archive`).then(res => res.data),
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
    mutationFn: (profileId: string) =>
      apiClient.delete(`/v1/admin/profiles/${profileId}`),
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
        params: filters ? {
          ...(filters.start_time ? { start_time: filters.start_time } : {}),
          ...(filters.end_time ? { end_time: filters.end_time } : {}),
          ...(filters.client_id ? { client_id: filters.client_id } : {}),
          ...(filters.event_type ? { event_type: filters.event_type } : {}),
          ...(filters.user_id ? { user_id: filters.user_id } : {}),
          ...(filters.limit ? { limit: String(filters.limit) } : {}),
          ...(filters.cursor ? { cursor: filters.cursor } : {}),
        } : undefined,
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
        params: cursor || limit !== 50 ? {
          ...(cursor ? { cursor } : {}),
          limit: String(limit),
        } : undefined,
      }),
  });
}

// Admin Sessions
export function useAdminSessions() {
  return useQuery({
    queryKey: ['admin', 'sessions'],
    queryFn: () => apiClient.get<{ data: Session[] }>('/v1/admin/sessions').then(res => res.data),
  });
}

export function useKillSession() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (sessionId: string) =>
      apiClient.delete(`/v1/admin/sessions/${sessionId}`),
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
