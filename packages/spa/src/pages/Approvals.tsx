import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Heading } from '@/components/catalyst/heading';
import { Text } from '@/components/catalyst/text';
import { Badge } from '@/components/catalyst/badge';
import { Button } from '@/components/catalyst/button';
import { EmptyState } from '@/components/shared/EmptyState';
import { usePageTitle } from '@/hooks/usePageTitle';
import { authApi } from '@/api/auth';
import { useApprovals } from '@/api/hooks/use-approvals';
import { DecisionDialog } from '@/components/approvals/DecisionDialog';
import { visibleText } from '@/lib/pin-text';
import type { ApprovalStatus } from '@mcpambassador/contracts';

const TABS: { key: 'pending' | 'history'; label: string }[] = [
  { key: 'pending', label: 'Pending' },
  { key: 'history', label: 'History' },
];

/** Waits for the session so the right (admin or user) endpoints are used from the first request. */
export function Approvals() {
  usePageTitle('Approvals');
  const { data: session } = useQuery({ queryKey: ['session'], queryFn: authApi.getSession });
  if (!session) return <Text>Loading…</Text>;
  return <ApprovalsView isAdmin={session.user.isAdmin === true} />;
}

function ApprovalsView({ isAdmin }: { isAdmin: boolean }) {
  const navigate = useNavigate();
  const { approvalId } = useParams<{ approvalId?: string }>();
  const [tab, setTab] = useState<'pending' | 'history'>('pending');
  const status: ApprovalStatus | undefined = tab === 'pending' ? 'pending' : undefined;
  const q = useApprovals(isAdmin, status);
  const items = tab === 'history' ? q.items.filter(i => i.status !== 'pending') : q.items;

  return (
    <div className="space-y-6">
      <div>
        <Heading>Approvals</Heading>
        <Text>
          {isAdmin
            ? 'Tool calls waiting for a human yes, across all agents.'
            : 'Tool calls from your agents that are waiting for your yes.'}
        </Text>
      </div>
      <div className="flex gap-2">
        {TABS.map(t => (
          tab === t.key ? (
            <Button key={t.key} onClick={() => setTab(t.key)} data-testid={`tab-${t.key}`}>
              {t.label}
            </Button>
          ) : (
            <Button key={t.key} outline onClick={() => setTab(t.key)} data-testid={`tab-${t.key}`}>
              {t.label}
            </Button>
          )
        ))}
      </div>
      {q.isLoading && <Text>Loading…</Text>}
      {q.isError && <Text className="text-red-600">Could not load approvals.</Text>}
      {!q.isLoading && !q.isError && items.length === 0 && (
        <EmptyState
          title={tab === 'pending' ? 'Nothing waiting' : 'No history yet'}
          description={
            tab === 'pending'
              ? 'When an agent calls a tool that needs approval, it shows up here.'
              : 'Decided and expired requests show up here.'
          }
        />
      )}
      <ul className="divide-y divide-zinc-950/10 dark:divide-white/10" data-testid="approval-list">
        {items.map(a => (
          <li key={a.approval_id} className="flex items-center gap-3 py-3">
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-sm font-medium">
                {visibleText(a.mcp_name)} / {visibleText(a.tool_name)}
              </p>
              <p className="truncate text-xs text-zinc-500">
                {visibleText(a.grant_label)} · {new Date(a.created_at).toLocaleString()}
              </p>
            </div>
            {a.required_approver === 'admin' && <Badge color="amber">admin only</Badge>}
            <Badge>{a.status}</Badge>
            <Button onClick={() => navigate(`/app/approvals/${encodeURIComponent(a.approval_id)}`)}>
              {a.status === 'pending' ? 'Review' : 'View'}
            </Button>
          </li>
        ))}
      </ul>
      {q.hasNextPage && (
        <Button outline onClick={q.loadMore} disabled={q.isFetchingNextPage}>
          Load more
        </Button>
      )}
      {approvalId && (
        <DecisionDialog
          key={approvalId}
          approvalId={approvalId}
          isAdmin={isAdmin}
          onClose={() => navigate('/app/approvals')}
        />
      )}
    </div>
  );
}
