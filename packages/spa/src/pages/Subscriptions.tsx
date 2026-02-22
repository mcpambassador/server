import { Link } from 'react-router-dom';
import { ArrowTopRightOnSquareIcon, ServerStackIcon } from '@heroicons/react/20/solid';
import { Heading } from '@/components/catalyst/heading';
import { Text } from '@/components/catalyst/text';
import { Badge } from '@/components/catalyst/badge';
import { Button } from '@/components/catalyst/button';
import { Table, TableHead, TableBody, TableRow, TableHeader, TableCell } from '@/components/catalyst/table';
import { useClients, useClientSubscriptions, useUserSubscriptions } from '@/api/hooks/use-clients';
import type { Client } from '@/api/types';
import { usePageTitle } from '@/hooks/usePageTitle';

function ClientSubscriptionsSection({ client, subscriptions: providedSubscriptions }: { client: Client; subscriptions?: any[] }) {
  // If subscriptions are provided by the parent aggregate call, use them to avoid extra requests
  const { data: subsFromHook, isLoading: hookLoading } = useClientSubscriptions(client.id);
  const subscriptions = providedSubscriptions ?? subsFromHook;
  const isLoading = providedSubscriptions ? false : hookLoading;

  return (
    <div className="rounded-lg bg-white dark:bg-white/5 ring-1 ring-zinc-950/10 dark:ring-white/10 overflow-hidden">
      {/* Client Header */}
      <div className="px-6 py-4 border-b border-zinc-950/5 dark:border-white/10">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h3 className="text-base font-semibold text-zinc-900 dark:text-white">
              {client.clientName}
            </h3>
            <Badge color={client.status === 'active' ? 'green' : client.status === 'suspended' ? 'amber' : 'zinc'}>
              {client.status}
            </Badge>
            {subscriptions && subscriptions.length > 0 && (
              <Text className="text-sm text-zinc-500 dark:text-zinc-400">
                {subscriptions.length} {subscriptions.length === 1 ? 'subscription' : 'subscriptions'}
              </Text>
            )}
          </div>
          <Link
            to={`/app/clients/${client.id}`}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-zinc-900 dark:text-white hover:text-zinc-600 dark:hover:text-zinc-300"
          >
            View Client
            <ArrowTopRightOnSquareIcon className="size-4" />
          </Link>
        </div>
        <Text className="mt-1 text-sm font-mono text-zinc-500 dark:text-zinc-400">
          {client.keyPrefix}
        </Text>
      </div>

      {/* Subscriptions Table */}
      {isLoading ? (
        <div className="p-6 space-y-3">
          <div className="animate-pulse h-6 w-full rounded bg-zinc-200 dark:bg-zinc-700" />
          <div className="animate-pulse h-6 w-full rounded bg-zinc-200 dark:bg-zinc-700" />
          <div className="animate-pulse h-6 w-full rounded bg-zinc-200 dark:bg-zinc-700" />
        </div>
      ) : !subscriptions || subscriptions.length === 0 ? (
        <div className="p-8 text-center">
          <Text className="text-zinc-500 dark:text-zinc-400">
            No subscriptions for this client. Browse the <Link to="/app/marketplace" className="font-medium hover:underline">marketplace</Link> to subscribe to MCPs.
          </Text>
        </div>
      ) : (
        <Table>
          <TableHead>
            <TableRow>
              <TableHeader>MCP Name</TableHeader>
              <TableHeader>Status</TableHeader>
              <TableHeader>Tools</TableHeader>
              <TableHeader>Subscribed</TableHeader>
            </TableRow>
          </TableHead>
          <TableBody>
            {subscriptions.map((sub) => (
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
                  <Badge color={sub.status === 'active' ? 'green' : 'amber'}>
                    {sub.status}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Text className="text-sm">
                    {sub.selectedTools && sub.selectedTools.length > 0
                      ? `${sub.selectedTools.length} ${sub.selectedTools.length === 1 ? 'tool' : 'tools'}`
                      : 'All tools'}
                  </Text>
                </TableCell>
                <TableCell>
                  <Text className="text-sm text-zinc-500 dark:text-zinc-400">
                    {new Date(sub.createdAt).toLocaleDateString()}
                  </Text>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

export function Subscriptions() {
  usePageTitle('My Subscriptions');
  const { data: clients, isLoading } = useClients();
  const { data: allSubscriptions } = useUserSubscriptions();

  const activeClients = clients?.filter(c => c.status === 'active' || c.status === 'suspended') ?? [];

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div>
        <Heading>My Subscriptions</Heading>
        <Text className="mt-2 text-zinc-500 dark:text-zinc-400">
          View and manage MCP subscriptions across all your clients
        </Text>
      </div>

      {/* Loading State */}
      {isLoading ? (
        <div className="space-y-4">
          <div className="animate-pulse h-64 w-full rounded-lg bg-zinc-200 dark:bg-zinc-700" />
          <div className="animate-pulse h-64 w-full rounded-lg bg-zinc-200 dark:bg-zinc-700" />
        </div>
      ) : !clients || clients.length === 0 ? (
        /* Empty State - No Clients */
        <div className="rounded-lg border-2 border-dashed border-zinc-300 dark:border-zinc-600 bg-white dark:bg-white/5 px-6 py-10 text-center">
          <ServerStackIcon className="mx-auto size-12 text-zinc-400" />
          <h3 className="mt-2 text-sm font-semibold text-zinc-900 dark:text-white">No Clients Yet</h3>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Create a client to start subscribing to MCPs.
          </p>
          <div className="mt-6">
            <Button href="/app/clients">Create Client</Button>
          </div>
        </div>
      ) : activeClients.length === 0 ? (
        /* Empty State - No Active Clients */
        <div className="rounded-lg border-2 border-dashed border-zinc-300 dark:border-zinc-600 bg-white dark:bg-white/5 px-6 py-10 text-center">
          <ServerStackIcon className="mx-auto size-12 text-zinc-400" />
          <h3 className="mt-2 text-sm font-semibold text-zinc-900 dark:text-white">No Active Clients</h3>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            All your clients are currently inactive or revoked.
          </p>
          <div className="mt-6">
            <Button href="/app/clients">Manage Clients</Button>
          </div>
        </div>
      ) : (
        /* Client Subscriptions Sections */
        <div className="space-y-6">
          {activeClients.map((client) => (
            <ClientSubscriptionsSection
              key={client.id}
              client={client}
              subscriptions={allSubscriptions?.filter(s => s.clientId === client.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
