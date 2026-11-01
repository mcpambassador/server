import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/catalyst/button';
import { Badge } from '@/components/catalyst/badge';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { useSetPinPolicy } from '@/api/hooks/use-tool-pins';
import type { PinPolicy } from '@/api/tool-pin-types';

/** ADR-021: `review` queues changed tool definitions for an admin; `auto` approves them on sight. */
export function PinPolicyCard({ mcpId, policy }: { mcpId: string; policy?: PinPolicy }) {
  const current: PinPolicy = policy ?? 'review';
  const set = useSetPinPolicy(mcpId);
  const [confirmAuto, setConfirmAuto] = useState(false);

  const apply = async (next: PinPolicy) => {
    try {
      await set.mutateAsync(next);
      toast.success(`Pin policy set to ${next}`);
    } catch (e) {
      toast.error('Could not change pin policy', {
        description: (e as Error)?.message ?? String(e),
      });
    } finally {
      setConfirmAuto(false);
    }
  };

  return (
    <div className="rounded-lg bg-white p-6 ring-1 ring-zinc-950/10 dark:bg-white/5 dark:ring-white/10">
      <div className="flex items-center gap-3">
        <h3 className="text-base/7 font-semibold text-zinc-900 dark:text-white">
          Tool definition pinning
        </h3>
        <Badge color={current === 'review' ? 'green' : 'amber'} data-testid="pin-policy-badge">
          {current}
        </Badge>
      </div>
      <p className="mt-1 text-sm/6 text-zinc-500 dark:text-zinc-400">
        <strong>review</strong>: a changed tool definition is held until an admin approves it.{' '}
        <strong>auto</strong>: changes are approved automatically and reach agents unreviewed.
      </p>
      <div className="mt-4">
        {current === 'review' ? (
          <Button color="amber" onClick={() => setConfirmAuto(true)} disabled={set.isPending}>
            Switch to auto
          </Button>
        ) : (
          <Button onClick={() => apply('review')} disabled={set.isPending}>
            Switch to review
          </Button>
        )}
      </div>
      <ConfirmDialog
        open={confirmAuto}
        onClose={() => setConfirmAuto(false)}
        title="Approve tool changes automatically?"
        description="With auto, a downstream MCP can change a tool's description or schema and agents will see the new text without any review. Use it only for MCPs you fully control. Registry and imported MCPs cannot use auto."
        confirmLabel="Use auto"
        confirmColor="amber"
        onConfirm={() => apply('auto')}
        isLoading={set.isPending}
      />
    </div>
  );
}
