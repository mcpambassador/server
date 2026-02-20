import { Link } from 'react-router-dom';
import { Users, UserPlus, Package, Activity, Server, AlertTriangle } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/catalyst/card';
import { Button } from '@/components/catalyst/button';
import { Badge } from '@/components/catalyst/badge';
import { Skeleton } from '@/components/catalyst/skeleton';
import { useAdminUsers, useAdminGroups, useAdminMcps, useAdminSessions, useAuditEvents, useDownstream } from '@/api/hooks/use-admin';
import { usePageTitle } from '@/hooks/usePageTitle';

export function Dashboard() {
  usePageTitle('Admin Dashboard');
  const { data: usersData, isLoading: usersLoading } = useAdminUsers();
  const { data: groupsData, isLoading: groupsLoading } = useAdminGroups();
  const { data: mcpsData, isLoading: mcpsLoading } = useAdminMcps();
  const { data: sessionsData, isLoading: sessionsLoading } = useAdminSessions();
  const { data: auditData, isLoading: auditLoading } = useAuditEvents({ limit: 10 });
  const { data: downstream, isLoading: downstreamLoading } = useDownstream();

  const stats = [
    {
      title: 'Total Users',
      value: usersData?.data.length ?? 0,
      icon: Users,
      loading: usersLoading,
      href: '/app/admin/users',
    },
    {
      title: 'Total Groups',
      value: groupsData?.data?.length ?? 0,
      icon: UserPlus,
      loading: groupsLoading,
      href: '/app/admin/groups',
    },
    {
      title: 'Total MCPs',
      value: mcpsData?.data.length ?? 0,
      icon: Package,
      loading: mcpsLoading,
      href: '/app/admin/mcps',
    },
    {
      title: 'Active Sessions',
      value: Array.isArray(sessionsData) ? sessionsData.length : 0,
      icon: Activity,
      loading: sessionsLoading,
      href: '/app/admin/settings',
    },
  ];

  const mcpsByStatus = {
    draft: mcpsData?.data.filter(m => m.status === 'draft').length ?? 0,
    published: mcpsData?.data.filter(m => m.status === 'published').length ?? 0,
    archived: mcpsData?.data.filter(m => m.status === 'archived').length ?? 0,
  };

  return (
    <div className="space-y-6">
      <div className="pb-4 border-b border-border mb-6">
        <h1 className="text-xl font-semibold">Admin Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          System overview and quick actions
        </p>
      </div>

      {/* Stats Grid */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {stats.map(stat => {
          const Icon = stat.icon;
          return (
            <Card key={stat.title} className="p-4">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs text-muted-foreground">
                  {stat.title}
                </p>
                <Icon className="h-4 w-4 text-muted-foreground" />
              </div>
              {stat.loading ? (
                <Skeleton className="h-8 w-20" />
              ) : (
                <div className="text-2xl font-bold">{stat.value}</div>
              )}
              <Link to={stat.href} className="text-xs text-muted-foreground hover:underline">
                View details →
              </Link>
            </Card>
          );
        })}
      </div>

      {/* MCP Status & Downstream Health */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card className="p-4">
          <div className="mb-4">
            <h3 className="font-semibold">MCP Status</h3>
            <p className="text-xs text-muted-foreground">Catalog entries by status</p>
          </div>
          <div className="space-y-3">
            {mcpsLoading ? (
              <>
                <Skeleton className="h-6 w-full" />
                <Skeleton className="h-6 w-full" />
                <Skeleton className="h-6 w-full" />
              </>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-sm">Draft</span>
                  <Badge color="zinc">{mcpsByStatus.draft}</Badge>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm">Published</span>
                  <Badge color="teal">{mcpsByStatus.published}</Badge>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm">Archived</span>
                  <Badge color="zinc">{mcpsByStatus.archived}</Badge>
                </div>
              </>
            )}
          </div>
        </Card>

        <Card className="p-4">
          <div className="mb-4">
            <h3 className="font-semibold">Downstream Health</h3>
            <p className="text-xs text-muted-foreground">MCP connection status</p>
          </div>
          <div className="space-y-3">
            {downstreamLoading ? (
              <>
                <Skeleton className="h-6 w-full" />
                <Skeleton className="h-6 w-full" />
              </>
            ) : downstream ? (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-sm flex items-center gap-2">
                    <Server className="h-4 w-4" />
                    Healthy Connections
                  </span>
                  <Badge color={downstream.healthy_connections === downstream.total_connections ? 'teal' : 'red'}>
                    {downstream.healthy_connections}/{downstream.total_connections}
                  </Badge>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm">Total Tools Available</span>
                  <Badge color="zinc">{downstream.total_tools}</Badge>
                </div>
                {downstream.connections.length > 0 && (
                  <div className="pt-2 space-y-2 border-t">
                    {downstream.connections.map(conn => (
                      <div key={conn.name} className="flex items-center justify-between text-xs">
                        <span className="font-mono">{conn.name}</span>
                        <div className="flex items-center gap-2">
                          <Badge color={conn.status === 'healthy' ? 'teal' : 'red'} className="text-xs">
                            {conn.status}
                          </Badge>
                          <span className="text-muted-foreground">{conn.tools} tools</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">No downstream data available</p>
            )}
          </div>
        </Card>
      </div>

      {/* Recent Audit Events */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Recent Audit Events</CardTitle>
              <CardDescription>Last 10 system events</CardDescription>
            </div>
            <Button color="zinc" className="h-8" href="/app/admin/audit">View All</Button>
          </div>
        </CardHeader>
        <CardContent>
          {auditLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : auditData && auditData.data.length > 0 ? (
            <div className="space-y-2">
              {auditData.data.map(event => (
                <div
                  key={event.event_id}
                  className="flex items-center justify-between border-b pb-2 last:border-0"
                >
                  <div className="flex items-center gap-3">
                    {event.severity === 'error' && <AlertTriangle className="h-4 w-4 text-destructive" />}
                    {event.severity === 'warn' && <AlertTriangle className="h-4 w-4 text-yellow-500" />}
                    {event.severity === 'info' && <Activity className="h-4 w-4 text-muted-foreground" />}
                    <div>
                      <p className="text-sm font-medium">{event.action}</p>
                      <p className="text-xs text-muted-foreground">
                        {event.event_type} {event.user_id && `• User: ${event.user_id}`}
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    <Badge color={
                      event.severity === 'error' ? 'red' :
                      event.severity === 'warn' ? 'zinc' : 'zinc'
                    }>
                      {event.severity}
                    </Badge>
                    <p className="text-xs text-muted-foreground mt-1">
                      {new Date(event.timestamp).toLocaleString()}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No recent audit events</p>
          )}
        </CardContent>
      </Card>

      {/* Quick Actions */}
      <Card>
        <CardHeader>
          <CardTitle>Quick Actions</CardTitle>
          <CardDescription>Common administrative tasks</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          <Button color="zinc" className="h-8" href="/app/admin/users">
            <Users className="mr-2 h-4 w-4" />
            Manage Users
          </Button>
          <Button color="zinc" href="/app/admin/groups">
            <UserPlus className="mr-2 h-4 w-4" />
            Manage Groups
          </Button>
          <Button color="zinc" className="h-8" href="/app/admin/mcps/new">
            <Package className="mr-2 h-4 w-4" />
            Create MCP
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
