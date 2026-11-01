import { useState } from 'react';
import { toast } from 'sonner';
import { Heading } from '@/components/catalyst/heading';
import { Text } from '@/components/catalyst/text';
import { Button } from '@/components/catalyst/button';
import { Badge } from '@/components/catalyst/badge';
import { Switch } from '@/components/catalyst/switch';
import { Field, Label, Description } from '@/components/catalyst/fieldset';
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
import {
  useAgentEndpointSettings,
  useUpdateAgentEndpointSettings,
  useOAuthClients,
  useSetOAuthClientDisabled,
  useDeleteOAuthClient,
} from '@/api/hooks/use-agent';
import type { OAuthClientSummary } from '@/api/agent-types';
import { RegisterClientDialog } from './RegisterClientDialog';
import { usePageTitle } from '@/hooks/usePageTitle';

export function AgentEndpoint() {
  usePageTitle('Admin - Agent endpoint');
  const {
    data: settings,
    isLoading: settingsLoading,
    error: settingsError,
  } = useAgentEndpointSettings();
  const updateSettings = useUpdateAgentEndpointSettings();
  const { data: clients, isLoading: clientsLoading } = useOAuthClients();
  const setDisabled = useSetOAuthClientDisabled();
  const deleteClient = useDeleteOAuthClient();
  const [pending, setPending] = useState<OAuthClientSummary | null>(null);
  const [deleting, setDeleting] = useState<OAuthClientSummary | null>(null);
  const [registerOpen, setRegisterOpen] = useState(false);

  const toggleDcr = async (value: boolean) => {
    try {
      await updateSettings.mutateAsync({ dynamic_client_registration: value });
      toast.success(`Dynamic client registration ${value ? 'enabled' : 'disabled'}`);
    } catch (err) {
      toast.error('Failed to update setting', { description: (err as Error)?.message });
    }
  };

  const confirmDisable = async () => {
    if (!pending) return;
    try {
      await setDisabled.mutateAsync({ clientId: pending.client_id, disabled: true });
      toast.success(`Disabled ${pending.client_name}`);
      setPending(null);
    } catch (err) {
      toast.error('Failed to disable client', { description: (err as Error)?.message });
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await deleteClient.mutateAsync(deleting.client_id);
      toast.success(`Deleted ${deleting.client_name}`);
      setDeleting(null);
    } catch (err) {
      toast.error('Failed to delete client', { description: (err as Error)?.message });
    }
  };

  const enable = async (c: OAuthClientSummary) => {
    try {
      await setDisabled.mutateAsync({ clientId: c.client_id, disabled: false });
      toast.success(`Enabled ${c.client_name}`);
    } catch (err) {
      toast.error('Failed to enable client', { description: (err as Error)?.message });
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <Heading>Agent endpoint</Heading>
        <Text>OAuth clients and settings for the remote agent (Streamable HTTP) endpoint</Text>
      </div>

      <div className="rounded-lg bg-white p-6 ring-1 ring-zinc-950/10 dark:bg-white/5 dark:ring-white/10">
        <h3 className="text-base/7 font-semibold text-zinc-900 dark:text-white">Settings</h3>
        {settingsLoading ? (
          <div className="mt-4 animate-pulse h-10 rounded bg-zinc-200 dark:bg-zinc-700" />
        ) : settingsError || !settings ? (
          <Text role="alert" className="mt-4">
            Could not load settings: {(settingsError as Error | null)?.message ?? 'unknown error'}
          </Text>
        ) : (
          <div className="mt-4 space-y-4">
            <div className="flex items-center gap-2">
              <Text>Endpoint</Text>
              <Badge color={settings.enabled ? 'green' : 'zinc'}>
                {settings.enabled ? 'Enabled' : 'Disabled'}
              </Badge>
              {!settings.enabled && (
                <Text className="text-sm">(set agent_endpoint.enabled in server config)</Text>
              )}
            </div>
            <Field className="flex items-center justify-between gap-4">
              <div>
                <Label>Dynamic client registration</Label>
                <Description>
                  Lets agents register themselves (RFC 7591). Self-registered clients show an
                  “unverified” warning on the consent screen.
                </Description>
              </div>
              <Switch
                name="dcr"
                aria-label="Dynamic client registration"
                checked={settings.dynamic_client_registration}
                onChange={toggleDcr}
                disabled={updateSettings.isPending}
              />
            </Field>
          </div>
        )}
      </div>

      <div>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-base/7 font-semibold text-zinc-900 dark:text-white">
            Registered clients
          </h3>
          <Button onClick={() => setRegisterOpen(true)}>Register client</Button>
        </div>
        {clientsLoading ? (
          <div className="animate-pulse h-32 w-full rounded-lg bg-zinc-200 dark:bg-zinc-700" />
        ) : !clients || clients.length === 0 ? (
          <EmptyState
            title="No OAuth clients"
            description="Use Register client to add one, or enable dynamic client registration."
          />
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableHeader>Name</TableHeader>
                <TableHeader>Registered via</TableHeader>
                <TableHeader>Redirect URIs</TableHeader>
                <TableHeader>Last used</TableHeader>
                <TableHeader>Status</TableHeader>
                <TableHeader>
                  <span className="sr-only">Actions</span>
                </TableHeader>
              </TableRow>
            </TableHead>
            <TableBody>
              {clients.map(c => (
                <TableRow key={c.client_id}>
                  <TableCell className="font-medium">{c.client_name}</TableCell>
                  <TableCell>
                    <Badge color={c.registered_via === 'admin' ? 'green' : 'amber'}>
                      {c.registered_via === 'admin' ? 'Admin' : 'DCR (unverified)'}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-xs break-all text-xs">
                    {c.redirect_uris.join(', ')}
                  </TableCell>
                  <TableCell>
                    {c.last_used_at ? new Date(c.last_used_at).toLocaleString() : 'Never'}
                  </TableCell>
                  <TableCell>
                    <Badge color={c.disabled ? 'red' : 'green'}>
                      {c.disabled ? 'Disabled' : 'Active'}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {c.disabled ? (
                      <Button plain onClick={() => enable(c)} disabled={setDisabled.isPending}>
                        Enable
                      </Button>
                    ) : (
                      <Button plain onClick={() => setPending(c)} disabled={setDisabled.isPending}>
                        Disable
                      </Button>
                    )}
                    <Button plain onClick={() => setDeleting(c)} disabled={deleteClient.isPending}>
                      Delete
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <ConfirmDialog
        open={!!pending}
        onClose={open => {
          if (!open) setPending(null);
        }}
        title="Disable OAuth client?"
        description={
          pending
            ? `${pending.client_name} will no longer be able to start authorizations or refresh tokens.`
            : undefined
        }
        confirmLabel="Disable"
        onConfirm={confirmDisable}
        isLoading={setDisabled.isPending}
      />
      <ConfirmDialog
        open={!!deleting}
        onClose={open => {
          if (!open) setDeleting(null);
        }}
        title="Delete OAuth client?"
        description={
          deleting
            ? `${deleting.client_name} will be removed permanently and its active grants revoked. Agents using it must be registered again.`
            : undefined
        }
        confirmLabel="Delete"
        onConfirm={confirmDelete}
        isLoading={deleteClient.isPending}
      />

      <RegisterClientDialog open={registerOpen} onClose={() => setRegisterOpen(false)} />
    </div>
  );
}
