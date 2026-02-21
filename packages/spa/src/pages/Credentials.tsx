import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  KeyIcon,
  TrashIcon,
  PencilIcon,
  CheckCircleIcon,
  XCircleIcon,
} from '@heroicons/react/20/solid';
import { Heading } from '@/components/catalyst/heading';
import { Text } from '@/components/catalyst/text';
import { Button } from '@/components/catalyst/button';
import { Badge } from '@/components/catalyst/badge';
import { Table, TableHead, TableBody, TableRow, TableHeader, TableCell } from '@/components/catalyst/table';
import { Dialog, DialogTitle, DialogDescription, DialogActions } from '@/components/catalyst/dialog';
import { Alert, AlertTitle, AlertDescription, AlertActions } from '@/components/catalyst/alert';
import { Field, Label } from '@/components/catalyst/fieldset';
import { Input } from '@/components/catalyst/input';
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
  const [parsedFields, setParsedFields] = useState<Array<{
    key: string;
    label: string;
    required: boolean;
    sensitive: boolean;
  }>>([]);

  const handleEdit = (mcp: CredentialStatus) => {
    setSelectedMcp(mcp);
    // Parse credential schema to extract properties
    try {
      const schema = typeof mcp.credentialSchema === 'string'
        ? JSON.parse(mcp.credentialSchema)
        : mcp.credentialSchema;
      const props = schema?.properties || {};
      const required = schema?.required || [];
      const fields = Object.entries(props).map(([key, value]: [string, any]) => ({
        key,
        label: value?.description || key.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()),
        required: required.includes(key),
        sensitive: /key|secret|token|password/i.test(key),
      }));
      setParsedFields(fields);
      
      // Initialize credential fields with empty strings
      const initialFields: Record<string, string> = {};
      fields.forEach(f => {
        initialFields[f.key] = '';
      });
      setCredentialFields(initialFields);
    } catch (error) {
      console.error('Failed to parse credential schema:', error);
      setParsedFields([]);
      setCredentialFields({});
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

  const credentialsRequiring = (credentials?.filter(c => c.requiresCredentials) ?? []).map(c => ({
    ...c,
    id: c.mcpId,
  }));

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div>
        <Heading>Credentials</Heading>
        <Text className="mt-1">Manage credentials for MCPs that require authentication</Text>
      </div>

      {/* MCP Credentials Panel */}
      <div className="rounded-lg bg-white dark:bg-white/5 ring-1 ring-zinc-950/5 dark:ring-white/10">
        <div className="px-6 py-5 border-b border-zinc-950/5 dark:border-white/10">
          <h2 className="text-base font-semibold text-zinc-900 dark:text-white">MCP Credentials</h2>
          <Text className="mt-1">Some MCPs require credentials to access external services. Configure them here.</Text>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <Table className="w-full">
            <TableHead>
              <TableRow>
                <TableHeader>MCP Name</TableHeader>
                <TableHeader>Status</TableHeader>
                <TableHeader>Last Updated</TableHeader>
                <TableHeader>Actions</TableHeader>
              </TableRow>
            </TableHead>
            <TableBody>
              {isLoading ? (
                // Loading state
                Array.from({ length: 3 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <div className="animate-pulse h-4 w-4 rounded bg-zinc-200 dark:bg-zinc-700" />
                        <div className="animate-pulse h-4 w-32 rounded bg-zinc-200 dark:bg-zinc-700" />
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="animate-pulse h-6 w-24 rounded-full bg-zinc-200 dark:bg-zinc-700" />
                    </TableCell>
                    <TableCell>
                      <div className="animate-pulse h-4 w-40 rounded bg-zinc-200 dark:bg-zinc-700" />
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <div className="animate-pulse h-8 w-8 rounded bg-zinc-200 dark:bg-zinc-700" />
                        <div className="animate-pulse h-8 w-8 rounded bg-zinc-200 dark:bg-zinc-700" />
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              ) : credentialsRequiring.length === 0 ? (
                // Empty state
                <TableRow>
                  <TableCell colSpan={4} className="text-center py-12">
                    <Text className="text-zinc-500 dark:text-zinc-400">No MCPs require credentials</Text>
                  </TableCell>
                </TableRow>
              ) : (
                // Data rows
                credentialsRequiring.map((cred) => (
                  <TableRow key={cred.mcpId}>
                    {/* MCP Name */}
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <KeyIcon className="size-4 text-zinc-500 dark:text-zinc-400" />
                        <Link
                          to={`/app/marketplace/${cred.mcpId}`}
                          className="font-medium text-zinc-900 dark:text-white hover:underline"
                        >
                          {cred.mcpName}
                        </Link>
                      </div>
                    </TableCell>

                    {/* Status */}
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {cred.hasCredentials ? (
                          <>
                            <CheckCircleIcon className="size-4 text-green-600 dark:text-green-400" />
                            <Badge color="green">Configured</Badge>
                          </>
                        ) : (
                          <>
                            <XCircleIcon className="size-4 text-zinc-400" />
                            <Badge color="zinc">Not Set</Badge>
                          </>
                        )}
                      </div>
                    </TableCell>

                    {/* Last Updated */}
                    <TableCell>
                      <span className="text-zinc-900 dark:text-white">
                        {cred.updatedAt ? new Date(cred.updatedAt).toLocaleString() : '—'}
                      </span>
                    </TableCell>

                    {/* Actions */}
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Button
                          plain
                          onClick={() => handleEdit(cred)}
                          aria-label="Edit credentials"
                        >
                          <PencilIcon data-slot="icon" />
                        </Button>
                        {cred.hasCredentials && (
                          <Button
                            plain
                            onClick={() => {
                              setSelectedMcp(cred);
                              setDeleteDialogOpen(true);
                            }}
                            disabled={deleteCredentials.isPending}
                            aria-label="Delete credentials"
                          >
                            <TrashIcon data-slot="icon" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Edit Credentials Dialog */}
      <Dialog open={editDialogOpen} onClose={setEditDialogOpen}>
        <DialogTitle>
          {selectedMcp?.hasCredentials ? 'Update' : 'Set'} Credentials for {selectedMcp?.mcpName}
        </DialogTitle>
        <DialogDescription>
          Enter the required credentials. They will be stored securely and never displayed.
        </DialogDescription>
        <div className="mt-4 space-y-4">
          {parsedFields.map((field) => (
            <Field key={field.key}>
              <Label>
                {field.label}
                {field.required && <span className="text-red-600 dark:text-red-400"> *</span>}
              </Label>
              <Input
                type={field.sensitive ? 'password' : 'text'}
                value={credentialFields[field.key] ?? ''}
                onChange={(e) =>
                  setCredentialFields({
                    ...credentialFields,
                    [field.key]: e.target.value,
                  })
                }
                placeholder={selectedMcp?.hasCredentials ? '(unchanged)' : ''}
                required={field.required}
              />
            </Field>
          ))}
        </div>
        <DialogActions>
          <Button plain onClick={() => setEditDialogOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={
              Object.values(credentialFields).every(v => !v) ||
              setCredentials.isPending
            }
          >
            {setCredentials.isPending ? 'Saving...' : 'Save Credentials'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Alert open={deleteDialogOpen} onClose={setDeleteDialogOpen}>
        <AlertTitle>Delete Credentials?</AlertTitle>
        <AlertDescription>
          This will permanently delete your stored credentials for{' '}
          {selectedMcp?.mcpName}. You will need to re-enter them to use this MCP.
        </AlertDescription>
        <AlertActions>
          <Button plain onClick={() => setDeleteDialogOpen(false)}>
            Cancel
          </Button>
          <Button
            color="red"
            onClick={handleDelete}
            disabled={deleteCredentials.isPending}
          >
            Delete
          </Button>
        </AlertActions>
      </Alert>
    </div>
  );
}
