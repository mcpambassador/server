import { BuildingStorefrontIcon, UserCircleIcon } from '@heroicons/react/20/solid';
import { Heading } from '@/components/catalyst/heading';
import { Text } from '@/components/catalyst/text';
import { Badge } from '@/components/catalyst/badge';
import { Button } from '@/components/catalyst/button';
import { Table, TableHead, TableBody, TableRow, TableHeader, TableCell } from '@/components/catalyst/table';
import { useClients } from '@/api/hooks/use-clients';
import { useMarketplace } from '@/api/hooks/use-marketplace';
import { usePageTitle } from '@/hooks/usePageTitle';

export function Dashboard() {
  usePageTitle('Dashboard');
  const { data: clients, isLoading: clientsLoading } = useClients();
  const { data: marketplace, isLoading: marketplaceLoading } = useMarketplace();

  const activeClients = clients?.filter(c => c.status === 'active').length ?? 0;
  const totalMcps = marketplace?.data?.length ?? 0;

  const stats = [
    {
      name: 'My Clients',
      value: clientsLoading ? '...' : clients?.length ?? 0,
      subtitle: clientsLoading ? '' : `${activeClients} active`,
    },
    {
      name: 'MCPs Available',
      value: marketplaceLoading ? '...' : totalMcps,
      subtitle: 'in marketplace',
    },
    {
      name: 'Activity',
      value: 'Live',
      subtitle: 'System operational',
    },
  ];

  return (
    <div className="space-y-8">
      {/* Page Header */}
      <div>
        <Heading>Dashboard</Heading>
        <Text className="mt-2 text-zinc-500">Welcome to MCP Ambassador</Text>
      </div>

      {/* Stats Grid */}
      <dl className="grid grid-cols-1 gap-px overflow-hidden rounded-lg bg-zinc-900/5 dark:bg-white/5 sm:grid-cols-2 lg:grid-cols-3">
        {stats.map((stat) => (
          <div
            key={stat.name}
            className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 bg-white dark:bg-white/5 px-4 py-10 sm:px-6 xl:px-8"
          >
            <dt className="text-sm/6 font-medium text-zinc-500 dark:text-zinc-400">{stat.name}</dt>
            {clientsLoading || marketplaceLoading ? (
              <dd className="w-full flex-none">
                <div className="animate-pulse h-8 w-20 rounded bg-zinc-200 dark:bg-zinc-700" />
              </dd>
            ) : (
              <>
                <dd className="w-full flex-none text-3xl/10 font-medium tracking-tight text-zinc-900 dark:text-white">
                  {stat.value}
                </dd>
                <dd className="text-sm text-zinc-500 dark:text-zinc-400">{stat.subtitle}</dd>
              </>
            )}
          </div>
        ))}
      </dl>

      {/* Recent Clients */}
      <div>
        <div className="mb-4">
          <h3 className="text-base font-semibold text-zinc-900 dark:text-white">Recent Clients</h3>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">Your most recently created API clients</p>
        </div>

        {clientsLoading ? (
          <div className="rounded-lg bg-white dark:bg-white/5 ring-1 ring-zinc-950/5 dark:ring-white/10 p-6 space-y-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="animate-pulse h-12 w-full rounded bg-zinc-200 dark:bg-zinc-700" />
            ))}
          </div>
        ) : clients && clients.length > 0 ? (
          <div className="rounded-lg bg-white dark:bg-white/5 ring-1 ring-zinc-950/5 dark:ring-white/10">
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeader>Client</TableHeader>
                  <TableHeader>Key Prefix</TableHeader>
                  <TableHeader>Status</TableHeader>
                  <TableHeader>Created</TableHeader>
                </TableRow>
              </TableHead>
              <TableBody>
                {clients.slice(0, 5).map((client) => (
                  <TableRow key={client.id} href={`/app/clients/${client.id}`}>
                    <TableCell className="font-medium">{client.clientName}</TableCell>
                    <TableCell className="text-zinc-500">{client.keyPrefix}</TableCell>
                    <TableCell>
                      <Badge color={client.status === 'active' ? 'green' : 'zinc'}>
                        {client.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-zinc-500">
                      {new Date(client.createdAt).toLocaleDateString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <div className="rounded-lg border-2 border-dashed border-zinc-300 dark:border-zinc-600 bg-white dark:bg-white/5 px-6 py-10 text-center">
            <UserCircleIcon className="mx-auto size-12 text-zinc-400" />
            <h3 className="mt-2 text-sm font-semibold text-zinc-900 dark:text-white">No clients</h3>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              Get started by creating your first API client.
            </p>
            <div className="mt-6">
              <Button href="/app/clients">Create Client</Button>
            </div>
          </div>
        )}
      </div>

      {/* Quick Actions */}
      <div className="rounded-lg bg-white dark:bg-white/5 ring-1 ring-zinc-950/5 dark:ring-white/10">
        <div className="px-4 py-5 sm:p-6">
          <h3 className="text-base font-semibold text-zinc-900 dark:text-white">Quick Actions</h3>
          <div className="mt-2 max-w-xl text-sm text-zinc-500 dark:text-zinc-400">
            <p>Common tasks to get you started</p>
          </div>
          <div className="mt-5 flex flex-wrap gap-3">
            <Button href="/app/clients" outline>
              <UserCircleIcon data-slot="icon" />
              Create Client
            </Button>
            <Button href="/app/marketplace" outline>
              <BuildingStorefrontIcon data-slot="icon" />
              Browse Marketplace
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
