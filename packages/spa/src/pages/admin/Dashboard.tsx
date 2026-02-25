import { Link } from 'react-router-dom';
import { UsersIcon, UserPlusIcon, CubeIcon, BoltIcon, ExclamationTriangleIcon, ArrowPathIcon, ServerStackIcon } from '@heroicons/react/20/solid';
import { Heading } from '@/components/catalyst/heading';
import { Text } from '@/components/catalyst/text';
import { Badge } from '@/components/catalyst/badge';
import { Button } from '@/components/catalyst/button';
import { Table, TableHead, TableBody, TableRow, TableHeader, TableCell } from '@/components/catalyst/table';
import {
  useAdminUsers,
  useAdminGroups,
  useAdminMcps,
  useAdminSessions,
  useAuditEvents,
  useAdminMcpHealth,
  useUserMcpInstances,
  useCatalogStatus,
  useApplyCatalogChanges,
} from '@/api/hooks/use-admin';
import { usePageTitle } from '@/hooks/usePageTitle';

export function Dashboard() {
  usePageTitle('Admin Dashboard');
  const { data: usersData, isLoading: usersLoading } = useAdminUsers();
  const { data: groupsData, isLoading: groupsLoading } = useAdminGroups();
  const { data: mcpsData, isLoading: mcpsLoading } = useAdminMcps();
  const { data: sessionsData, isLoading: sessionsLoading } = useAdminSessions();
  const { data: auditData, isLoading: auditLoading } = useAuditEvents({ limit: 5 });
  const { data: mcpHealth, isLoading: mcpHealthLoading } = useAdminMcpHealth();
  const { data: userMcps, isLoading: userMcpsLoading } = useUserMcpInstances();
  const { data: catalogStatus } = useCatalogStatus();
  const applyCatalogChanges = useApplyCatalogChanges();

  const stats = [
    {
      title: 'Total Users',
      value: usersData?.data.length ?? 0,
      icon: UsersIcon,
      loading: usersLoading,
      href: '/app/admin/users',
    },
    {
      title: 'Total Groups',
      value: groupsData?.data?.length ?? 0,
      icon: UserPlusIcon,
      loading: groupsLoading,
      href: '/app/admin/groups',
    },
    {
      title: 'Total MCPs',
      value: mcpsData?.data.length ?? 0,
      icon: CubeIcon,
      loading: mcpsLoading,
      href: '/app/admin/mcps',
    },
    {
      title: 'Active Sessions',
      value: sessionsData?.data?.length ?? 0,
      icon: BoltIcon,
      loading: sessionsLoading,
      href: '/app/admin/settings',
    },
  ];

  const hasUnhealthyMcps = mcpHealth && mcpHealth.summary.healthy_shared < mcpHealth.summary.total_shared;
  const hasPendingChanges = catalogStatus?.has_changes ?? false;
  const hasSystemIssues = hasUnhealthyMcps || hasPendingChanges;

  // Group user instances by user for display
  const userInstanceCounts = new Map<string, { username: string; instances: number; tools: number; statuses: string[] }>();
  if (userMcps?.instances) {
    userMcps.instances.forEach(inst => {
      const existing = userInstanceCounts.get(inst.user_id) || { username: inst.username, instances: 0, tools: 0, statuses: [] };
      existing.instances += 1;
      existing.tools += inst.tool_count;
      existing.statuses.push(inst.status);
      userInstanceCounts.set(inst.user_id, existing);
    });
  }
  const topUsers = Array.from(userInstanceCounts.entries())
    .map(([userId, data]) => ({
      userId,
      username: data.username,
      instances: data.instances,
      tools: data.tools,
      hasError: data.statuses.includes('error'),
    }))
    .sort((a, b) => b.instances - a.instances)
    .slice(0, 5);

  return (
    <div className="space-y-8">
      {/* Page Header */}
      <div>
        <Heading>Admin Dashboard</Heading>
        <Text>System overview and quick actions</Text>
      </div>

      {/* System Health Alerts Banner */}
      {hasSystemIssues && (
        <div className={`rounded-lg ${hasUnhealthyMcps ? 'bg-red-50 dark:bg-red-500/10 ring-1 ring-red-600/20 dark:ring-red-500/20' : 'bg-amber-50 dark:bg-amber-500/10 ring-1 ring-amber-600/20 dark:ring-amber-500/20'} p-4`}>
          <div className="flex items-center gap-3">
            <ExclamationTriangleIcon className={`size-5 ${hasUnhealthyMcps ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400'}`} />
            <div className="flex-1">
              <p className={`text-sm font-medium ${hasUnhealthyMcps ? 'text-red-800 dark:text-red-300' : 'text-amber-800 dark:text-amber-300'}`}>
                {hasUnhealthyMcps && (
                  <span>
                    {mcpHealth.summary.total_shared - mcpHealth.summary.healthy_shared} unhealthy MCP{mcpHealth.summary.total_shared - mcpHealth.summary.healthy_shared > 1 ? 's' : ''} detected.{' '}
                  </span>
                )}
                {hasPendingChanges && catalogStatus && (
                  <span>
                    {(() => {
                      const total = catalogStatus.shared.to_add.length + catalogStatus.shared.to_update.length + catalogStatus.shared.to_remove.length + catalogStatus.per_user.to_add.length + catalogStatus.per_user.to_update.length + catalogStatus.per_user.to_remove.length;
                      return `${total} pending catalog change${total > 1 ? 's' : ''} require${total === 1 ? 's' : ''} review.`;
                    })()}
                  </span>
                )}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Stats Grid */}
      <dl className="grid grid-cols-1 gap-px overflow-hidden rounded-lg bg-zinc-900/5 dark:bg-white/5 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => {
          const Icon = stat.icon;
          return (
            <div key={stat.title} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 bg-zinc-50 dark:bg-white/5 px-4 py-10 sm:px-6 xl:px-8">
              <dt className="flex items-center gap-x-2 text-sm/6 font-medium text-zinc-500 dark:text-zinc-400">
                <Icon className="size-4" />
                {stat.title}
              </dt>
              <dd className="w-full flex-none text-3xl/10 font-medium tracking-tight text-zinc-900 dark:text-white">
                {stat.loading ? (
                  <div className="animate-pulse h-8 w-20 rounded bg-zinc-200 dark:bg-zinc-700" />
                ) : (
                  stat.value
                )}
              </dd>
              <dd className="w-full flex-none text-sm/6 text-zinc-500 dark:text-zinc-400">
                <Link to={stat.href} className="hover:text-zinc-900 dark:hover:text-white transition-colors">
                  View details →
                </Link>
              </dd>
            </div>
          );
        })}
      </dl>

      {/* MCP Health Overview */}
      <div className="rounded-lg bg-white dark:bg-white/5 ring-1 ring-zinc-950/10 dark:ring-white/10">
        <div className="px-4 py-5 sm:p-6">
          <h3 className="text-base font-semibold text-zinc-900 dark:text-white">MCP Health Overview</h3>
          <div className="mt-2 max-w-xl text-sm text-zinc-500 dark:text-zinc-400">
            <p>Real-time connection status and performance metrics</p>
          </div>

          {mcpHealthLoading ? (
            <div className="mt-5 space-y-3">
              <div className="animate-pulse h-6 w-full rounded bg-zinc-200 dark:bg-zinc-700" />
              <div className="animate-pulse h-6 w-full rounded bg-zinc-200 dark:bg-zinc-700" />
              <div className="animate-pulse h-6 w-full rounded bg-zinc-200 dark:bg-zinc-700" />
            </div>
          ) : mcpHealth && mcpHealth.shared.length > 0 ? (
            <>
              {/* Shared MCPs Section */}
              <div className="mt-5">
                <h4 className="text-sm font-medium text-zinc-900 dark:text-white mb-3">Shared MCPs</h4>
                <div className="space-y-2">
                  {mcpHealth.shared.map((mcp) => {
                    const mcpEntry = mcpsData?.data.find(m => m.name === mcp.name);
                    const uptime = mcp.detail.uptime_ms ? Math.floor(mcp.detail.uptime_ms / 1000 / 60) : null;
                    const truncatedError = mcp.last_error ? (mcp.last_error.length > 60 ? mcp.last_error.substring(0, 60) + '...' : mcp.last_error) : null;

                    return (
                      <div key={mcp.name} className="flex items-center justify-between py-2 border-b border-zinc-950/5 dark:border-white/10 last:border-0">
                        <div className="flex items-center gap-3 flex-1 min-w-0">
                          <span className={`inline-block h-2.5 w-2.5 rounded-full flex-shrink-0 ${mcp.connected ? 'bg-green-500' : 'bg-red-500'}`} />
                          {mcpEntry ? (
                            <Link
                              to={`/app/admin/mcps/${mcpEntry.mcp_id}`}
                              className="text-sm font-medium text-zinc-900 dark:text-white hover:text-blue-600 dark:hover:text-blue-400 transition-colors truncate"
                            >
                              {mcp.name}
                            </Link>
                          ) : (
                            <span className="text-sm font-medium text-zinc-900 dark:text-white truncate">{mcp.name}</span>
                          )}
                          <Badge color={mcp.transport === 'stdio' ? 'blue' : 'purple'}>{mcp.transport}</Badge>
                          <span className="text-sm text-zinc-500 dark:text-zinc-400">{mcp.detail.toolCount ?? 0} tools</span>
                          {uptime !== null && (
                            <span className="text-sm text-zinc-500 dark:text-zinc-400">{uptime}m uptime</span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          {mcp.error_count > 0 && (
                            <Badge color="red" title={truncatedError ?? undefined}>{mcp.error_count} error{mcp.error_count > 1 ? 's' : ''}</Badge>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Per-User MCPs Section */}
              {userMcps && userMcps.instances.length > 0 && (
                <div className="mt-6 pt-5 border-t border-zinc-950/5 dark:border-white/10">
                  <h4 className="text-sm font-medium text-zinc-900 dark:text-white mb-3">Per-User MCPs</h4>
                  <div className="space-y-2">
                    {(() => {
                      // Group user instances by MCP name
                      const mcpGroups = new Map<string, { instances: number; users: Set<string>; tools: number; errors: number }>();
                      userMcps.instances.forEach(inst => {
                        const group = mcpGroups.get(inst.mcp_name) || { instances: 0, users: new Set<string>(), tools: 0, errors: 0 };
                        group.instances += 1;
                        group.users.add(inst.user_id);
                        group.tools += inst.tool_count;
                        if (inst.status === 'error') group.errors += 1;
                        mcpGroups.set(inst.mcp_name, group);
                      });
                      return Array.from(mcpGroups.entries()).map(([mcpName, group]) => {
                        const mcpEntry = mcpsData?.data.find(m => m.name === mcpName);
                        return (
                          <div key={mcpName} className="flex items-center justify-between py-2 border-b border-zinc-950/5 dark:border-white/10 last:border-0">
                            <div className="flex items-center gap-3">
                              <ServerStackIcon className="size-4 text-zinc-400" />
                              {mcpEntry ? (
                                <Link
                                  to={`/app/admin/mcps/${mcpEntry.mcp_id}`}
                                  className="text-sm font-medium text-zinc-900 dark:text-white hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                                >
                                  {mcpName}
                                </Link>
                              ) : (
                                <span className="text-sm font-medium text-zinc-900 dark:text-white">{mcpName}</span>
                              )}
                              <span className="text-sm text-zinc-500 dark:text-zinc-400">
                                {group.instances} instance{group.instances > 1 ? 's' : ''} across {group.users.size} user{group.users.size > 1 ? 's' : ''}
                              </span>
                            </div>
                            <div className="flex items-center gap-2">
                              {group.errors > 0 && (
                                <Badge color="red">{group.errors} error{group.errors > 1 ? 's' : ''}</Badge>
                              )}
                              <span className="text-sm text-zinc-500 dark:text-zinc-400">{group.tools} tools</span>
                            </div>
                          </div>
                        );
                      });
                    })()}
                  </div>
                </div>
              )}
            </>
          ) : (
            <p className="mt-5 text-sm text-zinc-500 dark:text-zinc-400">No MCP health data available</p>
          )}
        </div>
      </div>

      {/* Per-User Instance Summary */}
      {userMcps && (
        <div className="rounded-lg bg-white dark:bg-white/5 ring-1 ring-zinc-950/10 dark:ring-white/10">
          <div className="px-4 py-5 sm:p-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-base font-semibold text-zinc-900 dark:text-white">Per-User Instance Summary</h3>
                <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">Active user MCP instances</p>
              </div>
              <Link
                to="/app/admin/user-instances"
                className="text-sm font-medium text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300 transition-colors"
              >
                View All →
              </Link>
            </div>

            {/* Stats Row */}
            <div className="grid grid-cols-3 gap-4 mb-5">
              <div className="text-center">
                <div className="text-2xl font-semibold text-zinc-900 dark:text-white">
                  {userMcpsLoading ? (
                    <div className="animate-pulse h-8 w-16 mx-auto rounded bg-zinc-200 dark:bg-zinc-700" />
                  ) : (
                    userMcps.summary.total_instances
                  )}
                </div>
                <div className="text-sm text-zinc-500 dark:text-zinc-400">Total Instances</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-semibold text-zinc-900 dark:text-white">
                  {userMcpsLoading ? (
                    <div className="animate-pulse h-8 w-16 mx-auto rounded bg-zinc-200 dark:bg-zinc-700" />
                  ) : (
                    <span>
                      {userMcps.summary.active_users} <span className="text-base text-zinc-500">of {userMcps.summary.total_users}</span>
                    </span>
                  )}
                </div>
                <div className="text-sm text-zinc-500 dark:text-zinc-400">Active Users</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-semibold text-zinc-900 dark:text-white">
                  {userMcpsLoading ? (
                    <div className="animate-pulse h-8 w-16 mx-auto rounded bg-zinc-200 dark:bg-zinc-700" />
                  ) : (
                    <span>
                      <span className="text-green-600 dark:text-green-400">{userMcps.summary.healthy_instances}</span>
                      {' / '}
                      <span className="text-red-600 dark:text-red-400">{userMcps.summary.unhealthy_instances}</span>
                    </span>
                  )}
                </div>
                <div className="text-sm text-zinc-500 dark:text-zinc-400">Healthy / Unhealthy</div>
              </div>
            </div>

            {/* Top Users Mini Table */}
            {topUsers.length > 0 && (
              <div className="border-t border-zinc-950/5 dark:border-white/10 pt-4">
                <h4 className="text-sm font-medium text-zinc-900 dark:text-white mb-3">Top Users by Instance Count</h4>
                <div className="space-y-2">
                  {topUsers.map((user) => (
                    <div key={user.userId} className="flex items-center justify-between py-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-zinc-900 dark:text-white">{user.username}</span>
                        {user.hasError && (
                          <span className="inline-block h-2 w-2 rounded-full bg-red-500" title="Has errors" />
                        )}
                      </div>
                      <div className="flex items-center gap-4 text-sm text-zinc-500 dark:text-zinc-400">
                        <span>{user.instances} MCP{user.instances > 1 ? 's' : ''}</span>
                        <span>{user.tools} tools</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Pending Changes Card */}
      {hasPendingChanges && catalogStatus && (
        <div className="rounded-lg bg-amber-50 dark:bg-amber-500/10 ring-1 ring-amber-600/20 dark:ring-amber-500/20">
          <div className="px-4 py-5 sm:p-6">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-base font-semibold text-amber-900 dark:text-amber-300">Pending Catalog Changes</h3>
                <p className="mt-2 text-sm text-amber-800 dark:text-amber-400">
                  {(() => {
                    const addCount = catalogStatus.shared.to_add.length + catalogStatus.per_user.to_add.length;
                    const updateCount = catalogStatus.shared.to_update.length + catalogStatus.per_user.to_update.length;
                    const removeCount = catalogStatus.shared.to_remove.length + catalogStatus.per_user.to_remove.length;
                    const totalChanges = addCount + updateCount + removeCount;
                    return (
                      <>
                        {totalChanges} pending change{totalChanges > 1 ? 's' : ''}:{' '}
                        {addCount > 0 && `${addCount} to add`}
                        {addCount > 0 && updateCount > 0 && ', '}
                        {updateCount > 0 && `${updateCount} to update`}
                        {(addCount > 0 || updateCount > 0) && removeCount > 0 && ', '}
                        {removeCount > 0 && `${removeCount} to remove`}
                      </>
                    );
                  })()}
                </p>
              </div>
              <div className="flex gap-2 ml-4">
                <Button outline disabled title="Preview is not yet available">
                  Preview
                </Button>
                <Button
                  onClick={() => applyCatalogChanges.mutate()}
                  disabled={applyCatalogChanges.isPending}
                >
                  {applyCatalogChanges.isPending ? (
                    <>
                      <ArrowPathIcon className="animate-spin" data-slot="icon" />
                      Applying...
                    </>
                  ) : (
                    'Apply Changes'
                  )}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Recent Audit Events */}
      <div className="rounded-lg bg-white dark:bg-white/5 ring-1 ring-zinc-950/10 dark:ring-white/10">
        <div className="px-4 py-5 sm:p-6 border-b border-zinc-950/5 dark:border-white/10 flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold text-zinc-900 dark:text-white">Recent Audit Events</h3>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">Last 5 system events</p>
          </div>
          <Button outline href="/app/admin/audit">
            View All
          </Button>
        </div>
        {auditLoading ? (
          <div className="px-4 py-5 sm:p-6 space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="animate-pulse h-10 w-full rounded bg-zinc-200 dark:bg-zinc-700" />
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
            <p className="text-sm text-zinc-500 dark:text-zinc-400">No recent audit events</p>
          </div>
        )}
      </div>

      {/* Quick Actions */}
      <div className="rounded-lg bg-white dark:bg-white/5 ring-1 ring-zinc-950/10 dark:ring-white/10">
        <div className="px-4 py-5 sm:p-6">
          <h3 className="text-base font-semibold text-zinc-900 dark:text-white mb-4">Quick Actions</h3>
          <div className="flex flex-wrap gap-3">
            <Button outline href="/app/admin/users">
              <UsersIcon data-slot="icon" />
              Manage Users
            </Button>
            <Button outline href="/app/admin/groups">
              <UserPlusIcon data-slot="icon" />
              Manage Groups
            </Button>
            <Button outline href="/app/admin/mcps/new">
              <CubeIcon data-slot="icon" />
              Create MCP
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
