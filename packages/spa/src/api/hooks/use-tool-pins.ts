import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../client';
import type {
  ToolPinSummary,
  ToolPinDetail,
  ToolPinQueueSummary,
  ToolPinDecisionRequest,
  PinPolicy,
} from '../tool-pin-types';

type Paginated<T> = { data: T[] } | T[];
const rows = <T>(r: Paginated<T> | undefined): T[] => (!r ? [] : Array.isArray(r) ? r : r.data);

const KEY = ['admin', 'tool-pins'] as const;

export function useToolPinSummary(enabled = true) {
  return useQuery({
    queryKey: [...KEY, 'summary'],
    queryFn: () => apiClient.get<ToolPinQueueSummary>('/v1/admin/tool-pins/summary'),
    enabled,
    refetchInterval: 60_000,
    retry: false,
  });
}

export function useToolPins(params: { status?: string; baseline?: 'unreviewed' }) {
  const p: Record<string, string> = { limit: '200' };
  if (params.status) p.status = params.status;
  if (params.baseline) p.baseline = params.baseline;
  const q = useQuery({
    queryKey: [...KEY, 'list', p],
    queryFn: () => apiClient.get<Paginated<ToolPinSummary>>('/v1/admin/tool-pins', { params: p }),
  });
  return { ...q, pins: rows(q.data) };
}

export function useToolPin(pinId: string | null) {
  return useQuery({
    queryKey: [...KEY, 'detail', pinId],
    queryFn: () =>
      apiClient.get<ToolPinDetail>(`/v1/admin/tool-pins/${encodeURIComponent(pinId!)}`),
    enabled: !!pinId,
  });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: KEY });
}

export function useDecidePin(action: 'approve' | 'reject') {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ pinId, ...body }: { pinId: string } & ToolPinDecisionRequest) =>
      apiClient.post<ToolPinDetail>(
        `/v1/admin/tool-pins/${encodeURIComponent(pinId)}/${action}`,
        body
      ),
    onSuccess: invalidate,
  });
}

export function useConfirmBaseline() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ pinId, expected_hash }: { pinId: string; expected_hash: string }) =>
      apiClient.post<ToolPinDetail>(
        `/v1/admin/tool-pins/${encodeURIComponent(pinId)}/confirm-baseline`,
        { expected_hash }
      ),
    onSuccess: invalidate,
  });
}

export function useSetPinPolicy(mcpId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (pin_policy: PinPolicy) =>
      apiClient.patch<unknown>(`/v1/admin/mcps/${encodeURIComponent(mcpId)}/pin-policy`, {
        pin_policy,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'mcps'] });
      void qc.invalidateQueries({ queryKey: KEY });
    },
  });
}
