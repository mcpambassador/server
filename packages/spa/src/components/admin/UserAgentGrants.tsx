import { useState } from 'react';
import { toast } from 'sonner';
import { Subheading } from '@/components/catalyst/heading';
import { Text } from '@/components/catalyst/text';
import { Badge } from '@/components/catalyst/badge';
import { Button } from '@/components/catalyst/button';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { useAdminAgentGrants, useAdminRevokeGrant } from '@/api/hooks/use-agent';
import { grantStatus, type AgentGrantSummary } from '@/api/agent-types';

const statusColor = { active: 'green', expired: 'zinc', revoked: 'red' } as const;

/** Admin view of one user's remote agent grants, with revoke (ADR-020). */
export function UserAgentGrants({ userId }: { userId: string }) {
  const { grants, isLoading, error, hasMore, loadMore, loadingMore } = useAdminAgentGrants(userId);
  const revoke = useAdminRevokeGrant();
  const [pending, setPending] = useState<AgentGrantSummary | null>(null);

  const confirm = async () => {
    if (!pending) return;
    try {
      await revoke.mutateAsync(pending.grant_id);
      toast.success('Grant revoked');
    } catch (e) {
      toast.error('Failed to revoke grant', { description: (e as Error).message });
    } finally {
      setPending(null);
    }
  };

  return (
    <section className="mt-8" aria-label="Agent grants">
      <Subheading>Agent grants</Subheading>
      {isLoading ? (
        <Text className="mt-2">Loading…</Text>
      ) : error ? (
        <Text role="alert" className="mt-2">
          Could not load agent grants: {(error as Error).message}
        </Text>
      ) : !grants || grants.length === 0 ? (
        <Text className="mt-2 text-zinc-500">No agent grants</Text>
      ) : (
        <ul className="mt-2 divide-y divide-zinc-200 dark:divide-zinc-700">
          {grants.map(g => {
            const status = grantStatus(g);
            return (
              <li key={g.grant_id} className="flex items-center justify-between gap-4 py-2">
                <div className="min-w-0">
                  <div className="font-medium">{g.label}</div>
                  <Text className="text-xs">
                    {g.client_name ?? 'One-shot'} · {g.scopes.join(', ')} · expires{' '}
                    {new Date(g.expires_at).toLocaleString()}
                  </Text>
                </div>
                <div className="flex items-center gap-2">
                  <Badge color={statusColor[status]}>{status}</Badge>
                  {status === 'active' && (
                    <Button
                      plain
                      aria-label={`Revoke ${g.label}`}
                      onClick={() => setPending(g)}
                      disabled={revoke.isPending}
                    >
                      Revoke
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {hasMore && (
        <div className="mt-2">
          <Button outline onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={!!pending}
        onClose={open => {
          if (!open) setPending(null);
        }}
        isLoading={revoke.isPending}
        onConfirm={confirm}
        title="Revoke grant?"
        description={`The agent using "${pending?.label ?? ''}" loses access immediately.`}
        confirmLabel="Revoke"
      />
    </section>
  );
}
