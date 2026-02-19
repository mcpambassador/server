import { Link } from 'react-router-dom';
import { Store, UserCircle, Activity } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
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
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-muted-foreground">
          Welcome to MCP Ambassador
        </p>
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
        <CardContent>
          {clientsLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : clients && clients.length > 0 ? (
            <div className="space-y-2">
              {clients.slice(0, 5).map((client) => (
                <Link
                  key={client.id}
                  to={`/app/clients/${client.id}`}
                  className="flex items-center justify-between rounded-lg border p-3 hover:bg-accent transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <UserCircle className="h-8 w-8 text-muted-foreground" />
                    <div>
                      <p className="font-medium">{client.clientName}</p>
                      <p className="text-sm text-muted-foreground">{client.keyPrefix}</p>
                    </div>
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {new Date(client.createdAt).toLocaleDateString()}
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <div className="text-center py-6">
              <p className="text-sm text-muted-foreground mb-4">
                No clients yet. Create your first API client to get started.
              </p>
              <Button asChild>
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
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Button asChild variant="outline" className="h-auto flex-col items-start p-4">
            <Link to="/app/clients">
              <UserCircle className="h-8 w-8 mb-2" />
              <div className="text-left">
                <div className="font-semibold">Create Client</div>
                <div className="text-sm text-muted-foreground">
                  Generate a new API key
                </div>
              </div>
            </Link>
          </Button>
          <Button asChild variant="outline" className="h-auto flex-col items-start p-4">
            <Link to="/app/marketplace">
              <Store className="h-8 w-8 mb-2" />
              <div className="text-left">
                <div className="font-semibold">Browse Marketplace</div>
                <div className="text-sm text-muted-foreground">
                  Discover available MCPs
                </div>
              </div>
            </Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
