import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../client';
import type {
  ConsentDetails,
  ConsentDecision,
  ConsentDecisionResponse,
  AgentGrantSummary,
  CreateGrantRequest,
  CreateGrantResponse,
  OAuthClientSummary,
  AgentEndpointSettings,
  UserAgentEndpointInfo,
} from '../agent-types';

type Paginated<T> =
  | {
      data: T[];
      pagination?: { has_more: boolean; total_count?: number; next_cursor?: string | null };
    }
  | T[];

function items<T>(res: Paginated<T> | undefined): T[] {
  if (!res) return [];
  return Array.isArray(res) ? res : res.data;
}

// Consent
export function useConsentDetails(requestId: string | null) {
  return useQuery({
    queryKey: ['oauth-consent', requestId],
    queryFn: () =>
      apiClient.get<ConsentDetails>(`/v1/oauth/consent/${encodeURIComponent(requestId!)}`),
    enabled: !!requestId,
    retry: false,
    // A pending request is single-use; never refetch behind the user's back.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

export function useSubmitConsent(requestId: string) {
  return useMutation({
    mutationFn: (decision: ConsentDecision) =>
      apiClient.post<ConsentDecisionResponse>(
        `/v1/oauth/consent/${encodeURIComponent(requestId)}`,
        decision
      ),
  });
}

// User grants
const GRANTS_PAGE_SIZE = 50;

/** Cursor-paginated list; `grants` is the flattened set of pages loaded so far. */
function usePagedGrants(key: unknown[], path: string, params: Record<string, string> = {}) {
  const q = useInfiniteQuery({
    queryKey: key,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      apiClient.get<Paginated<AgentGrantSummary>>(path, {
        params: {
          ...params,
          limit: String(GRANTS_PAGE_SIZE),
          ...(pageParam ? { cursor: pageParam } : {}),
        },
      }),
    getNextPageParam: last =>
      !Array.isArray(last) && last.pagination?.has_more
        ? (last.pagination.next_cursor ?? undefined)
        : undefined,
  });
  return {
    grants: q.data ? q.data.pages.flatMap(p => items(p)) : undefined,
    isLoading: q.isLoading,
    error: q.error,
    hasMore: !!q.hasNextPage,
    loadMore: () => void q.fetchNextPage(),
    loadingMore: q.isFetchingNextPage,
  };
}

export function useAgentGrants() {
  return usePagedGrants(['agent-grants'], '/v1/users/me/agent-grants');
}

// Admin: grants of one user
export function useAdminAgentGrants(userId: string) {
  return usePagedGrants(['admin', 'agent-grants', userId], '/v1/admin/agent-grants', {
    user_id: userId,
    include_inactive: 'true',
  });
}

export function useAdminRevokeGrant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (grantId: string) =>
      apiClient.delete(`/v1/admin/agent-grants/${encodeURIComponent(grantId)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'agent-grants'] }),
  });
}

export function useRevokeGrant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (grantId: string) =>
      apiClient.delete(`/v1/users/me/agent-grants/${encodeURIComponent(grantId)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agent-grants'] }),
  });
}

export function useCreateGrant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateGrantRequest) =>
      apiClient.post<CreateGrantResponse>('/v1/users/me/agent-grants', data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agent-grants'] }),
  });
}

// Endpoint status + grant limits for any signed-in user
export function useAgentEndpointInfo() {
  return useQuery({
    queryKey: ['agent-endpoint-info'],
    queryFn: () => apiClient.get<UserAgentEndpointInfo>('/v1/users/me/agent-endpoint'),
    retry: false,
    staleTime: 60_000,
  });
}

// Admin
export function useAgentEndpointSettings() {
  return useQuery({
    queryKey: ['admin', 'agent-endpoint', 'settings'],
    queryFn: () => apiClient.get<AgentEndpointSettings>('/v1/admin/agent-endpoint/settings'),
    retry: false,
  });
}

export function useUpdateAgentEndpointSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { dynamic_client_registration: boolean }) =>
      apiClient.put<AgentEndpointSettings>('/v1/admin/agent-endpoint/settings', data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'agent-endpoint', 'settings'] }),
  });
}

export function useOAuthClients() {
  return useQuery({
    queryKey: ['admin', 'oauth-clients'],
    queryFn: async () =>
      items(await apiClient.get<Paginated<OAuthClientSummary>>('/v1/admin/oauth-clients')),
    retry: false,
  });
}

export function useSetOAuthClientDisabled() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ clientId, disabled }: { clientId: string; disabled: boolean }) =>
      apiClient.patch<OAuthClientSummary>(
        `/v1/admin/oauth-clients/${encodeURIComponent(clientId)}`,
        {
          disabled,
        }
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'oauth-clients'] }),
  });
}

export function useCreateOAuthClient() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { client_name: string; redirect_uris: string[] }) =>
      apiClient.post<OAuthClientSummary>('/v1/admin/oauth-clients', data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'oauth-clients'] }),
  });
}

export function useDeleteOAuthClient() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (clientId: string) =>
      apiClient.delete(`/v1/admin/oauth-clients/${encodeURIComponent(clientId)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'oauth-clients'] }),
  });
}
