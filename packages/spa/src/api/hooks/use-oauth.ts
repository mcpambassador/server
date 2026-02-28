import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../client';

interface OAuthAuthorizeResponse {
  authorization_url: string;
  state: string;
}

interface OAuthStatus {
  mcp_name: string;
  status: 'not_connected' | 'active' | 'expired' | 'revoked';
  expires_at: string | null;
  scopes: string | null;
}

interface OAuthDisconnectResponse {
  mcp_name: string;
  status: 'disconnected';
}

export function useOAuthAuthorize() {
  return useMutation({
    mutationFn: (mcpName: string) =>
      apiClient.post<OAuthAuthorizeResponse>('/v1/users/me/oauth/authorize', { mcp_name: mcpName }),
  });
}

export function useOAuthStatus(mcpName: string, enabled = true) {
  return useQuery({
    queryKey: ['oauth', 'status', mcpName],
    queryFn: () => apiClient.get<OAuthStatus>(`/v1/users/me/oauth/status/${mcpName}`),
    enabled: enabled && !!mcpName,
  });
}

export function useOAuthDisconnect() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (mcpName: string) =>
      apiClient.delete<OAuthDisconnectResponse>(`/v1/users/me/oauth/disconnect/${mcpName}`),
    onSuccess: (_, mcpName) => {
      queryClient.invalidateQueries({ queryKey: ['oauth', 'status', mcpName] });
      queryClient.invalidateQueries({ queryKey: ['credentials'] });
    },
  });
}
