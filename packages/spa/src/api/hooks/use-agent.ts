import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
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
} from '../agent-types';

type Paginated<T> = { data: T[]; pagination?: { has_more: boolean; total_count?: number } } | T[];

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
export function useAgentGrants() {
  return useQuery({
    queryKey: ['agent-grants'],
    queryFn: async () =>
      items(await apiClient.get<Paginated<AgentGrantSummary>>('/v1/users/me/agent-grants')),
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
