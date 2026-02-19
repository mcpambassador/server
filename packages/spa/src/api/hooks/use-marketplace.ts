import { useQuery } from '@tanstack/react-query';
import { apiClient } from '../client';
import type { PaginatedResponse, McpEntry } from '../types';

export function useMarketplace() {
  return useQuery({
    queryKey: ['marketplace'],
    queryFn: () => apiClient.get<PaginatedResponse<McpEntry>>('/v1/marketplace'),
  });
}

export function useMcpDetail(mcpId: string) {
  return useQuery({
    queryKey: ['marketplace', mcpId],
    queryFn: () => apiClient.get<McpEntry>(`/v1/marketplace/${mcpId}`),
    enabled: !!mcpId,
  });
}
