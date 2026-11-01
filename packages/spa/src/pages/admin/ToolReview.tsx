import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ShieldExclamationIcon } from '@heroicons/react/20/solid';
import { Heading } from '@/components/catalyst/heading';
import { Text } from '@/components/catalyst/text';
import { Badge } from '@/components/catalyst/badge';
import { Button } from '@/components/catalyst/button';
import { Dialog, DialogTitle, DialogBody, DialogActions } from '@/components/catalyst/dialog';
import { Checkbox, CheckboxField } from '@/components/catalyst/checkbox';
import { Field, Label } from '@/components/catalyst/fieldset';
import { Textarea } from '@/components/catalyst/textarea';
import { EmptyState } from '@/components/shared/EmptyState';
import { usePageTitle } from '@/hooks/usePageTitle';
import {
  useToolPins,
  useToolPin,
  useToolPinSummary,
  useDecidePin,
  useConfirmBaseline,
} from '@/api/hooks/use-tool-pins';
import { NON_APPROVABLE_FLAGS } from '@/api/tool-pin-types';
import type { ToolPinSummary, ToolDefinition } from '@/api/tool-pin-types';
import type { DiffOp } from '@/lib/pin-text';
import {
  visibleText,
  splitAtCodePoints,
  codePointLength,
  lineDiff,
  hasLongLine,
  DIFF_LINE_MAX_CODEPOINTS,
  AGENT_DESCRIPTION_CODEPOINTS,
} from '@/lib/pin-text';

const FLAG_HELP: Record<string, string> = {
  instruction_phrase: 'Description contains instruction-like phrasing',
  references_other_tool_or_file: 'Refers to another tool or a file path',
  hidden_unicode: 'Contains zero-width or other invisible characters',
  bidi_unicode: 'Contains bidirectional-text control characters',
  long_description: 'Unusually long description',
  base64_blob: 'Contains a base64-like blob',
  markup: 'Contains markup or HTML-like text',
  canonical_too_large: 'Definition exceeds the 64 KiB size cap; not displayed, never approvable',
  baseline_mismatch: 'Differs from the pre-pinning catalog snapshot',
  reserved_name: 'Uses the reserved ambassador__ prefix (never approvable)',
  invalid_definition: 'Definition failed validation (never approvable)',
  truncated_on_serve: 'Description is longer than 500 code points; agents only see the first 500',
  duplicate_name: 'Another MCP serves the same tool name; both are hidden (never approvable)',
};

const MAX_BLOCK_CHARS = 2000;

/** Render a definition as plain text for review and diffing. */
function defToText(def: ToolDefinition | null): string {
  if (!def) return '';
  const lines: string[] = [`name: ${def.name}`];
  if (def.title !== undefined) lines.push(`title: ${def.title}`);
  if (def.description !== undefined) lines.push('description:', ...def.description.split('\n'));
  for (const key of ['inputSchema', 'outputSchema', 'annotations'] as const) {
    if (def[key] !== undefined)
      lines.push(`${key}:`, ...JSON.stringify(def[key], null, 2).split('\n'));
  }
  // Icons are metadata only: shown as text, never rendered as <img> or fetched.
  for (const icon of def.icons ?? []) {
    lines.push(`icon: src=${String(icon.src ?? '')} mimeType=${String(icon.mimeType ?? '')}`);
  }
  return lines.join('\n');
}

function FlagBadges({ pin }: { pin: ToolPinSummary }) {
  const codes = pin.flags?.codes ?? [];
  if (codes.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {codes.map(c => (
        <Badge
          key={c}
          color={NON_APPROVABLE_FLAGS.includes(c) ? 'red' : 'amber'}
          title={FLAG_HELP[c]}
          data-testid={`flag-${c}`}
        >
          {visibleText(String(c))}
        </Badge>
      ))}
    </span>
  );
}

function TextBlock({
  text,
  testId,
  onFull,
}: {
  text: string;
  testId?: string;
  onFull?: () => void;
}) {
  const [full, setFull] = useState(false);
  const long = codePointLength(text) > MAX_BLOCK_CHARS;
  const shown = long && !full ? splitAtCodePoints(text, MAX_BLOCK_CHARS).head : text;
  return (
    <div data-testid={testId}>
      <pre className="max-h-80 overflow-auto rounded-md bg-zinc-100 p-2 font-mono text-xs break-words whitespace-pre-wrap dark:bg-zinc-800">
        {visibleText(shown)}
        {long && !full ? '…' : ''}
      </pre>
      {long && (
        <button
          type="button"
          className="mt-1 text-xs text-violet-600 underline dark:text-violet-400"
          onClick={() => {
            setFull(f => !f);
            if (!full) onFull?.();
          }}
        >
          {full ? 'Show less' : `Show all (${codePointLength(text).toLocaleString()} characters)`}
        </button>
      )}
    </div>
  );
}

function Diff({ ops, hiddenLines }: { ops: DiffOp[]; hiddenLines: number }) {
  return (
    <div>
      <pre
        data-testid="pin-diff"
        className="max-h-96 overflow-auto rounded-md bg-zinc-100 p-2 font-mono text-xs break-words whitespace-pre-wrap dark:bg-zinc-800"
      >
        {ops.map((o, i) => {
          const { head, tail } = splitAtCodePoints(o.line, DIFF_LINE_MAX_CODEPOINTS);
          return (
            <div
              key={i}
              className={
                o.kind === 'add'
                  ? 'bg-green-500/15'
                  : o.kind === 'del'
                    ? 'bg-red-500/15'
                    : undefined
              }
            >
              {o.kind === 'add' ? '+ ' : o.kind === 'del' ? '- ' : '  '}
              {visibleText(head)}
              {tail && (
                <span className="font-sans font-bold text-red-600">
                  {' '}
                  [line truncated: {codePointLength(tail).toLocaleString()} more characters]
                </span>
              )}
            </div>
          );
        })}
        {hiddenLines > 0 && (
          <div className="font-sans font-bold text-red-600">
            [diff truncated: {hiddenLines.toLocaleString()} more lines not shown]
          </div>
        )}
      </pre>
    </div>
  );
}

/** Shows what the agent actually receives: the first 500 code points, with a marker at the cut. */
function AgentVisible({ description }: { description: string }) {
  const { head, tail } = splitAtCodePoints(description, AGENT_DESCRIPTION_CODEPOINTS);
  if (!tail) return null;
  return (
    <div data-testid="agent-visible" className="space-y-1">
      <Text className="font-medium">
        Agent-visible description (first {AGENT_DESCRIPTION_CODEPOINTS} of{' '}
        {codePointLength(description).toLocaleString()} code points)
      </Text>
      <pre className="rounded-md bg-zinc-100 p-2 font-mono text-xs whitespace-pre-wrap break-words dark:bg-zinc-800">
        {visibleText(head)}
        <span className="font-sans font-bold text-red-600"> ✂ cut here — agents do not see: </span>
        <span className="opacity-50">
          {visibleText(
            codePointLength(tail) > MAX_BLOCK_CHARS
              ? `${splitAtCodePoints(tail, MAX_BLOCK_CHARS).head}…`
              : tail
          )}
        </span>
      </pre>
    </div>
  );
}

function ReviewDialog({
  pin,
  mode,
  onClose,
}: {
  pin: ToolPinSummary | null;
  mode: 'pending' | 'baseline';
  onClose: () => void;
}) {
  const { data: detail, isLoading, isError } = useToolPin(pin?.pin_id ?? null);
  const approve = useDecidePin('approve');
  const reject = useDecidePin('reject');
  const confirm = useConfirmBaseline();
  const [allUsers, setAllUsers] = useState(false);
  const [reason, setReason] = useState('');
  const [fullSeen, setFullSeen] = useState(false);
  const approvedText = defToText(detail?.approved_definition ?? null);
  const pendingText = defToText(detail?.pending_definition ?? null);
  const diff = useMemo(() => lineDiff(approvedText, pendingText), [approvedText, pendingText]);

  if (!pin) return null;
  const codes: string[] = detail?.flags?.codes ?? pin.flags?.codes ?? [];
  const blocked = codes.some(c => NON_APPROVABLE_FLAGS.includes(c));
  const oversize = codes.includes('canonical_too_large');
  const reviewText = mode === 'pending' ? pendingText : approvedText;
  // Anything the diff cut off, or a long text still collapsed, must be read in full before approving.
  const truncated =
    !oversize &&
    ((mode === 'pending' && (diff.hiddenLines > 0 || hasLongLine(diff.ops))) ||
      codePointLength(reviewText) > MAX_BLOCK_CHARS);
  const needsFull = truncated && !fullSeen;
  const busy = approve.isPending || reject.isPending || confirm.isPending;

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast.success(ok);
      onClose();
    } catch (e) {
      toast.error('Action failed', { description: (e as Error)?.message ?? String(e) });
    }
  };

  const pendingHash = detail?.pending_hash ?? pin.pending_hash;
  const approvedHash = detail?.approved_hash ?? pin.approved_hash;
  const shown = mode === 'baseline' ? detail?.approved_definition : detail?.pending_definition;
  const description = shown?.description;

  return (
    <Dialog open onClose={onClose} size="4xl">
      <DialogTitle>
        Review tool: <span data-testid="review-tool-name">{visibleText(pin.tool_name)}</span>
      </DialogTitle>
      <DialogBody className="space-y-4">
        <Text>
          MCP <strong>{visibleText(pin.mcp_name)}</strong> ·{' '}
          {pin.scope_user_id ? `user ${visibleText(pin.scope_user_id)}` : 'shared'}
        </Text>
        <FlagBadges pin={pin} />
        {codes.map(c => (
          <Text key={c} className="text-xs">
            <code>{visibleText(String(c))}</code>: {FLAG_HELP[c] ?? 'Unknown rule'}
          </Text>
        ))}
        {isLoading && <Text>Loading definition…</Text>}
        {isError && <Text className="text-red-600">Could not load the definition.</Text>}
        {detail && oversize && (
          <Text data-testid="oversize-marker" className="font-medium text-red-600">
            Definition too large to display. It cannot be approved.
          </Text>
        )}
        {detail && !oversize && mode === 'pending' && (
          <>
            <Text className="font-medium">
              {detail.approved_definition
                ? 'Changes since the approved definition'
                : 'New tool (no approved definition)'}
            </Text>
            <Diff ops={diff.ops} hiddenLines={diff.hiddenLines} />
            <Text className="font-medium">Full pending definition</Text>
            <TextBlock text={pendingText} testId="pin-full" onFull={() => setFullSeen(true)} />
          </>
        )}
        {detail && !oversize && mode === 'baseline' && (
          <>
            <Text className="font-medium">
              Approved by the one-time migration baseline; never reviewed by a person.
            </Text>
            <TextBlock text={approvedText} testId="pin-full" onFull={() => setFullSeen(true)} />
          </>
        )}
        {detail && !oversize && description && <AgentVisible description={description} />}
        {mode === 'pending' && !blocked && pin.scope_user_id && (
          <CheckboxField>
            <Checkbox checked={allUsers} onChange={setAllUsers} />
            <Label>Apply to all users (same definition needs no further review)</Label>
          </CheckboxField>
        )}
        {mode === 'pending' && (
          <Field>
            <Label>Reason (optional, max 500)</Label>
            <Textarea
              value={reason}
              maxLength={500}
              onChange={e => setReason(e.target.value)}
              rows={2}
            />
          </Field>
        )}
        {needsFull && (
          <Text data-testid="truncation-warning" className="font-medium text-amber-600">
            Part of this definition is hidden above. Open &quot;Show all&quot; on the full text
            before approving.
          </Text>
        )}
        {blocked && (
          <Text className="text-red-600">This definition is never approvable. Reject it only.</Text>
        )}
      </DialogBody>
      <DialogActions>
        <Button plain onClick={onClose} disabled={busy}>
          Close
        </Button>
        {mode === 'pending' ? (
          <>
            <Button
              color="red"
              disabled={busy || !pendingHash}
              onClick={() =>
                run(
                  () =>
                    reject.mutateAsync({
                      pinId: pin.pin_id,
                      expected_hash: pendingHash!,
                      reason: reason || undefined,
                    }),
                  'Definition rejected'
                )
              }
            >
              Reject
            </Button>
            <Button
              color="green"
              disabled={busy || blocked || needsFull || !pendingHash || !detail}
              onClick={() =>
                run(
                  () =>
                    approve.mutateAsync({
                      pinId: pin.pin_id,
                      expected_hash: pendingHash!,
                      apply_to: allUsers ? 'all_users' : 'this_scope',
                      reason: reason || undefined,
                    }),
                  'Definition approved'
                )
              }
            >
              Approve
            </Button>
          </>
        ) : (
          <Button
            color="green"
            disabled={busy || blocked || needsFull || !approvedHash || !detail}
            onClick={() =>
              run(
                () => confirm.mutateAsync({ pinId: pin.pin_id, expected_hash: approvedHash! }),
                'Baseline confirmed'
              )
            }
          >
            Confirm baseline
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}

function PinGroups({
  pins,
  onReview,
  empty,
}: {
  pins: ToolPinSummary[];
  onReview: (p: ToolPinSummary) => void;
  empty: string;
}) {
  const groups = useMemo(() => {
    const m = new Map<string, ToolPinSummary[]>();
    for (const p of pins) {
      const k = `${p.mcp_id}|${p.scope_user_id ?? ''}`;
      m.set(k, [...(m.get(k) ?? []), p]);
    }
    return [...m.values()];
  }, [pins]);
  if (pins.length === 0) {
    return <EmptyState icon={<ShieldExclamationIcon className="h-6 w-6" />} title={empty} />;
  }
  return (
    <div className="space-y-6">
      {groups.map(g => (
        <section key={`${g[0]!.mcp_id}|${g[0]!.scope_user_id ?? ''}`} className="space-y-2">
          <h3 className="text-sm font-semibold text-zinc-950 dark:text-white">
            {visibleText(g[0]!.mcp_name)}{' '}
            <span className="font-normal text-zinc-500">
              · {g[0]!.scope_user_id ? `user ${visibleText(g[0]!.scope_user_id)}` : 'shared'} ·{' '}
              {g.length} tool{g.length === 1 ? '' : 's'}
            </span>
          </h3>
          <ul className="divide-y divide-zinc-950/5 rounded-lg border border-zinc-950/10 dark:divide-white/10 dark:border-white/10">
            {g.map(p => (
              <li key={p.pin_id} className="flex flex-wrap items-center gap-3 p-3">
                <span className="font-mono text-sm">{visibleText(p.tool_name)}</span>
                {p.approved_hash && p.status === 'pending_review' && (
                  <Badge color="blue">changed</Badge>
                )}
                {p.absent && <Badge>absent</Badge>}
                <FlagBadges pin={p} />
                <span className="ml-auto">
                  <Button onClick={() => onReview(p)}>Review</Button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return active ? (
    <Button onClick={onClick}>{children}</Button>
  ) : (
    <Button outline onClick={onClick}>
      {children}
    </Button>
  );
}

export function ToolReview() {
  usePageTitle('Admin - Tool Review');
  const [tab, setTab] = useState<'pending' | 'baseline'>('pending');
  const [sel, setSel] = useState<ToolPinSummary | null>(null);
  const summary = useToolPinSummary();
  const pending = useToolPins({ status: 'pending_review' });
  const baseline = useToolPins({ baseline: 'unreviewed' });
  const list = tab === 'pending' ? pending : baseline;

  return (
    <div className="space-y-6">
      <div>
        <Heading>Tool Review</Heading>
        <Text>
          Approve or reject changes to tool definitions before agents can see them. Definitions are
          shown as plain text; invisible characters appear as ⟨U+…⟩.
        </Text>
      </div>
      {(summary.data?.held_mcps.length ?? 0) > 0 && (
        <Text className="text-amber-600">
          {summary.data!.held_mcps.length} MCP scope(s) are held: new definitions are queued and the
          last approved definitions keep being served.
        </Text>
      )}
      <div className="flex gap-2">
        <TabButton active={tab === 'pending'} onClick={() => setTab('pending')}>
          Pending{summary.data ? ` (${summary.data.pending_count})` : ''}
        </TabButton>
        <TabButton active={tab === 'baseline'} onClick={() => setTab('baseline')}>
          Baseline, never human-reviewed
          {summary.data ? ` (${summary.data.baseline_unreviewed_count})` : ''}
        </TabButton>
      </div>
      {list.isLoading ? (
        <Text>Loading…</Text>
      ) : list.isError ? (
        <Text className="text-red-600">Could not load tool pins.</Text>
      ) : (
        <PinGroups
          pins={list.pins}
          onReview={setSel}
          empty={
            tab === 'pending' ? 'No tool definitions awaiting review' : 'No unreviewed baseline'
          }
        />
      )}
      <ReviewDialog key={sel?.pin_id ?? 'none'} pin={sel} mode={tab} onClose={() => setSel(null)} />
    </div>
  );
}
