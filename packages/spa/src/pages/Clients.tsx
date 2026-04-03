import { useState, Fragment } from 'react';
import { toast } from 'sonner';
import { Link } from 'react-router-dom';
import {
  PlusIcon,
  ClipboardDocumentIcon,
  EyeIcon,
  PauseIcon,
  PlayIcon,
  TrashIcon,
  CheckIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/20/solid';
import { Button } from '@/components/catalyst/button';
import { Badge } from '@/components/catalyst/badge';
import { Heading } from '@/components/catalyst/heading';
import {
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableHeader,
  TableCell,
} from '@/components/catalyst/table';
import {
  Dialog,
  DialogBody,
  DialogDescription,
  DialogActions,
  DialogTitle,
} from '@/components/catalyst/dialog';
import { Input } from '@/components/catalyst/input';
import { Field, Label } from '@/components/catalyst/fieldset';
import {
  InlineAlert,
  InlineAlertDescription,
} from '@/components/catalyst/inline-alert';
import {
  Alert,
  AlertDescription,
  AlertActions,
  AlertTitle,
} from '@/components/catalyst/alert';
import {
  useClients,
  useCreateClient,
  useUpdateClient,
  useDeleteClient,
} from '@/api/hooks/use-clients';
import type { Client } from '@/api/types';
import { usePageTitle } from '@/hooks/usePageTitle';

// ---------------------------------------------------------------------------
// Connection health helpers
// ---------------------------------------------------------------------------

type ConnectionStatus = 'active' | 'idle' | 'expired';

/**
 * Derive a user-facing connection health status from client fields.
 *
 * Rules:
 *  - If the client is revoked or suspended, treat as expired (no active session).
 *  - If expiresAt is in the past, the key has expired — session cannot be created.
 *  - If lastUsedAt is within the last 5 minutes, the session is Active.
 *  - If lastUsedAt is within the last 30 minutes, it is Idle.
 *  - If lastUsedAt is older than 30 minutes (or never set), it is Expired/Disconnected.
 */
function deriveConnectionStatus(client: Client): ConnectionStatus {
  if (client.status === 'revoked' || client.status === 'suspended') {
    return 'expired';
  }

  if (client.expiresAt && new Date(client.expiresAt) < new Date()) {
    return 'expired';
  }

  if (!client.lastUsedAt) {
    return 'expired';
  }

  const lastUsed = new Date(client.lastUsedAt);
  const nowMs = Date.now();
  const diffMs = nowMs - lastUsed.getTime();
  const fiveMinutes = 5 * 60 * 1000;
  const thirtyMinutes = 30 * 60 * 1000;

  if (diffMs <= fiveMinutes) return 'active';
  if (diffMs <= thirtyMinutes) return 'idle';
  return 'expired';
}

/**
 * Format a timestamp as a human-relative string, e.g. "3 minutes ago".
 */
function formatRelativeTime(isoString: string | undefined): string {
  if (!isoString) return 'Never';

  const date = new Date(isoString);
  const diffMs = Date.now() - date.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSeconds < 60) return 'Just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString();
}

const CONNECTION_STATUS_CONFIG: Record<
  ConnectionStatus,
  { label: string; color: 'green' | 'yellow' | 'red' }
> = {
  active: { label: 'Active', color: 'green' },
  idle: { label: 'Idle', color: 'yellow' },
  expired: { label: 'Disconnected', color: 'red' },
};

export function Clients() {
  usePageTitle('My Clients');
  const { data: clients, isLoading } = useClients();
  const createClient = useCreateClient();
  const updateClient = useUpdateClient();
  const deleteClient = useDeleteClient();

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [keyDialogOpen, setKeyDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [clientToDelete, setClientToDelete] = useState<string | null>(null);
  const [plaintextKey, setPlaintextKey] = useState<string | null>(null);
  const [keyCopied, setKeyCopied] = useState(false);

  const [formData, setFormData] = useState({
    client_name: '',
    expires_at: '',
  });

  const handleCreate = async () => {
    try {
      const result = await createClient.mutateAsync({
        client_name: formData.client_name,
        expires_at: formData.expires_at || undefined,
      });
      setPlaintextKey(result.plaintext_key);
      setCreateDialogOpen(false);
      setKeyDialogOpen(true);
      setFormData({ client_name: '', expires_at: '' });
    } catch (error) {
      toast.error('Failed to create client', { description: (error as Error)?.message ?? String(error) });
    }
  };

  const handleCopyKey = () => {
    if (plaintextKey) {
      navigator.clipboard.writeText(plaintextKey);
      setKeyCopied(true);
      setTimeout(() => setKeyCopied(false), 2000);
    }
  };

  const handleToggleStatus = async (client: Client) => {
    const newStatus = client.status === 'active' ? 'suspended' : 'active';
    try {
      await updateClient.mutateAsync({
        clientId: client.id,
        data: { status: newStatus },
      });
    } catch (error) {
      toast.error('Failed to update client', { description: (error as Error)?.message ?? String(error) });
    }
  };

  const handleDelete = async () => {
    if (clientToDelete) {
      try {
        await deleteClient.mutateAsync(clientToDelete);
        setDeleteDialogOpen(false);
        setClientToDelete(null);
      } catch (error) {
        toast.error('Failed to delete client', { description: (error as Error)?.message ?? String(error) });
      }
    }
  };

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex items-center justify-between">
        <div>
          <Heading>My Clients</Heading>
          <p className="mt-1 text-sm text-zinc-500">
            Manage your MCP API clients and credentials
          </p>
        </div>
        <Button onClick={() => setCreateDialogOpen(true)}>
          <PlusIcon data-slot="icon" />
          Create Client
        </Button>
      </div>

      {/* Table Section */}
      <div className="rounded-lg bg-white dark:bg-white/5 ring-1 ring-zinc-950/10 dark:ring-white/10">
        {isLoading ? (
          <div className="p-6 space-y-4">
            <div className="animate-pulse h-10 w-full rounded bg-zinc-200 dark:bg-zinc-700" />
            <div className="animate-pulse h-10 w-full rounded bg-zinc-200 dark:bg-zinc-700" />
            <div className="animate-pulse h-10 w-full rounded bg-zinc-200 dark:bg-zinc-700" />
          </div>
        ) : !clients || clients.length === 0 ? (
          <div className="p-12 text-center text-zinc-500 dark:text-zinc-400">
            No clients yet. Create your first client to get started.
          </div>
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableHeader>Name</TableHeader>
                <TableHeader>Key Prefix</TableHeader>
                <TableHeader>Account Status</TableHeader>
                <TableHeader>Connection</TableHeader>
                <TableHeader>Last Seen</TableHeader>
                <TableHeader>Tools</TableHeader>
                <TableHeader>Expires</TableHeader>
                <TableHeader>Actions</TableHeader>
              </TableRow>
            </TableHead>
            <TableBody>
              {clients.map((client) => {
                const connStatus = deriveConnectionStatus(client);
                const connConfig = CONNECTION_STATUS_CONFIG[connStatus];
                const isSessionExpired = connStatus === 'expired' && client.status === 'active';

                return (
                  <Fragment key={client.id}>
                    <TableRow>
                      <TableCell>
                        <Link
                          to={`/app/clients/${client.id}`}
                          className="font-medium text-zinc-900 dark:text-white hover:underline"
                        >
                          {client.clientName}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <code className="text-sm text-zinc-500 dark:text-zinc-400">
                          {client.keyPrefix}
                        </code>
                      </TableCell>
                      <TableCell>
                        <Badge
                          color={
                            client.status === 'active'
                              ? 'green'
                              : client.status === 'suspended'
                                ? 'amber'
                                : 'red'
                          }
                        >
                          {client.status}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge color={connConfig.color}>
                          {connConfig.label}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-zinc-500 tabular-nums">
                        {formatRelativeTime(client.lastUsedAt)}
                      </TableCell>
                      <TableCell className="text-zinc-500 tabular-nums">
                        {client.subscriptionCount ?? 0}
                      </TableCell>
                      <TableCell className="text-zinc-500">
                        {client.expiresAt
                          ? new Date(client.expiresAt).toLocaleDateString()
                          : '—'}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Button plain href={`/app/clients/${client.id}`} title="View client details">
                            <EyeIcon data-slot="icon" />
                          </Button>
                          {client.status !== 'revoked' && (
                            <Button
                              plain
                              onClick={() => handleToggleStatus(client)}
                              disabled={updateClient.isPending}
                              title={client.status === 'active' ? 'Suspend client' : 'Reactivate client'}
                            >
                              {client.status === 'active' ? (
                                <PauseIcon data-slot="icon" />
                              ) : (
                                <PlayIcon data-slot="icon" />
                              )}
                            </Button>
                          )}
                          <Button
                            plain
                            onClick={() => {
                              setClientToDelete(client.id);
                              setDeleteDialogOpen(true);
                            }}
                            disabled={deleteClient.isPending}
                            title="Delete this client"
                          >
                            <TrashIcon data-slot="icon" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                    {isSessionExpired && (
                      <TableRow key={`${client.id}-reconnect`}>
                        <TableCell colSpan={8} className="py-2 px-4">
                          <div className="flex items-center gap-2 rounded-md bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-sm text-amber-800 dark:text-amber-300 ring-1 ring-amber-200 dark:ring-amber-800">
                            <ExclamationTriangleIcon className="size-4 shrink-0 text-amber-500 dark:text-amber-400" />
                            <span>
                              Session expired — restart your AI tool to reconnect.
                            </span>
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>

      {/* Create Client Dialog */}
      <Dialog open={createDialogOpen} onClose={setCreateDialogOpen}>
        <DialogBody>
          <DialogTitle>Create New Client</DialogTitle>
          <DialogDescription>
            Generate a new API client and key for accessing MCP services
          </DialogDescription>
          <div className="space-y-4">
            <Field>
              <Label>Client Name</Label>
              <Input
                placeholder="My Application"
                value={formData.client_name}
                onChange={(e) =>
                  setFormData({ ...formData, client_name: e.target.value })
                }
              />
            </Field>
            <Field>
              <Label>Expires At (optional)</Label>
              <Input
                type="datetime-local"
                value={formData.expires_at}
                onChange={(e) =>
                  setFormData({ ...formData, expires_at: e.target.value })
                }
              />
            </Field>
          </div>
          <DialogActions>
            <Button
              color="zinc"
              onClick={() => setCreateDialogOpen(false)}
              disabled={createClient.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={handleCreate}
              disabled={!formData.client_name || createClient.isPending}
            >
              {createClient.isPending ? 'Creating...' : 'Create'}
            </Button>
          </DialogActions>
        </DialogBody>
      </Dialog>

      {/* API Key Dialog */}
      <Dialog open={keyDialogOpen} onClose={setKeyDialogOpen}>
        <DialogBody>
          <DialogTitle>API Key Created</DialogTitle>
          <DialogDescription>
            Save this key securely. It will only be shown once.
          </DialogDescription>
          <InlineAlert color="warning">
            <InlineAlertDescription>
              This is the only time you&apos;ll see the full API key. Copy it
              now and store it securely.
            </InlineAlertDescription>
          </InlineAlert>
          <Field>
            <Label>API Key</Label>
            <div className="flex gap-2">
              <Input
                value={plaintextKey ?? ''}
                readOnly
                className="font-mono text-xs bg-zinc-100 dark:bg-zinc-800"
              />
              <Button plain onClick={handleCopyKey}>
                {keyCopied ? (
                  <CheckIcon data-slot="icon" className="text-green-600 dark:text-green-400" />
                ) : (
                  <ClipboardDocumentIcon data-slot="icon" />
                )}
              </Button>
            </div>
          </Field>
          <DialogActions>
            <Button
              onClick={() => {
                setKeyDialogOpen(false);
                setPlaintextKey(null);
              }}
            >
              I&apos;ve Saved the Key
            </Button>
          </DialogActions>
        </DialogBody>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Alert open={deleteDialogOpen} onClose={setDeleteDialogOpen}>
        <AlertTitle>Are you sure?</AlertTitle>
        <AlertDescription>
          This will permanently revoke the client and all associated
          subscriptions. This action cannot be undone.
        </AlertDescription>
        <AlertActions>
          <Button
            plain
            onClick={() => {
              setDeleteDialogOpen(false);
              setClientToDelete(null);
            }}
          >
            Cancel
          </Button>
          <Button color="red" onClick={handleDelete}>
            Delete
          </Button>
        </AlertActions>
      </Alert>
    </div>
  );
}
