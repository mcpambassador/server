import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ADMIN_APPROVALS_ROUTE,
  ADMIN_APPROVALS_SUMMARY_ROUTE,
  ADMIN_APPROVAL_DECISION_ROUTE,
  ADMIN_APPROVAL_ROUTE,
  ADMIN_MCP_APPROVAL_DEFAULT_ROUTE,
  ADMIN_MCP_TOOL_POLICIES_ROUTE,
  ADMIN_MCP_TOOL_POLICY_ROUTE,
  AUTH_REAUTH_ROUTE,
  USER_APPROVALS_ROUTE,
  USER_APPROVALS_SUMMARY_ROUTE,
  USER_APPROVAL_DECISION_ROUTE,
  USER_APPROVAL_ROUTE,
  type ApprovalDecisionRequest,
  type ApprovalListResponse,
  type ApprovalQueueSummary,
  type ApprovalRequestDetail,
  type ApprovalStatus,
  type PutToolPolicyRequest,
  type ReauthRequest,
  type ReauthResponse,
  type SetApprovalDefaultRequest,
  type ToolPolicy,
  type ToolPolicyListResponse,
} from '@mcpambassador/contracts';
import { apiClient } from '../client';

const KEY = ['approvals'] as const;

/** Admins use the admin routes (all requests); everyone else only sees their own grants' requests. */
const routes = (isAdmin: boolean) =>
  isAdmin
    ? {
        list: ADMIN_APPROVALS_ROUTE,
        summary: ADMIN_APPROVALS_SUMMARY_ROUTE,
        one: ADMIN_APPROVAL_ROUTE,
        decide: ADMIN_APPROVAL_DECISION_ROUTE,
      }
    : {
        list: USER_APPROVALS_ROUTE,
        summary: USER_APPROVALS_SUMMARY_ROUTE,
        one: USER_APPROVAL_ROUTE,
        decide: USER_APPROVAL_DECISION_ROUTE,
      };

export function useApprovalSummary(isAdmin: boolean, enabled = true) {
  return useQuery({
    queryKey: [...KEY, 'summary', isAdmin],
    queryFn: () => apiClient.get<ApprovalQueueSummary>(routes(isAdmin).summary),
    enabled,
    refetchInterval: 30_000,
    retry: false,
  });
}

export function useApprovals(isAdmin: boolean, status?: ApprovalStatus) {
  const q = useInfiniteQuery({
    queryKey: [...KEY, 'list', isAdmin, status ?? 'all'],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      apiClient.get<ApprovalListResponse>(routes(isAdmin).list, {
        params: {
          limit: '50',
          ...(status ? { status } : {}),
          ...(pageParam ? { cursor: pageParam } : {}),
        },
      }),
    getNextPageParam: last => last.next_cursor ?? undefined,
  });
  return {
    ...q,
    items: q.data ? q.data.pages.flatMap(p => p.items) : [],
    loadMore: () => void q.fetchNextPage(),
  };
}

/** Always fetched fresh: the dialog must show the server's current state and hash. */
export function useApproval(isAdmin: boolean, approvalId: string | null) {
  return useQuery({
    queryKey: [...KEY, 'detail', isAdmin, approvalId],
    queryFn: () =>
      apiClient.get<ApprovalRequestDetail>(
        routes(isAdmin).one.replace(':approvalId', encodeURIComponent(approvalId!))
      ),
    enabled: !!approvalId,
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
}

export function useDecideApproval(isAdmin: boolean) {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: KEY });
  return useMutation({
    mutationFn: ({ approvalId, ...body }: { approvalId: string } & ApprovalDecisionRequest) =>
      apiClient.post<ApprovalRequestDetail>(
        routes(isAdmin).decide.replace(':approvalId', encodeURIComponent(approvalId)),
        body
      ),
    onSuccess: invalidate,
    onError: invalidate, // stale (409) or gone: show what the server has now
  });
}

/** Step-up: the password is sent once and never kept. */
export function useReauth() {
  return useMutation({
    mutationFn: (body: ReauthRequest) => apiClient.post<ReauthResponse>(AUTH_REAUTH_ROUTE, body),
  });
}

// ----- Tool policies (admin) -----

const POLICY_KEY = ['admin', 'tool-policies'] as const;

export function useToolPolicies(mcpId: string) {
  return useQuery({
    queryKey: [...POLICY_KEY, mcpId],
    queryFn: async () =>
      (
        await apiClient.get<ToolPolicyListResponse>(
          ADMIN_MCP_TOOL_POLICIES_ROUTE.replace(':mcpId', encodeURIComponent(mcpId))
        )
      ).policies,
    retry: false,
  });
}

export function usePutToolPolicy(mcpId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ toolName, ...body }: { toolName: string } & PutToolPolicyRequest) =>
      apiClient.put<ToolPolicy>(
        ADMIN_MCP_TOOL_POLICY_ROUTE.replace(':mcpId', encodeURIComponent(mcpId)).replace(
          ':toolName',
          encodeURIComponent(toolName)
        ),
        body
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...POLICY_KEY, mcpId] }),
  });
}

export function useSetApprovalDefault(mcpId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SetApprovalDefaultRequest) =>
      apiClient.patch<unknown>(
        ADMIN_MCP_APPROVAL_DEFAULT_ROUTE.replace(':mcpId', encodeURIComponent(mcpId)),
        body
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'mcps'] });
    },
  });
}
