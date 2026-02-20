import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  ArrowLeftIcon,
  PlusIcon,
  TrashIcon,
  Cog6ToothIcon,
} from '@heroicons/react/20/solid';
import { Heading } from '@/components/catalyst/heading';
import { Text } from '@/components/catalyst/text';
import { Badge } from '@/components/catalyst/badge';
import { Button } from '@/components/catalyst/button';
import { Table, TableHead, TableBody, TableRow, TableHeader, TableCell } from '@/components/catalyst/table';
import { Dialog, DialogBody, DialogTitle, DialogDescription, DialogActions } from '@/components/catalyst/dialog';
import { Alert, AlertTitle, AlertDescription, AlertActions } from '@/components/catalyst/alert';
import { Checkbox, CheckboxField } from '@/components/catalyst/checkbox';
import { Label } from '@/components/catalyst/fieldset';
import { useClient, useClientSubscriptions, useUnsubscribe, useUpdateSubscription } from '@/api/hooks/use-clients';
import { useMarketplace } from '@/api/hooks/use-marketplace';
import type { Subscription } from '@/api/types';
import { usePageTitle } from '@/hooks/usePageTitle';

export function ClientDetail() {
  const { clientId } = useParams<{ clientId: string }>();
  const { data: client, isLoading: clientLoading } = useClient(clientId!);
  usePageTitle(client?.clientName || 'Client Details');
  const { data: subscriptions, isLoading: subsLoading } = useClientSubscriptions(clientId!);
  const { data: marketplace } = useMarketplace();
  const unsubscribe = useUnsubscribe();
  const updateSubscription = useUpdateSubscription();

  const [unsubscribeDialogOpen, setUnsubscribeDialogOpen] = useState(false);
  const [subscriptionToDelete, setSubscriptionToDelete] = useState<string | null>(null);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [subscriptionToEdit, setSubscriptionToEdit] = useState<Subscription | null>(null);
  const [selectedTools, setSelectedTools] = useState<string[]>([]);

  const handleUnsubscribe = async () => {
    if (subscriptionToDelete && clientId) {
      try {
        await unsubscribe.mutateAsync({
          clientId,
          subscriptionId: subscriptionToDelete,
        });
        setUnsubscribeDialogOpen(false);
        setSubscriptionToDelete(null);
      } catch (error) {
        console.error('Failed to unsubscribe:', error);
      }
    }
  };

  const handleEditTools = (subscription: Subscription) => {
    const mcp = marketplace?.data?.find(m => m.id === subscription.mcpId);
    setSubscriptionToEdit(subscription);
    const allToolNames = mcp?.tools ? mcp.tools.map(t => t.name) : [];
    setSelectedTools(subscription.selectedTools ?? allToolNames);
    setEditDialogOpen(true);
  };

  const handleSaveTools = async () => {
    if (subscriptionToEdit && clientId) {
      try {
        await updateSubscription.mutateAsync({
          clientId,
          subscriptionId: subscriptionToEdit.id,
          data: { selected_tools: selectedTools },
        });
        setEditDialogOpen(false);
        setSubscriptionToEdit(null);
      } catch (error) {
        console.error('Failed to update subscription:', error);
      }
    }
  };

  if (clientLoading) {
    return (
      <div className="space-y-6">
        <div className="animate-pulse h-8 w-48 rounded bg-zinc-200 dark:bg-zinc-700" />
        <div className="animate-pulse h-32 w-full rounded bg-zinc-200 dark:bg-zinc-700" />
        <div className="animate-pulse h-64 w-full rounded bg-zinc-200 dark:bg-zinc-700" />
      </div>
    );
  }

  if (!client) {
    return (
      <div className="rounded-lg bg-white dark:bg-white/5 ring-1 ring-zinc-950/5 dark:ring-white/10 p-8 text-center">
        <Heading level={3}>Client Not Found</Heading>
        <Text className="mt-2">The requested client could not be found.</Text>
        <div className="mt-4">
          <Button href="/app/clients">Back to Clients</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button plain href="/app/clients">
          <ArrowLeftIcon />
        </Button>
        <div className="flex-1">
          <Heading>{client.clientName}</Heading>
          <Text className="font-mono text-sm">{client.keyPrefix}</Text>
        </div>
        <Badge color={
          client.status === 'active' ? 'green' :
          client.status === 'suspended' ? 'zinc' : 'red'
        }>
          {client.status}
        </Badge>
      </div>

      {/* Client Details */}
      <div className="rounded-lg bg-white dark:bg-white/5 ring-1 ring-zinc-950/5 dark:ring-white/10 p-6">
        <Heading level={2} className="mb-4">Client Details</Heading>
        <dl className="grid gap-6 sm:grid-cols-2">
          <div>
            <dt className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Created</dt>
            <dd className="mt-1 text-zinc-900 dark:text-white">{new Date(client.createdAt).toLocaleString()}</dd>
          </div>
          {client.expiresAt && (
            <div>
              <dt className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Expires</dt>
              <dd className="mt-1 text-zinc-900 dark:text-white">{new Date(client.expiresAt).toLocaleString()}</dd>
            </div>
          )}
          {client.lastUsedAt && (
            <div>
              <dt className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Last Used</dt>
              <dd className="mt-1 text-zinc-900 dark:text-white">{new Date(client.lastUsedAt).toLocaleString()}</dd>
            </div>
          )}
        </dl>
      </div>

      {/* Subscriptions Section */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <Heading level={2}>Subscriptions</Heading>
            <Text className="text-sm">MCPs this client is subscribed to</Text>
          </div>
          <Button href="/app/marketplace">
            <PlusIcon data-slot="icon" />
            Subscribe to MCP
          </Button>
        </div>

        <div className="rounded-lg bg-white dark:bg-white/5 ring-1 ring-zinc-950/5 dark:ring-white/10">
          {subsLoading ? (
            <div className="p-6 space-y-3">
              <div className="animate-pulse h-6 w-full rounded bg-zinc-200 dark:bg-zinc-700" />
              <div className="animate-pulse h-6 w-full rounded bg-zinc-200 dark:bg-zinc-700" />
              <div className="animate-pulse h-6 w-full rounded bg-zinc-200 dark:bg-zinc-700" />
            </div>
          ) : !subscriptions || subscriptions.length === 0 ? (
            <div className="p-8 text-center">
              <Text className="text-zinc-500 dark:text-zinc-400">
                No subscriptions yet. Browse the marketplace to subscribe to MCPs.
              </Text>
            </div>
          ) : (
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeader>MCP Name</TableHeader>
                  <TableHeader>Tools</TableHeader>
                  <TableHeader>Status</TableHeader>
                  <TableHeader>Created</TableHeader>
                  <TableHeader>Actions</TableHeader>
                </TableRow>
              </TableHead>
              <TableBody>
                {subscriptions.map((sub) => {
                  const mcp = marketplace?.data?.find(m => m.id === sub.mcpId);
                  const totalTools = mcp?.tools?.length ?? 0;
                  const selectedCount = sub.selectedTools?.length ?? totalTools;
                  
                  return (
                    <TableRow key={sub.id}>
                      <TableCell>
                        <Link
                          to={`/app/marketplace/${sub.mcpId}`}
                          className="font-medium text-zinc-900 dark:text-white hover:underline"
                        >
                          {sub.mcpName}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Text className="text-sm text-zinc-500">
                          {selectedCount} / {totalTools}
                        </Text>
                      </TableCell>
                      <TableCell>
                        <Badge color={sub.status === 'active' ? 'green' : 'zinc'}>
                          {sub.status}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Text>{new Date(sub.createdAt).toLocaleDateString()}</Text>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => handleEditTools(sub)}
                            className="p-1 text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white"
                            aria-label="Edit tools"
                          >
                            <Cog6ToothIcon className="size-4" />
                          </button>
                          <button
                            onClick={() => {
                              setSubscriptionToDelete(sub.id);
                              setUnsubscribeDialogOpen(true);
                            }}
                            disabled={unsubscribe.isPending}
                            className="p-1 text-zinc-500 dark:text-zinc-400 hover:text-red-600 dark:hover:text-red-400 disabled:opacity-50"
                            aria-label="Unsubscribe"
                          >
                            <TrashIcon className="size-4" />
                          </button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </div>
      </div>

      {/* Unsubscribe Confirmation Alert */}
      <Alert open={unsubscribeDialogOpen} onClose={setUnsubscribeDialogOpen}>
        <AlertTitle>Unsubscribe from MCP?</AlertTitle>
        <AlertDescription>
          This will remove access to this MCP for this client. This action cannot be undone.
        </AlertDescription>
        <AlertActions>
          <Button plain onClick={() => {
            setUnsubscribeDialogOpen(false);
            setSubscriptionToDelete(null);
          }}>
            Cancel
          </Button>
          <Button
            color="red"
            onClick={handleUnsubscribe}
            disabled={unsubscribe.isPending}
          >
            {unsubscribe.isPending ? 'Unsubscribing...' : 'Unsubscribe'}
          </Button>
        </AlertActions>
      </Alert>

      {/* Edit Tools Dialog */}
      <Dialog open={editDialogOpen} onClose={setEditDialogOpen}>
        <DialogTitle>Select Tools</DialogTitle>
        <DialogDescription>
          Choose which tools this client can access from {subscriptionToEdit?.mcpName}
        </DialogDescription>
        <DialogBody>
          <div className="max-h-96 overflow-y-auto space-y-3">
            {marketplace?.data
              ?.find(m => m.id === subscriptionToEdit?.mcpId)
              ?.tools?.map((tool) => (
                <CheckboxField key={tool.name}>
                  <Checkbox
                    name={tool.name}
                    checked={selectedTools.includes(tool.name)}
                    onChange={(checked) => {
                      if (checked) {
                        setSelectedTools([...selectedTools, tool.name]);
                      } else {
                        setSelectedTools(selectedTools.filter(t => t !== tool.name));
                      }
                    }}
                  />
                  <div className="flex-1">
                    <Label className="font-medium cursor-pointer">
                      {tool.name}
                    </Label>
                    {tool.description && (
                      <Text className="text-sm text-zinc-500 mt-1">
                        {tool.description}
                      </Text>
                    )}
                  </div>
                </CheckboxField>
              ))}
          </div>
        </DialogBody>
        <DialogActions>
          <Button plain onClick={() => setEditDialogOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSaveTools}
            disabled={selectedTools.length === 0 || updateSubscription.isPending}
          >
            {updateSubscription.isPending ? 'Saving...' : 'Save'}
          </Button>
        </DialogActions>
      </Dialog>
    </div>
  );
}
