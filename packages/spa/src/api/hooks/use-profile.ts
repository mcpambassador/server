import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../client';
import type { User, ChangePasswordRequest } from '../types';

export function useProfile() {
  return useQuery({
    queryKey: ['profile'],
    queryFn: () => apiClient.get<{ data: User }>('/v1/users/me'),
    select: (response) => response.data,
  });
}

export function useChangePassword() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (data: ChangePasswordRequest) =>
      apiClient.patch('/v1/users/me/password', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['profile'] });
      queryClient.invalidateQueries({ queryKey: ['session'] });
    },
  });
}
