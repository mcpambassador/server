import { useState } from 'react';
import { toast } from 'sonner';
import {
  ClipboardDocumentIcon,
  PlusIcon,
  ShieldCheckIcon,
  TrashIcon,
} from '@heroicons/react/20/solid';
import { Heading } from '@/components/catalyst/heading';
import { Text } from '@/components/catalyst/text';
import { Button } from '@/components/catalyst/button';
import { Badge } from '@/components/catalyst/badge';
import { Input } from '@/components/catalyst/input';
import { Select } from '@/components/catalyst/select';
import { Textarea } from '@/components/catalyst/textarea';
import { Checkbox, CheckboxField, CheckboxGroup } from '@/components/catalyst/checkbox';
import { Field, Label, Description, FieldGroup } from '@/components/catalyst/fieldset';
import {
  Dialog,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogActions,
} from '@/components/catalyst/dialog';
import {
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableHeader,
  TableCell,
} from '@/components/catalyst/table';
import { EmptyState } from '@/components/shared/EmptyState';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { useAgentGrants, useRevokeGrant, useCreateGrant } from '@/api/hooks/use-agent';
import { Link } from 'react-router-dom';
import { useAgentEndpointInfo } from '@/api/hooks/use-agent';
import { useClients, useClientSubscriptions } from '@/api/hooks/use-clients';
import {
  grantStatus,
  parseToolAllowlist,
  ttlOptions,
  formatDuration,
  type AgentGrantSummary,
  type CreateGrantResponse,
} from '@/api/agent-types';
import { usePageTitle } from '@/hooks/usePageTitle';

// Fallbacks (server defaults) while /v1/users/me/agent-endpoint is loading or unavailable.
const FALLBACK_DEFAULT_TTL = 3600;
const FALLBACK_MAX_TTL = 24 * 3600;

const statusColor = { active: 'green', expired: 'zinc', revoked: 'red' } as const;

function fmt(ts: string | null): string {
  return ts ? new Date(ts).toLocaleString() : 'Never';
}

function CreateGrantDialog({
  open,
  onClose,
  defaultTtl,
  maxTtl,
}: {
  open: boolean;
  onClose: () => void;
  defaultTtl: number;
  maxTtl: number;
}) {
  const { data: allClients, isLoading: clientsLoading } = useClients();
  const clients = (allClients ?? []).filter(c => c.status === 'active');
  const [clientId, setClientId] = useState<string | null>(null);
  const boundClient = clients.find(c => c.id === clientId) ?? clients[0];
  const { data: subs } = useClientSubscriptions(boundClient?.id ?? '');
  const create = useCreateGrant();
  const [label, setLabel] = useState('');
  const [scopes, setScopes] = useState<Set<string>>(new Set());
  const [toolsText, setToolsText] = useState('');
  const [ttlChoice, setTtlChoice] = useState<number | null>(null);
  const ttl = Math.min(ttlChoice ?? defaultTtl, maxTtl);
  const [result, setResult] = useState<CreateGrantResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mcpNames = Array.from(
    new Set((subs ?? []).filter(s => s.status === 'active').map(s => s.mcpName))
  ).sort();
  const options = ttlOptions(defaultTtl, maxTtl);

  const reset = () => {
    setLabel('');
    setClientId(null);
    setScopes(new Set());
    setToolsText('');
    setTtlChoice(null);
    setResult(null);
    setError(null);
  };
  const close = () => {
    reset();
    onClose();
  };

  const toggle = (scope: string, on: boolean) => {
    const next = new Set(scopes);
    if (on) next.add(scope);
    else next.delete(scope);
    setScopes(next);
  };

  const submit = async () => {
    setError(null);
    try {
      const res = await create.mutateAsync({
        bound_client_id: boundClient!.id,
        label: label.trim(),
        scopes: Array.from(scopes),
        tool_allowlist: parseToolAllowlist(toolsText),
        ttl_seconds: ttl,
      });
      setResult(res);
    } catch (err) {
      setError((err as Error)?.message ?? 'Failed to create grant');
    }
  };

  const copy = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.access_token);
      toast.success('Token copied');
    } catch {
      toast.error('Copy failed — select the token and copy it manually');
    }
  };

  return (
    <Dialog open={open} onClose={() => !result && close()}>
      <DialogBody>
        {result ? (
          <>
            <DialogTitle>Copy your token now</DialogTitle>
            <DialogDescription>
              This token is shown only once and cannot be retrieved later. It expires{' '}
              {new Date(result.expires_at).toLocaleString()} and has no refresh token.
            </DialogDescription>
            <div className="mt-4 space-y-3">
              <div className="flex items-start gap-2">
                <code
                  data-testid="grant-token"
                  className="block flex-1 break-all rounded bg-zinc-100 p-3 text-xs dark:bg-zinc-800"
                >
                  {result.access_token}
                </code>
                <Button plain onClick={copy} aria-label="Copy token">
                  <ClipboardDocumentIcon className="size-4" />
                </Button>
              </div>
              <Text className="text-sm">
                Use it as <code>Authorization: Bearer &lt;token&gt;</code> against{' '}
                <code>{result.resource}</code>.
              </Text>
            </div>
            <DialogActions>
              <Button color="zinc" onClick={close}>
                I have copied it
              </Button>
            </DialogActions>
          </>
        ) : (
          <>
            <DialogTitle>Create one-shot grant</DialogTitle>
            <DialogDescription>
              For CI and headless agents that cannot complete a browser sign-in. The token works
              until the lifetime you choose below (default {formatDuration(defaultTtl)}, maximum{' '}
              {formatDuration(maxTtl)}) and is not renewable: no refresh token is issued, so create
              a new grant when it expires.
            </DialogDescription>
            {!clientsLoading && clients.length === 0 ? (
              <div role="alert" className="mt-4 space-y-2">
                <Text>
                  You have no active Ambassador clients. A grant binds to one of your clients, so
                  create one first.
                </Text>
                <Link
                  to="/app/clients"
                  className="text-sm font-medium text-blue-600 underline dark:text-blue-400"
                >
                  Create a client
                </Link>
              </div>
            ) : (
              <FieldGroup className="mt-4">
                <Field>
                  <Label>Ambassador client</Label>
                  <Description>
                    The grant can only use what this client is subscribed to.
                  </Description>
                  <Select
                    name="bound_client_id"
                    value={boundClient?.id ?? ''}
                    onChange={e => {
                      setClientId(e.target.value);
                      setScopes(new Set());
                    }}
                  >
                    {clients.map(c => (
                      <option key={c.id} value={c.id}>
                        {c.clientName}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field>
                  <Label>Label</Label>
                  <Input
                    name="label"
                    maxLength={128}
                    value={label}
                    onChange={e => setLabel(e.target.value)}
                  />
                </Field>
                <Field>
                  <Label>Allowed MCPs</Label>
                  <CheckboxGroup className="mt-2">
                    <CheckboxField>
                      <Checkbox
                        name="scope"
                        value="mcp:*"
                        checked={scopes.has('mcp:*')}
                        onChange={on => toggle('mcp:*', on)}
                      />
                      <Label>All current subscriptions (mcp:*)</Label>
                    </CheckboxField>
                    {mcpNames.map(name => (
                      <CheckboxField key={name}>
                        <Checkbox
                          name="scope"
                          value={`mcp:${name}`}
                          checked={scopes.has(`mcp:${name}`)}
                          onChange={on => toggle(`mcp:${name}`, on)}
                        />
                        <Label>{name}</Label>
                      </CheckboxField>
                    ))}
                  </CheckboxGroup>
                </Field>
                <Field>
                  <Label>Tool allowlist (optional)</Label>
                  <Description>One fully qualified tool name per line.</Description>
                  <Textarea
                    rows={3}
                    value={toolsText}
                    onChange={e => setToolsText(e.target.value)}
                  />
                </Field>
                <Field>
                  <Label>Expires after</Label>
                  <Select
                    name="ttl"
                    value={ttl}
                    onChange={e => setTtlChoice(Number(e.target.value))}
                  >
                    {options.map(o => (
                      <option key={o.seconds} value={o.seconds}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                </Field>
              </FieldGroup>
            )}
            {error && (
              <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">
                {error}
              </p>
            )}
            <DialogActions>
              <Button color="zinc" onClick={close} disabled={create.isPending}>
                Cancel
              </Button>
              <Button
                onClick={submit}
                disabled={create.isPending || !boundClient || !label.trim() || scopes.size === 0}
              >
                {create.isPending ? 'Creating...' : 'Create grant'}
              </Button>
            </DialogActions>
          </>
        )}
      </DialogBody>
    </Dialog>
  );
}

export function AgentAccess() {
  usePageTitle('Agent access');
  const { grants, isLoading, error, hasMore, loadMore, loadingMore } = useAgentGrants();
  const { data: info, isLoading: infoLoading } = useAgentEndpointInfo();
  const revoke = useRevokeGrant();
  const [pending, setPending] = useState<AgentGrantSummary | null>(null);
  const [revokeAllOpen, setRevokeAllOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  const active = (grants ?? []).filter(g => grantStatus(g) === 'active');

  const revokeOne = async () => {
    if (!pending) return;
    try {
      await revoke.mutateAsync(pending.grant_id);
      toast.success(`Revoked "${pending.label}"`);
      setPending(null);
    } catch (err) {
      toast.error('Failed to revoke grant', { description: (err as Error)?.message });
    }
  };

  const revokeAll = async () => {
    const results = await Promise.allSettled(active.map(g => revoke.mutateAsync(g.grant_id)));
    const failed = results.filter(r => r.status === 'rejected').length;
    setRevokeAllOpen(false);
    if (failed > 0) toast.error(`${failed} grant(s) could not be revoked`);
    else toast.success('All agent access revoked');
  };

  if (!infoLoading && info && !info.enabled) {
    return (
      <div className="space-y-2">
        <Heading>Agent access</Heading>
        <Text role="status">
          Remote agent access is not enabled on this server. Ask an administrator to enable the
          agent endpoint.
        </Text>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Heading>Agent access</Heading>
          <Text className="mt-2 text-zinc-500 dark:text-zinc-400">
            Remote agents you have authorized to use your MCP tools. Revoking a grant takes effect
            immediately.
          </Text>
        </div>
        <div className="flex gap-3">
          <Button
            color="zinc"
            onClick={() => setRevokeAllOpen(true)}
            disabled={active.length === 0}
          >
            Revoke all
          </Button>
          <Button onClick={() => setCreateOpen(true)}>
            <PlusIcon />
            Create one-shot grant
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="animate-pulse h-48 w-full rounded-lg bg-zinc-200 dark:bg-zinc-700" />
      ) : error ? (
        <Text role="alert">Could not load agent grants: {(error as Error).message}</Text>
      ) : !grants || grants.length === 0 ? (
        <EmptyState
          icon={<ShieldCheckIcon className="size-6 text-zinc-400" />}
          title="No agent access"
          description="When you authorize a remote agent, or create a one-shot grant for CI, it appears here."
        />
      ) : (
        <Table>
          <TableHead>
            <TableRow>
              <TableHeader>Label</TableHeader>
              <TableHeader>Agent</TableHeader>
              <TableHeader>Client</TableHeader>
              <TableHeader>Scopes</TableHeader>
              <TableHeader>Expires</TableHeader>
              <TableHeader>Last used</TableHeader>
              <TableHeader>Status</TableHeader>
              <TableHeader>
                <span className="sr-only">Actions</span>
              </TableHeader>
            </TableRow>
          </TableHead>
          <TableBody>
            {grants.map(g => {
              const status = grantStatus(g);
              return (
                <TableRow key={g.grant_id}>
                  <TableCell className="font-medium">{g.label}</TableCell>
                  <TableCell>
                    {g.client_name ?? <span className="text-zinc-500">One-shot</span>}
                  </TableCell>
                  <TableCell>
                    {g.bound_client_name ?? <span className="text-zinc-500">Removed</span>}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {g.scopes.map(s => (
                        <Badge key={s}>{s}</Badge>
                      ))}
                    </div>
                    {g.tool_allowlist && (
                      <Text className="mt-1 text-xs">
                        {g.tool_allowlist.length} tool(s) allowed
                      </Text>
                    )}
                  </TableCell>
                  <TableCell>{fmt(g.expires_at)}</TableCell>
                  <TableCell>{fmt(g.last_used_at)}</TableCell>
                  <TableCell>
                    <Badge color={statusColor[status]}>{status}</Badge>
                  </TableCell>
                  <TableCell>
                    {status === 'active' && (
                      <Button
                        plain
                        aria-label={`Revoke ${g.label}`}
                        title="Revoke"
                        onClick={() => setPending(g)}
                        disabled={revoke.isPending}
                      >
                        <TrashIcon className="size-4 text-zinc-400 hover:text-red-500" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      {hasMore && (
        <div className="mt-4">
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
        title="Revoke agent access?"
        description={
          pending
            ? `"${pending.label}" and all of its tokens will stop working immediately.`
            : undefined
        }
        confirmLabel="Revoke"
        onConfirm={revokeOne}
        isLoading={revoke.isPending}
      />
      <ConfirmDialog
        open={revokeAllOpen}
        onClose={open => {
          if (!open) setRevokeAllOpen(false);
        }}
        title="Revoke all agent access?"
        description={`${active.length} active grant(s) and their tokens will stop working immediately.`}
        confirmLabel="Revoke all"
        onConfirm={revokeAll}
        isLoading={revoke.isPending}
      />
      <CreateGrantDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        defaultTtl={info?.default_grant_ttl_seconds ?? FALLBACK_DEFAULT_TTL}
        maxTtl={info?.max_grant_ttl_seconds ?? FALLBACK_MAX_TTL}
      />
    </div>
  );
}
