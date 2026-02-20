import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Copy, Eye, Pause, Play, Trash2, Check } from 'lucide-react';
import { Card } from '@/components/catalyst/card';
import { Button } from '@/components/catalyst/button';
import { Badge } from '@/components/catalyst/badge';
import { Dialog, DialogBody, DialogDescription, DialogActions, DialogTitle } from '@/components/catalyst/dialog';
import { Input } from '@/components/catalyst/input';
import { Field, Label } from '@/components/catalyst/fieldset';
import { InlineAlert, InlineAlertDescription } from '@/components/catalyst/inline-alert';
import {
  Alert,
  AlertDescription,
  AlertActions,
  AlertTitle,
} from '@/components/catalyst/alert';
import { DataTable, type ColumnDef } from '@/components/data/DataTable';
import { useClients, useCreateClient, useUpdateClient, useDeleteClient } from '@/api/hooks/use-clients';
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

  const columns: ColumnDef<Client>[] = [
    {
      header: 'Name',
      accessor: 'clientName',
      cell: (client) => (
        <Link
          to={`/app/clients/${client.id}`}
          className="font-medium hover:underline"
        >
          {client.clientName}
        </Link>
      ),
    },
    {
      header: 'Key Prefix',
      accessor: 'keyPrefix',
      cell: (client) => (
        <code className="text-sm text-muted-foreground">{client.keyPrefix}</code>
      ),
    },
    {
      header: 'Status',
      accessor: 'status',
      cell: (client) => {
        const variant =
          client.status === 'active' ? 'emerald' :
          client.status === 'suspended' ? 'amber' : 'red';
        return <Badge color={variant}>{client.status}</Badge>;
      },
    },
    {
      header: 'Created',
      accessor: 'createdAt',
      cell: (client) => new Date(client.createdAt).toLocaleDateString(),
    },
    {
      header: 'Expires',
      accessor: 'expiresAt',
      cell: (client) =>
        client.expiresAt ? new Date(client.expiresAt).toLocaleDateString() : '—',
    },
    {
      header: 'Actions',
      accessor: 'id',
      cell: (client) => (
        <div className="flex items-center gap-2">
          <Button
                        className="p-1"
            href={`/app/clients/${client.id}`}
          >
            <Eye className="h-4 w-4" />
          </Button>
          {client.status !== 'revoked' && (
            <Button
                            className="p-1"
              onClick={() => handleToggleStatus(client)}
              disabled={updateClient.isPending}
            >
              {client.status === 'active' ? (
                <Pause className="h-4 w-4" />
              ) : (
                <Play className="h-4 w-4" />
              )}
            </Button>
          )}
          <Button
                        className="p-1"
            onClick={() => {
              setClientToDelete(client.id);
              setDeleteDialogOpen(true);
            }}
            disabled={deleteClient.isPending}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between pb-4 border-b border-border mb-6">
        <div>
          <h1 className="text-xl font-semibold">My Clients</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Manage your MCP API clients and credentials
          </p>
        </div>
        <Button onClick={() => setCreateDialogOpen(true)} className="text-sm">
          <Plus className="mr-2 h-4 w-4" />
          Create Client
        </Button>
      </div>

      <Card className="p-6">
        <DataTable
          columns={columns}
          data={clients ?? []}
          isLoading={isLoading}
          emptyMessage="No clients yet. Create your first client to get started."
        />
      </Card>

      {/* Create Client Dialog */}
      <Dialog open={createDialogOpen} onClose={setCreateDialogOpen}>
        <DialogBody>
          
            <DialogTitle>Create New Client</DialogTitle>
            <DialogDescription>
              Generate a new API client and key for accessing MCP services
            </DialogDescription>
          
          <div className="space-y-4">
            <Field className="space-y-2">
              <Label>Client Name</Label>
              <Input
                placeholder="My Application"
                value={formData.client_name}
                onChange={(e) =>
                  setFormData({ ...formData, client_name: e.target.value })
                }
              />
            </Field>
            <Field className="space-y-2">
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
              This is the only time you&apos;ll see the full API key. Copy it now and
              store it securely.
            </InlineAlertDescription>
          </InlineAlert>
          <Field className="space-y-2">
            <Label>API Key</Label>
            <div className="flex gap-2">
              <Input
                value={plaintextKey ?? ''}
                readOnly
                className="font-mono text-xs bg-muted"
              />
              <Button
                plain className="p-1"
                onClick={handleCopyKey}
              >
                {keyCopied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
          </Field>
          <DialogActions>
            <Button onClick={() => {
              setKeyDialogOpen(false);
              setPlaintextKey(null);
            }}>
              I&apos;ve Saved the Key
            </Button>
          </DialogActions>
        </DialogBody>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Alert open={deleteDialogOpen} onClose={setDeleteDialogOpen}>
        
          
            <AlertTitle>Are you sure?</AlertTitle>
            <AlertDescription>
              This will permanently revoke the client and all associated subscriptions.
              This action cannot be undone.
            </AlertDescription>
          
          <AlertActions>
            <Button plain onClick={() => setClientToDelete(null)}>
              Cancel
            </Button>
            <Button color="red"
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </Button>
          </AlertActions>
        
      </Alert>
    </div>
  );
}
