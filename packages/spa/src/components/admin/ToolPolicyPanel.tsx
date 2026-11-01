import { useState } from 'react';
import { toast } from 'sonner';
import type { Approver } from '@mcpambassador/contracts';
import { Button } from '@/components/catalyst/button';
import { Badge } from '@/components/catalyst/badge';
import { Select } from '@/components/catalyst/select';
import {
  useToolPolicies,
  usePutToolPolicy,
  useSetApprovalDefault,
} from '@/api/hooks/use-approvals';
import { visibleText } from '@/lib/pin-text';

const CHOOSE = '';

/** One row's approver choice has NO default: turning a gate on needs an explicit owner/admin pick. */
function ToolRow({ mcpId, tool }: { mcpId: string; tool: string }) {
  const { data: policies } = useToolPolicies(mcpId);
  const put = usePutToolPolicy(mcpId);
  const current = policies?.find(p => p.tool_name === tool);
  const gated = current?.requires_approval === true;
  const [choosing, setChoosing] = useState(false);
  const [approver, setApprover] = useState<string>(CHOOSE);

  const save = async (body: { requires_approval: boolean; approver?: Approver }) => {
    try {
      await put.mutateAsync({ toolName: tool, ...body });
      toast.success(body.requires_approval ? 'Approval required' : 'Approval no longer required');
      setChoosing(false);
      setApprover(CHOOSE);
    } catch (e) {
      toast.error('Could not update tool policy', { description: (e as Error)?.message });
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-3 py-2" data-testid={`policy-row-${tool}`}>
      <code className="min-w-0 flex-1 truncate text-sm">{visibleText(tool)}</code>
      {gated && <Badge color="amber">needs {current?.approver}</Badge>}
      {gated ? (
        <Button
          outline
          disabled={put.isPending}
          onClick={() => void save({ requires_approval: false })}
        >
          Remove approval
        </Button>
      ) : choosing ? (
        <>
          <Select
            aria-label={`Who approves ${tool}`}
            value={approver}
            onChange={e => setApprover(e.target.value)}
            className="max-w-40"
          >
            <option value={CHOOSE}>Choose approver…</option>
            <option value="owner">Grant owner</option>
            <option value="admin">Admin only</option>
          </Select>
          <Button
            disabled={approver === CHOOSE || put.isPending}
            onClick={() => void save({ requires_approval: true, approver: approver as Approver })}
          >
            Require approval
          </Button>
          <Button plain onClick={() => setChoosing(false)}>
            Cancel
          </Button>
        </>
      ) : (
        <Button outline onClick={() => setChoosing(true)}>
          Require approval
        </Button>
      )}
    </div>
  );
}

export function ToolPolicyPanel({
  mcpId,
  toolNames,
  defaultRequires,
  defaultApprover,
}: {
  mcpId: string;
  toolNames: string[];
  defaultRequires?: boolean;
  defaultApprover?: Approver;
}) {
  const setDefault = useSetApprovalDefault(mcpId);
  const [choosing, setChoosing] = useState(false);
  const [approver, setApprover] = useState<string>(CHOOSE);

  const apply = async (body: Parameters<typeof setDefault.mutateAsync>[0]) => {
    try {
      await setDefault.mutateAsync(body);
      toast.success('MCP approval default updated');
      setChoosing(false);
      setApprover(CHOOSE);
    } catch (e) {
      toast.error('Could not update the default', { description: (e as Error)?.message });
    }
  };

  return (
    <div className="rounded-lg bg-white p-6 ring-1 ring-zinc-950/10 dark:bg-white/5 dark:ring-white/10">
      <div className="flex items-center gap-3">
        <h3 className="text-base/7 font-semibold text-zinc-900 dark:text-white">Human approval</h3>
        {defaultRequires && (
          <Badge color="amber" data-testid="approval-default-badge">
            new tools need {defaultApprover}
          </Badge>
        )}
      </div>
      <p className="mt-1 text-sm/6 text-zinc-500 dark:text-zinc-400">
        A tool that needs approval is held until a person says yes to each call. The MCP default
        applies to tools first seen after you set it.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {defaultRequires ? (
          <Button
            outline
            disabled={setDefault.isPending}
            onClick={() => void apply({ default_requires_approval: false })}
          >
            Stop requiring approval for new tools
          </Button>
        ) : choosing ? (
          <>
            <Select
              aria-label="Who approves new tools"
              value={approver}
              onChange={e => setApprover(e.target.value)}
              className="max-w-40"
            >
              <option value={CHOOSE}>Choose approver…</option>
              <option value="owner">Grant owner</option>
              <option value="admin">Admin only</option>
            </Select>
            <Button
              disabled={approver === CHOOSE || setDefault.isPending}
              onClick={() =>
                void apply({
                  default_requires_approval: true,
                  default_approver: approver as Approver,
                })
              }
            >
              Require for new tools
            </Button>
            <Button plain onClick={() => setChoosing(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button outline onClick={() => setChoosing(true)}>
            Require approval for new tools
          </Button>
        )}
      </div>
      {toolNames.length > 0 && (
        <div className="mt-4 divide-y divide-zinc-950/10 dark:divide-white/10">
          {toolNames.map(n => (
            <ToolRow key={n} mcpId={mcpId} tool={n} />
          ))}
        </div>
      )}
    </div>
  );
}
