import { useState } from 'react';
import { toast } from 'sonner';
import {
  GROUP_TOOL_POLICY_MAX_TOOLS,
  type GroupToolMode,
  type KnownMcpTool,
} from '@mcpambassador/contracts';
import {
  Dialog,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogActions,
} from '@/components/catalyst/dialog';
import { Button } from '@/components/catalyst/button';
import { Badge } from '@/components/catalyst/badge';
import { Text } from '@/components/catalyst/text';
import { Checkbox, CheckboxField } from '@/components/catalyst/checkbox';
import { Label } from '@/components/catalyst/fieldset';
import { usePutGroupToolPolicy, useKnownMcpTools } from '@/api/hooks/use-admin';
import { visibleText } from '@/lib/pin-text';

const MODES: { key: GroupToolMode; label: string; help: string }[] = [
  { key: 'all', label: 'All tools', help: 'Members get every tool of this MCP.' },
  { key: 'allow', label: 'Only these', help: 'Members get only the ticked tools.' },
  { key: 'deny', label: 'All except', help: 'Members get every tool except the ticked ones.' },
];

/**
 * ADR-025 per-grant tool policy editor. Names are exact; the server compares them byte for byte,
 * so they are shown through `visibleText` (invisible characters become ⟨U+XXXX⟩) and never parsed.
 * Orphans (rule names that match no current tool) stay listed so an admin can untick them.
 */
export function GroupToolPolicyDialog({
  groupId,
  mcpId,
  mcpName,
  initialMode,
  initialTools,
  onClose,
}: {
  groupId: string;
  mcpId: string;
  mcpName: string;
  initialMode: GroupToolMode;
  initialTools: string[];
  onClose: () => void;
}) {
  const known = useKnownMcpTools(mcpId);
  const put = usePutGroupToolPolicy();
  const [mode, setMode] = useState<GroupToolMode>(initialMode);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(initialTools));
  const [cleared, setCleared] = useState(false);

  // allow{a} and deny{a} mean opposite things, so ticks never carry across a mode switch.
  const changeMode = (next: GroupToolMode) => {
    if (next === mode) return;
    setCleared(picked.size > 0);
    setPicked(new Set());
    setMode(next);
  };

  // This grant's own rule names that the server does not list (e.g. a stale picker) stay visible.
  const listed: KnownMcpTool[] = known.data?.tools ?? [];
  const listedNames = new Set(listed.map(t => t.name));
  const extra: KnownMcpTool[] = initialTools
    .filter(n => !listedNames.has(n))
    .map(name => ({ name, orphan: true }));
  const rows = [...listed, ...extra];

  const toggle = (name: string, on: boolean) =>
    setPicked(prev => {
      const next = new Set(prev);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });

  const count = picked.size;
  const tooMany = count > GROUP_TOOL_POLICY_MAX_TOOLS;
  const emptyAllow = mode === 'allow' && count === 0;
  const invalid = tooMany || emptyAllow;

  const save = async () => {
    try {
      await put.mutateAsync({
        groupId,
        mcpId,
        policy: { tool_mode: mode, tools: mode === 'all' ? [] : [...picked] },
      });
      toast.success('Tool policy saved');
      onClose();
    } catch (e) {
      toast.error('Could not save the tool policy', {
        description: (e as Error)?.message ?? String(e),
      });
    }
  };

  return (
    <Dialog open onClose={onClose} size="2xl">
      <DialogTitle>Tool policy: {visibleText(mcpName)}</DialogTitle>
      <DialogDescription>
        Which tools of this MCP members of this group get. A user&apos;s tools are the union over
        all the groups that grant the MCP.
      </DialogDescription>
      <DialogBody className="space-y-4">
        <div role="radiogroup" aria-label="Tool mode" className="flex flex-wrap gap-2">
          {MODES.map(m =>
            mode === m.key ? (
              <Button
                key={m.key}
                role="radio"
                aria-checked="true"
                data-testid={`mode-${m.key}`}
                onClick={() => changeMode(m.key)}
              >
                {m.label}
              </Button>
            ) : (
              <Button
                key={m.key}
                outline
                role="radio"
                aria-checked="false"
                data-testid={`mode-${m.key}`}
                onClick={() => changeMode(m.key)}
              >
                {m.label}
              </Button>
            )
          )}
        </div>
        <Text>{MODES.find(m => m.key === mode)!.help}</Text>
        {cleared && (
          <Text data-testid="selection-cleared" className="text-amber-600">
            Selection cleared: allow and deny lists mean opposite things.
          </Text>
        )}

        {mode !== 'all' && (
          <div className="space-y-2" data-testid="tool-picker">
            {known.isLoading && <Text>Loading tools…</Text>}
            {known.error && (
              <Text className="text-red-600" data-testid="tools-load-error">
                The tool list could not be loaded.
              </Text>
            )}
            {!known.isLoading && rows.length === 0 && !known.error && (
              <Text data-testid="no-known-tools">
                No tools are known for this MCP yet. Tools appear after the first discovery.
              </Text>
            )}
            <div className="max-h-72 space-y-1 overflow-auto rounded-lg p-2 ring-1 ring-zinc-950/10 dark:ring-white/10">
              {rows.map(t => (
                <CheckboxField key={t.name}>
                  <Checkbox
                    name={`tool-${t.name}`}
                    checked={picked.has(t.name)}
                    onChange={on => toggle(t.name, on)}
                    data-testid={`tool-check-${t.name}`}
                  />
                  <Label className="cursor-pointer font-mono text-sm">
                    {visibleText(t.name)}
                    {t.orphan && (
                      <Badge color="amber" className="ml-2" data-testid={`orphan-${t.name}`}>
                        not found
                      </Badge>
                    )}
                  </Label>
                </CheckboxField>
              ))}
            </div>
            <Text data-testid="tool-count">
              {count} selected{tooMany ? ` (max ${GROUP_TOOL_POLICY_MAX_TOOLS})` : ''}
            </Text>
            {emptyAllow && (
              <Text className="text-amber-600" data-testid="empty-allow">
                Pick at least one tool, or choose &quot;All tools&quot;. An empty allow list would
                hide the whole MCP.
              </Text>
            )}
            {mode === 'deny' && count === 0 && <Text>Nothing ticked: members get every tool.</Text>}
          </div>
        )}
      </DialogBody>
      <DialogActions>
        <Button plain onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={save} disabled={invalid || put.isPending} data-testid="save-policy">
          {put.isPending ? 'Saving…' : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
