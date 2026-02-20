import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../client';
import type {
  Client,
  CreateClientRequest,
  CreateClientResponse,
  UpdateClientRequest,
  Subscription,
  CreateSubscriptionRequest,
  UpdateSubscriptionRequest,
} from '../types';

// Clients
export function useClients() {
  return useQuery({
    queryKey: ['clients'],
    queryFn: () => apiClient.get<{ data: Client[] }>('/v1/users/me/clients'),
    select: (response) => response.data,
  });
}

export function useClient(clientId: string) {
  return useQuery({
    queryKey: ['clients', clientId],
    queryFn: () => apiClient.get<Client>(`/v1/users/me/clients/${clientId}`),
    enabled: !!clientId,
  });
}

export function useCreateClient() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (data: CreateClientRequest) =>
      apiClient.post<CreateClientResponse>('/v1/users/me/clients', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['clients'] });
    },
  });
}

export function useUpdateClient() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ clientId, data }: { clientId: string; data: UpdateClientRequest }) =>
      apiClient.patch<Client>(`/v1/users/me/clients/${clientId}`, data),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['clients'] });
      queryClient.invalidateQueries({ queryKey: ['clients', variables.clientId] });
    },
  });
}

export function useDeleteClient() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (clientId: string) =>
      apiClient.delete(`/v1/users/me/clients/${clientId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['clients'] });
    },
  });
}

// Subscriptions
export function useClientSubscriptions(clientId: string) {
  return useQuery({
    queryKey: ['clients', clientId, 'subscriptions'],
    queryFn: () =>
      apiClient.get<Subscription[]>(`/v1/users/me/clients/${clientId}/subscriptions`),
    enabled: !!clientId,
  });
}

export function useSubscribe() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ clientId, data }: { clientId: string; data: CreateSubscriptionRequest }) =>
      apiClient.post<Subscription>(`/v1/users/me/clients/${clientId}/subscriptions`, data),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['clients', variables.clientId, 'subscriptions'] });
    },
  });
}

export function useUpdateSubscription() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({
      clientId,
      subscriptionId,
      data,
    }: {
      clientId: string;
      subscriptionId: string;
      data: UpdateSubscriptionRequest;
    }) =>
      apiClient.patch<Subscription>(
        `/v1/users/me/clients/${clientId}/subscriptions/${subscriptionId}`,
        data
      ),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['clients', variables.clientId, 'subscriptions'] });
    },
  });
}

export function useUnsubscribe() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ clientId, subscriptionId }: { clientId: string; subscriptionId: string }) =>
      apiClient.delete(`/v1/users/me/clients/${clientId}/subscriptions/${subscriptionId}`),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['clients', variables.clientId, 'subscriptions'] });
    },
  });
}
