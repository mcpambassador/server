import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Key, Trash2, Edit, CheckCircle2, XCircle } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { DataTable, type ColumnDef } from '@/components/data/DataTable';
import { useCredentialStatus, useSetCredentials, useDeleteCredentials } from '@/api/hooks/use-credentials';
import type { CredentialStatus } from '@/api/types';
import { usePageTitle } from '@/hooks/usePageTitle';

export function Credentials() {
  usePageTitle('Credentials');
  const { data: credentials, isLoading } = useCredentialStatus();
  const setCredentials = useSetCredentials();
  const deleteCredentials = useDeleteCredentials();

  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedMcp, setSelectedMcp] = useState<CredentialStatus | null>(null);
  const [credentialFields, setCredentialFields] = useState<Record<string, string>>({});

  const handleEdit = (mcp: CredentialStatus) => {
    setSelectedMcp(mcp);
    // Initialize fields from schema
    const schema = mcp.credentialSchema as Record<string, { type: string }> | undefined;
    if (schema) {
      const fields: Record<string, string> = {};
      Object.keys(schema).forEach(key => {
        fields[key] = '';
      });
      setCredentialFields(fields);
    }
    setEditDialogOpen(true);
  };

  const handleSave = async () => {
    if (!selectedMcp) return;

    try {
      await setCredentials.mutateAsync({
        mcpId: selectedMcp.mcpId,
        data: { credentials: credentialFields },
      });
      setEditDialogOpen(false);
      setSelectedMcp(null);
      setCredentialFields({});
    } catch (error) {
      console.error('Failed to set credentials:', error);
    }
  };

  const handleDelete = async () => {
    if (!selectedMcp) return;

    try {
      await deleteCredentials.mutateAsync(selectedMcp.mcpId);
      setDeleteDialogOpen(false);
      setSelectedMcp(null);
    } catch (error) {
      console.error('Failed to delete credentials:', error);
    }
  };

  const columns: ColumnDef<CredentialStatus & { id: string }>[] = [
    {
      header: 'MCP Name',
      accessor: 'mcpName',
      cell: (cred) => (
        <div className="flex items-center gap-2">
          <Key className="h-4 w-4 text-muted-foreground" />
          <Link
            to={`/app/marketplace/${cred.mcpId}`}
            className="font-medium hover:underline"
          >
            {cred.mcpName}
          </Link>
        </div>
      ),
    },
    {
      header: 'Status',
      accessor: 'hasCredentials',
      cell: (cred) => (
        <div className="flex items-center gap-2">
          {cred.hasCredentials ? (
            <>
              <CheckCircle2 className="h-4 w-4 text-green-600" />
              <Badge variant="success">Configured</Badge>
            </>
          ) : (
            <>
              <XCircle className="h-4 w-4 text-red-600" />
              <Badge variant="secondary">Not Set</Badge>
            </>
          )}
        </div>
      ),
    },
    {
      header: 'Last Updated',
      accessor: 'updatedAt',
      cell: (cred) =>
        cred.updatedAt ? new Date(cred.updatedAt).toLocaleString() : '—',
    },
    {
      header: 'Actions',
      accessor: 'mcpId',
      cell: (cred) => (
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => handleEdit(cred)}
          >
            <Edit className="h-4 w-4" />
          </Button>
          {cred.hasCredentials && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                setSelectedMcp(cred);
                setDeleteDialogOpen(true);
              }}
              disabled={deleteCredentials.isPending}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      ),
    },
  ];

  const credentialsRequiring = (credentials?.filter(c => c.requiresCredentials) ?? []).map(c => ({
    ...c,
    id: c.mcpId,
  }));

  return (
    <div className="space-y-6">
      <div className="pb-4 border-b border-border mb-6">
        <h1 className="text-xl font-semibold">Credentials</h1>
        <p className="text-sm text-muted-foreground">
          Manage credentials for MCPs that require authentication
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>MCP Credentials</CardTitle>
          <CardDescription>
            Some MCPs require credentials to access external services. Configure them here.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={columns}
            data={credentialsRequiring}
            isLoading={isLoading}
            emptyMessage="No MCPs require credentials"
          />
        </CardContent>
      </Card>

      {/* Edit Credentials Dialog */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {selectedMcp?.hasCredentials ? 'Update' : 'Set'} Credentials for {selectedMcp?.mcpName}
            </DialogTitle>
            <DialogDescription>
              Enter the required credentials. They will be stored securely and never displayed.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {selectedMcp && Object.keys(
              (selectedMcp.credentialSchema as Record<string, { type: string; description?: string }>) ?? {}
            ).map((key) => {
              const schema = selectedMcp.credentialSchema as Record<string, { type: string; description?: string }>;
              const field = schema?.[key];
              if (!field) return null;
              return (
                <div key={key} className="space-y-2">
                  <Label htmlFor={key}>{key}</Label>
                  {field.description && (
                    <p className="text-sm text-muted-foreground">{field.description}</p>
                  )}
                  <Input
                    id={key}
                    type={field.type === 'password' ? 'password' : 'text'}
                    value={credentialFields[key] ?? ''}
                    onChange={(e) =>
                      setCredentialFields({
                        ...credentialFields,
                        [key]: e.target.value,
                      })
                    }
                    placeholder={selectedMcp.hasCredentials ? '(unchanged)' : ''}
                  />
                </div>
              );
            })}
          </div>
          <DialogFooter>
            <Button variant="outline" className="h-8" onClick={() => setEditDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              className="h-8"
              onClick={handleSave}
              disabled={
                Object.values(credentialFields).every(v => !v) ||
                setCredentials.isPending
              }
            >
              {setCredentials.isPending ? 'Saving...' : 'Save Credentials'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Credentials?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete your stored credentials for{' '}
              {selectedMcp?.mcpName}. You will need to re-enter them to use this MCP.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setSelectedMcp(null)}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
