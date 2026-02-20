import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Copy, Eye, Pause, Play, Trash2, Check } from 'lucide-react';
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
      console.error('Failed to create client:', error);
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
      console.error('Failed to update client:', error);
    }
  };

  const handleDelete = async () => {
    if (clientToDelete) {
      try {
        await deleteClient.mutateAsync(clientToDelete);
        setDeleteDialogOpen(false);
        setClientToDelete(null);
      } catch (error) {
        console.error('Failed to delete client:', error);
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
          <Plus data-slot="icon" />
          Create Client
        </Button>
      </div>

      {/* Table Section */}
      <div className="rounded-lg bg-white ring-1 ring-zinc-950/5">
        {isLoading ? (
          <div className="p-6 space-y-4">
            <div className="animate-pulse h-10 w-full rounded bg-zinc-200" />
            <div className="animate-pulse h-10 w-full rounded bg-zinc-200" />
            <div className="animate-pulse h-10 w-full rounded bg-zinc-200" />
          </div>
        ) : !clients || clients.length === 0 ? (
          <div className="p-12 text-center text-zinc-500">
            No clients yet. Create your first client to get started.
          </div>
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableHeader>Name</TableHeader>
                <TableHeader>Key Prefix</TableHeader>
                <TableHeader>Status</TableHeader>
                <TableHeader>Created</TableHeader>
                <TableHeader>Expires</TableHeader>
                <TableHeader>Actions</TableHeader>
              </TableRow>
            </TableHead>
            <TableBody>
              {clients.map((client) => (
                <TableRow key={client.id}>
                  <TableCell>
                    <Link
                      to={`/app/clients/${client.id}`}
                      className="font-medium text-zinc-900 hover:underline"
                    >
                      {client.clientName}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <code className="text-sm text-zinc-500">
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
                  <TableCell className="text-zinc-500">
                    {new Date(client.createdAt).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="text-zinc-500">
                    {client.expiresAt
                      ? new Date(client.expiresAt).toLocaleDateString()
                      : '—'}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Button plain href={`/app/clients/${client.id}`}>
                        <Eye data-slot="icon" />
                      </Button>
                      {client.status !== 'revoked' && (
                        <Button
                          plain
                          onClick={() => handleToggleStatus(client)}
                          disabled={updateClient.isPending}
                        >
                          {client.status === 'active' ? (
                            <Pause data-slot="icon" />
                          ) : (
                            <Play data-slot="icon" />
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
                      >
                        <Trash2 data-slot="icon" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
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
                className="font-mono text-xs bg-zinc-100"
              />
              <Button plain onClick={handleCopyKey}>
                {keyCopied ? (
                  <Check data-slot="icon" className="text-green-600" />
                ) : (
                  <Copy data-slot="icon" />
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
