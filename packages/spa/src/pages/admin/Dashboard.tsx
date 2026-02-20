import { Link } from 'react-router-dom';
import { Users, UserPlus, Package, Activity, Server } from 'lucide-react';
import { Heading } from '@/components/catalyst/heading';
import { Text } from '@/components/catalyst/text';
import { Badge } from '@/components/catalyst/badge';
import { Button } from '@/components/catalyst/button';
import { Table, TableHead, TableBody, TableRow, TableHeader, TableCell } from '@/components/catalyst/table';
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
      value: sessionsData?.data?.length ?? 0,
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
    <div className="space-y-8">
      {/* Page Header */}
      <div>
        <Heading>Admin Dashboard</Heading>
        <Text>System overview and quick actions</Text>
      </div>

      {/* Stats Grid */}
      <dl className="grid grid-cols-1 gap-px overflow-hidden rounded-lg bg-zinc-900/5 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => {
          const Icon = stat.icon;
          return (
            <div key={stat.title} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 bg-white px-4 py-10 sm:px-6 xl:px-8">
              <dt className="flex items-center gap-x-2 text-sm/6 font-medium text-zinc-500">
                <Icon className="h-4 w-4" />
                {stat.title}
              </dt>
              <dd className="w-full flex-none text-3xl/10 font-medium tracking-tight text-zinc-900">
                {stat.loading ? (
                  <div className="animate-pulse h-8 w-20 rounded bg-zinc-200" />
                ) : (
                  stat.value
                )}
              </dd>
              <dd className="w-full flex-none text-sm/6 text-zinc-500">
                <Link to={stat.href} className="hover:text-zinc-900 transition-colors">
                  View details →
                </Link>
              </dd>
            </div>
          );
        })}
      </dl>

      {/* MCP Status & Downstream Health */}
      <div className="grid gap-6 md:grid-cols-2">
        {/* MCP Status Panel */}
        <div className="rounded-lg bg-white ring-1 ring-zinc-950/5">
          <div className="px-4 py-5 sm:p-6">
            <h3 className="text-base font-semibold text-zinc-900">MCP Status</h3>
            <div className="mt-2 max-w-xl text-sm text-zinc-500">
              <p>Catalog entries by status</p>
            </div>
            <div className="mt-5 space-y-3">
              {mcpsLoading ? (
                <>
                  <div className="animate-pulse h-6 w-full rounded bg-zinc-200" />
                  <div className="animate-pulse h-6 w-full rounded bg-zinc-200" />
                  <div className="animate-pulse h-6 w-full rounded bg-zinc-200" />
                </>
              ) : (
                <>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-zinc-900">Draft</span>
                    <Badge color="zinc">{mcpsByStatus.draft}</Badge>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-zinc-900">Published</span>
                    <Badge color="green">{mcpsByStatus.published}</Badge>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-zinc-900">Archived</span>
                    <Badge color="zinc">{mcpsByStatus.archived}</Badge>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Downstream Health Panel */}
        <div className="rounded-lg bg-white ring-1 ring-zinc-950/5">
          <div className="px-4 py-5 sm:p-6">
            <h3 className="text-base font-semibold text-zinc-900">Downstream Health</h3>
            <div className="mt-2 max-w-xl text-sm text-zinc-500">
              <p>MCP connection status</p>
            </div>
            <div className="mt-5 space-y-3">
              {downstreamLoading ? (
                <>
                  <div className="animate-pulse h-6 w-full rounded bg-zinc-200" />
                  <div className="animate-pulse h-6 w-full rounded bg-zinc-200" />
                </>
              ) : downstream ? (
                <>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-zinc-900 flex items-center gap-2">
                      <Server className="h-4 w-4" />
                      Healthy Connections
                    </span>
                    <Badge color={downstream.healthy_connections === downstream.total_connections ? 'green' : 'red'}>
                      {downstream.healthy_connections}/{downstream.total_connections}
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-zinc-900">Total Tools Available</span>
                    <Badge color="zinc">{downstream.total_tools}</Badge>
                  </div>
                  {downstream.connections.length > 0 && (
                    <div className="pt-3 space-y-2 border-t border-zinc-950/5">
                      {downstream.connections.map(conn => (
                        <div key={conn.name} className="flex items-center justify-between">
                          <span className="text-sm font-mono text-zinc-700">{conn.name}</span>
                          <div className="flex items-center gap-2">
                            <Badge color={conn.status === 'healthy' ? 'green' : 'red'}>
                              {conn.status}
                            </Badge>
                            <span className="text-sm text-zinc-500">{conn.tools} tools</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <p className="text-sm text-zinc-500">No downstream data available</p>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Recent Audit Events */}
      <div className="rounded-lg bg-white ring-1 ring-zinc-950/5">
        <div className="px-4 py-5 sm:px-6 border-b border-zinc-950/5 flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold text-zinc-900">Recent Audit Events</h3>
            <p className="mt-1 text-sm text-zinc-500">Last 10 system events</p>
          </div>
          <Button outline href="/app/admin/audit">
            View All
          </Button>
        </div>
        {auditLoading ? (
          <div className="px-4 py-5 sm:p-6 space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="animate-pulse h-10 w-full rounded bg-zinc-200" />
            ))}
          </div>
        ) : auditData && auditData.data.length > 0 ? (
          <Table>
            <TableHead>
              <TableRow>
                <TableHeader>Severity</TableHeader>
                <TableHeader>Action</TableHeader>
                <TableHeader>Type</TableHeader>
                <TableHeader>User</TableHeader>
                <TableHeader>Time</TableHeader>
              </TableRow>
            </TableHead>
            <TableBody>
              {auditData.data.map(event => (
                <TableRow key={event.event_id}>
                  <TableCell>
                    <Badge color={
                      event.severity === 'error' ? 'red' :
                      event.severity === 'warn' ? 'amber' : 'zinc'
                    }>
                      {event.severity}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-medium">{event.action}</TableCell>
                  <TableCell className="text-zinc-500">{event.event_type}</TableCell>
                  <TableCell className="text-zinc-500">{event.user_id || '—'}</TableCell>
                  <TableCell className="text-zinc-500">
                    {new Date(event.timestamp).toLocaleString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <div className="px-4 py-5 sm:p-6">
            <p className="text-sm text-zinc-500">No recent audit events</p>
          </div>
        )}
      </div>

      {/* Quick Actions */}
      <div className="rounded-lg bg-white ring-1 ring-zinc-950/5">
        <div className="px-4 py-5 sm:p-6">
          <h3 className="text-base font-semibold text-zinc-900">Quick Actions</h3>
          <div className="mt-2 max-w-xl text-sm text-zinc-500">
            <p>Common administrative tasks</p>
          </div>
          <div className="mt-5 flex flex-wrap gap-3">
            <Button outline href="/app/admin/users">
              <Users data-slot="icon" />
              Manage Users
            </Button>
            <Button outline href="/app/admin/groups">
              <UserPlus data-slot="icon" />
              Manage Groups
            </Button>
            <Button outline href="/app/admin/mcps/new">
              <Package data-slot="icon" />
              Create MCP
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
