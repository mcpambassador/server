import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../client';
import type { CredentialStatus, SetCredentialsRequest } from '../types';

export function useCredentialStatus() {
  return useQuery({
    queryKey: ['credentials'],
    queryFn: () => apiClient.get<CredentialStatus[]>('/v1/users/me/credentials'),
  });
}

export function useSetCredentials() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ mcpId, data }: { mcpId: string; data: SetCredentialsRequest }) =>
      apiClient.put(`/v1/users/me/credentials/${mcpId}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['credentials'] });
    },
  });
}

export function useDeleteCredentials() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (mcpId: string) =>
      apiClient.delete(`/v1/users/me/credentials/${mcpId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['credentials'] });
    },
  });
}
