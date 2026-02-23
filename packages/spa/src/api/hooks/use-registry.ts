import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../client';
import type { RegistryMcp, RegistryListResponse, RegistryInstallResponse, RegistryRefreshResponse } from '../types';

export function useRegistry(search?: string) {
  return useQuery({
    queryKey: ['admin', 'registry', search],
    queryFn: () =>
      apiClient.get<RegistryListResponse>('/v1/admin/registry', {
        params: search ? { search } : undefined,
      }),
  });
}

export function useRegistryMcp(name: string) {
  return useQuery({
    queryKey: ['admin', 'registry', name],
    queryFn: () => apiClient.get<RegistryMcp>(`/v1/admin/registry/${name}`),
    enabled: !!name,
  });
}

export function useInstallRegistryMcp() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (name: string) =>
      apiClient.post<RegistryInstallResponse>(`/v1/admin/registry/${name}/install`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'registry'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'mcps'] });
    },
  });
}

export function useRefreshRegistry() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () =>
      apiClient.post<RegistryRefreshResponse>('/v1/admin/registry/refresh', {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'registry'] });
    },
  });
}
