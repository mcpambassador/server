import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ADMIN_TOOL_PIN_REVOKE_ROUTE,
  type ToolPinRevokeRequest,
  type ToolPinRevokeResponse,
} from '@mcpambassador/contracts';
import { apiClient } from '../client';
import type {
  ToolPinSummary,
  ToolPinDetail,
  ToolPinQueueSummary,
  ToolPinDecisionRequest,
  PinPolicy,
} from '../tool-pin-types';

type Paginated<T> =
  | { data: T[]; pagination?: { has_more?: boolean; next_cursor?: string | null } }
  | T[];
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

export function useToolPins(params: {
  status?: string;
  baseline?: 'unreviewed';
  serving?: 'true';
}) {
  const p: Record<string, string> = { limit: '200' };
  if (params.status) p.status = params.status;
  if (params.baseline) p.baseline = params.baseline;
  if (params.serving) p.serving = params.serving;
  const q = useInfiniteQuery({
    queryKey: [...KEY, 'list', p],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      apiClient.get<Paginated<ToolPinSummary>>('/v1/admin/tool-pins', {
        params: { ...p, ...(pageParam ? { cursor: pageParam } : {}) },
      }),
    getNextPageParam: last =>
      !Array.isArray(last) && last.pagination?.has_more
        ? (last.pagination.next_cursor ?? undefined)
        : undefined,
  });
  return {
    ...q,
    pins: q.data ? q.data.pages.flatMap(pg => rows(pg)) : [],
    hasMore: !!q.hasNextPage,
    loadMore: () => void q.fetchNextPage(),
    loadingMore: q.isFetchingNextPage,
  };
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

/** G1: revoke an approved pin (hides the tool from agents immediately). Body: expected_hash = approved_hash. */
export function useRevokePin() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ pinId, ...body }: { pinId: string } & ToolPinRevokeRequest) =>
      apiClient.post<ToolPinRevokeResponse>(
        ADMIN_TOOL_PIN_REVOKE_ROUTE.replace(':pinId', encodeURIComponent(pinId)),
        body
      ),
    onSuccess: invalidate,
    onError: invalidate, // stale (409) or gone (404): show what the server has now
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
