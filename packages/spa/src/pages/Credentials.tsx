import { useState, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  KeyIcon,
  TrashIcon,
  PencilIcon,
  CheckCircleIcon,
  XCircleIcon,
  ArrowTopRightOnSquareIcon,
  ClockIcon,
} from '@heroicons/react/20/solid';
import { toast } from 'sonner';
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
import { useOAuthAuthorize, useOAuthStatus, useOAuthDisconnect } from '@/api/hooks/use-oauth';
import type { CredentialStatus } from '@/api/types';
import { usePageTitle } from '@/hooks/usePageTitle';

// OAuth Connection Card Component
function OAuthConnectionCard({ cred }: { cred: CredentialStatus }) {
  const { data: oauthStatus, isLoading: statusLoading } = useOAuthStatus(cred.mcpName);
  const authorize = useOAuthAuthorize();
  const disconnect = useOAuthDisconnect();
  const [disconnectDialogOpen, setDisconnectDialogOpen] = useState(false);

  const status = oauthStatus?.status || 'not_connected';
  const isConnected = status === 'active';
  const needsReconnect = status === 'expired' || status === 'revoked';

  const handleConnect = async () => {
    try {
      const response = await authorize.mutateAsync(cred.mcpName);
      window.location.href = response.authorization_url;
    } catch (error) {
      console.error('OAuth authorization failed:', error);
      toast.error('Connection Failed', { description: 'Failed to initiate OAuth connection' });
    }
  };

  const handleDisconnect = async () => {
    try {
      await disconnect.mutateAsync(cred.mcpName);
      setDisconnectDialogOpen(false);
      toast.success('Disconnected', { description: `Disconnected from ${cred.mcpName}` });
    } catch (error) {
      console.error('OAuth disconnect failed:', error);
      toast.error('Disconnect Failed', { description: 'Failed to disconnect OAuth connection' });
    }
  };

  return (
    <>
      <div className="rounded-lg border border-zinc-950/10 dark:border-white/10 p-4 bg-white dark:bg-white/5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-2">
              <KeyIcon className="size-5 text-zinc-500 dark:text-zinc-400 flex-shrink-0" />
              <Link
                to={`/app/marketplace/${cred.mcpId}`}
                className="font-medium text-zinc-900 dark:text-white hover:underline truncate"
              >
                {cred.mcpName}
              </Link>
            </div>
            
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
              {statusLoading ? (
                <div className="animate-pulse h-6 w-24 rounded-full bg-zinc-200 dark:bg-zinc-700" />
              ) : (
                <>
                  {isConnected && (
                    <>
                      <div className="flex items-center gap-1.5">
                        <CheckCircleIcon className="size-4 text-green-600 dark:text-green-400" />
                        <Badge color="green">Connected</Badge>
                      </div>
                      {oauthStatus?.expires_at && (
                        <div className="flex items-center gap-1.5 text-zinc-600 dark:text-zinc-400">
                          <ClockIcon className="size-4" />
                          <span>Expires: {new Date(oauthStatus.expires_at).toLocaleDateString()}</span>
                        </div>
                      )}
                    </>
                  )}
                  {status === 'expired' && (
                    <div className="flex items-center gap-1.5">
                      <XCircleIcon className="size-4 text-amber-600 dark:text-amber-400" />
                      <Badge color="amber">Expired</Badge>
                    </div>
                  )}
                  {status === 'revoked' && (
                    <div className="flex items-center gap-1.5">
                      <XCircleIcon className="size-4 text-red-600 dark:text-red-400" />
                      <Badge color="red">Revoked</Badge>
                    </div>
                  )}
                  {status === 'not_connected' && (
                    <div className="flex items-center gap-1.5">
                      <XCircleIcon className="size-4 text-zinc-400" />
                      <Badge color="zinc">Not Connected</Badge>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 flex-shrink-0">
            {isConnected ? (
              <Button
                plain
                onClick={() => setDisconnectDialogOpen(true)}
                disabled={disconnect.isPending}
              >
                Disconnect
              </Button>
            ) : (
              <Button
                onClick={handleConnect}
                disabled={authorize.isPending || statusLoading}
              >
                {authorize.isPending ? (
                  'Connecting...'
                ) : (
                  <>
                    <ArrowTopRightOnSquareIcon data-slot="icon" />
                    {needsReconnect ? 'Reconnect' : 'Connect'}
                  </>
                )}
              </Button>
            )}
          </div>
        </div>
      </div>

      <Alert open={disconnectDialogOpen} onClose={setDisconnectDialogOpen}>
        <AlertTitle>Disconnect OAuth Connection?</AlertTitle>
        <AlertDescription>
          This will revoke your OAuth connection to {cred.mcpName}. You'll need to reconnect to use this MCP.
        </AlertDescription>
        <AlertActions>
          <Button plain onClick={() => setDisconnectDialogOpen(false)}>
            Cancel
          </Button>
          <Button color="red" onClick={handleDisconnect} disabled={disconnect.isPending}>
            {disconnect.isPending ? 'Disconnecting...' : 'Disconnect'}
          </Button>
        </AlertActions>
      </Alert>
    </>
  );
}

export function Credentials() {
  usePageTitle('Credentials');
  const { data: credentials, isLoading } = useCredentialStatus();
  const setCredentials = useSetCredentials();
  const deleteCredentials = useDeleteCredentials();
  const [searchParams, setSearchParams] = useSearchParams();

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

  // Handle OAuth callback notifications
  useEffect(() => {
    const status = searchParams.get('status');
    const mcpName = searchParams.get('mcp');
    const reason = searchParams.get('reason');
    
    if (status === 'success' && mcpName) {
      toast.success('OAuth Connected', { description: `Successfully connected to ${mcpName}` });
      setSearchParams({}, { replace: true });
    } else if (status === 'error') {
      const messages: Record<string, string> = {
        invalid_request: 'Invalid OAuth request. Please try again.',
        invalid_state: 'OAuth session expired. Please try again.',
        token_exchange_failed: 'Failed to exchange authorization code. Check provider configuration.',
        server_error: 'A server error occurred. Please try again later.',
      };
      toast.error('OAuth Connection Failed', { 
        description: messages[reason || ''] || `Error: ${reason}` 
      });
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams]);

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
      toast.error('Failed to save credentials', { description: (error as Error)?.message ?? String(error) });
    }
  };

  const handleDelete = async () => {
    if (!selectedMcp) return;

    try {
      await deleteCredentials.mutateAsync(selectedMcp.mcpId);
      setDeleteDialogOpen(false);
      setSelectedMcp(null);
    } catch (error) {
      toast.error('Failed to delete credentials', { description: (error as Error)?.message ?? String(error) });
    }
  };

  // Split credentials into OAuth and static
  const allCredentials = credentials?.filter(c => c.requiresCredentials) ?? [];
  const oauthCredentials = allCredentials.filter(c => c.authType === 'oauth2');
  const staticCredentials = allCredentials.filter(c => c.authType !== 'oauth2').map(c => ({
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

      {/* OAuth Connections Section */}
      {oauthCredentials.length > 0 && (
        <div className="rounded-lg bg-white dark:bg-white/5 ring-1 ring-zinc-950/10 dark:ring-white/10">
          <div className="px-6 py-5 border-b border-zinc-950/5 dark:border-white/10">
            <h2 className="text-base font-semibold text-zinc-900 dark:text-white">OAuth Connections</h2>
            <Text className="mt-1">Connect your accounts to MCPs that use OAuth 2.0 authentication</Text>
          </div>

          <div className="p-6 space-y-4">
            {isLoading ? (
              Array.from({ length: 2 }).map((_, i) => (
                <div key={i} className="animate-pulse rounded-lg border border-zinc-200 dark:border-zinc-700 p-4">
                  <div className="flex items-center justify-between">
                    <div className="space-y-2 flex-1">
                      <div className="h-5 w-32 rounded bg-zinc-200 dark:bg-zinc-700" />
                      <div className="h-4 w-24 rounded bg-zinc-200 dark:bg-zinc-700" />
                    </div>
                    <div className="h-9 w-24 rounded bg-zinc-200 dark:bg-zinc-700" />
                  </div>
                </div>
              ))
            ) : (
              oauthCredentials.map((cred) => (
                <OAuthConnectionCard key={cred.mcpId} cred={cred} />
              ))
            )}
          </div>
        </div>
      )}

      {/* Static Credentials Section */}
      {staticCredentials.length > 0 && (
        <div className="rounded-lg bg-white dark:bg-white/5 ring-1 ring-zinc-950/10 dark:ring-white/10">
          <div className="px-6 py-5 border-b border-zinc-950/5 dark:border-white/10">
            <h2 className="text-base font-semibold text-zinc-900 dark:text-white">Static Credentials</h2>
            <Text className="mt-1">MCPs that require API keys, tokens, or passwords</Text>
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
                ) : (
                  staticCredentials.map((cred) => (
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
      )}

      {/* Empty state if no credentials needed */}
      {!isLoading && oauthCredentials.length === 0 && staticCredentials.length === 0 && (
        <div className="rounded-lg bg-white dark:bg-white/5 ring-1 ring-zinc-950/10 dark:ring-white/10 p-12 text-center">
          <Text className="text-zinc-500 dark:text-zinc-400">No MCPs require credentials</Text>
        </div>
      )}

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
