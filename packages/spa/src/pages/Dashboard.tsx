import { Link } from 'react-router-dom';
import { Store, UserCircle, Activity } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/catalyst/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useClients } from '@/api/hooks/use-clients';
import { useMarketplace } from '@/api/hooks/use-marketplace';
import { usePageTitle } from '@/hooks/usePageTitle';

export function Dashboard() {
  usePageTitle('Dashboard');
  const { data: clients, isLoading: clientsLoading } = useClients();
  const { data: marketplace, isLoading: marketplaceLoading } = useMarketplace();

  const activeClients = clients?.filter(c => c.status === 'active').length ?? 0;
  const totalMcps = marketplace?.data?.length ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between pb-4 border-b border-border mb-6">
        <div>
          <h1 className="text-xl font-semibold">Dashboard</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Welcome to MCP Ambassador
          </p>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">My Clients</CardTitle>
            <UserCircle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {clientsLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <>
                <div className="text-2xl font-bold">{clients?.length ?? 0}</div>
                <p className="text-xs text-muted-foreground">
                  {activeClients} active
                </p>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">MCPs Available</CardTitle>
            <Store className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {marketplaceLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <>
                <div className="text-2xl font-bold">{totalMcps}</div>
                <p className="text-xs text-muted-foreground">
                  in marketplace
                </p>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Activity</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">Live</div>
            <p className="text-xs text-muted-foreground">
              System operational
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Recent Clients */}
      <Card>
        <CardHeader>
          <CardTitle>Recent Clients</CardTitle>
          <CardDescription>
            Your most recently created API clients
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {clientsLoading ? (
            <div className="space-y-0">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="border-b last:border-b-0 px-6 py-3">
                  <Skeleton className="h-4 w-full" />
                </div>
              ))}
            </div>
          ) : clients && clients.length > 0 ? (
            <div className="divide-y">
              {clients.slice(0, 5).map((client) => (
                <Link
                  key={client.id}
                  to={`/app/clients/${client.id}`}
                  className="flex items-center justify-between px-6 py-3 hover:bg-muted/50 transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <UserCircle className="h-5 w-5 text-muted-foreground shrink-0" />
                    <div className="min-w-0">
                      <p className="font-medium text-sm truncate">{client.clientName}</p>
                      <p className="text-xs text-muted-foreground">{client.keyPrefix}</p>
                    </div>
                  </div>
                  <div className="text-xs text-muted-foreground shrink-0">
                    {new Date(client.createdAt).toLocaleDateString()}
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <div className="text-center py-8 px-6">
              <UserCircle className="h-12 w-12 text-muted-foreground mx-auto mb-3" />
              <p className="text-sm text-muted-foreground mb-4">
                No clients yet. Create your first API client to get started.
              </p>
              <Button asChild className="text-sm">
                <Link to="/app/clients">Create Client</Link>
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Quick Actions */}
      <Card>
        <CardHeader>
          <CardTitle>Quick Actions</CardTitle>
          <CardDescription>
            Common tasks to get you started
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button asChild color="zinc" className="text-sm">
            <Link to="/app/clients">
              <UserCircle className="mr-2 h-4 w-4" />
              Create Client
            </Link>
          </Button>
          <Button asChild color="zinc" className="text-sm">
            <Link to="/app/marketplace">
              <Store className="mr-2 h-4 w-4" />
              Browse Marketplace
            </Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
