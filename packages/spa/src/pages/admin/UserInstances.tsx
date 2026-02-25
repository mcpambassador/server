import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  ServerStackIcon,
  UsersIcon,
  WrenchScrewdriverIcon,
  ArrowPathIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/20/solid';
import { toast } from 'sonner';
import { Heading } from '@/components/catalyst/heading';
import { Text } from '@/components/catalyst/text';
import { Badge } from '@/components/catalyst/badge';
import { Button } from '@/components/catalyst/button';
import { Listbox, ListboxOption, ListboxLabel } from '@/components/catalyst/listbox';
import { Table, TableHead, TableBody, TableRow, TableHeader, TableCell } from '@/components/catalyst/table';
import { Input } from '@/components/catalyst/input';
import { useUserMcpInstances, useRestartUserMcp } from '@/api/hooks/use-admin';
import type { UserMcpInstance } from '@/api/types';
import { usePageTitle } from '@/hooks/usePageTitle';

function formatUptime(ms: number): string {
  if (ms <= 0) return '—';
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatRelativeTime(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  return formatUptime(diff) + ' ago';
}

export function UserInstances() {
  usePageTitle('Admin - User Instances');
  const { data: userMcps, isLoading } = useUserMcpInstances();
  const restartUserMcp = useRestartUserMcp();

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [mcpFilter, setMcpFilter] = useState<string>('all');
  const [expandedRow, setExpandedRow] = useState<string | null>(null);

  const instances = userMcps?.instances ?? [];
  const summary = userMcps?.summary;

  // Derive unique MCP names for filter
  const mcpNames = useMemo(() => {
    const names = new Set(instances.map(i => i.mcp_name));
    return [...names].sort();
  }, [instances]);

  // Apply client-side filters
  const filtered = useMemo(() => {
    let result = instances;
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(i =>
        i.username.toLowerCase().includes(q) || i.mcp_name.toLowerCase().includes(q)
      );
    }
    if (statusFilter === 'healthy') {
      result = result.filter(i => i.status === 'connected');
    } else if (statusFilter === 'unhealthy') {
      result = result.filter(i => i.status !== 'connected');
    }
    if (mcpFilter !== 'all') {
      result = result.filter(i => i.mcp_name === mcpFilter);
    }
    return result;
  }, [instances, search, statusFilter, mcpFilter]);

  const handleRestart = async (inst: UserMcpInstance) => {
    try {
      await restartUserMcp.mutateAsync({ userId: inst.user_id, mcpName: inst.mcp_name });
      toast.success(`Restarted ${inst.mcp_name} for ${inst.username}`);
    } catch (error) {
      toast.error('Restart failed', { description: (error as Error)?.message ?? String(error) });
    }
  };

  const isHealthy = (inst: UserMcpInstance) =>
    inst.status === 'connected';
  
  const rowKey = (inst: UserMcpInstance) => `${inst.user_id}-${inst.mcp_name}`;

  const toggleRow = (key: string) => {
    setExpandedRow(expandedRow === key ? null : key);
  };

  if (isLoading) {
    return (
      <div className="space-y-8">
        <div>
          <Heading>User MCP Instances</Heading>
          <Text>Active per-user MCP process instances across all users</Text>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {[1, 2, 3].map(i => (
            <div key={i} className="rounded-lg bg-white dark:bg-white/5 ring-1 ring-zinc-950/10 dark:ring-white/10 p-6 animate-pulse">
              <div className="h-4 bg-zinc-200 dark:bg-zinc-700 rounded w-1/2 mb-2" />
              <div className="h-8 bg-zinc-200 dark:bg-zinc-700 rounded w-1/3" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Page Header */}
      <div>
        <Heading>User MCP Instances</Heading>
        <Text>Active per-user MCP process instances across all users</Text>
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Total Active Instances */}
        <div className="rounded-lg bg-white dark:bg-white/5 ring-1 ring-zinc-950/10 dark:ring-white/10 p-6">
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-blue-500/10">
              <ServerStackIcon className="h-6 w-6 text-blue-500" />
            </div>
            <div>
              <Text className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Total Active Instances</Text>
              <div className="text-2xl font-semibold text-zinc-900 dark:text-white">
                {summary?.total_instances ?? 0}
              </div>
            </div>
          </div>
        </div>

        {/* Active Users */}
        <div className="rounded-lg bg-white dark:bg-white/5 ring-1 ring-zinc-950/10 dark:ring-white/10 p-6">
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-green-500/10">
              <UsersIcon className="h-6 w-6 text-green-500" />
            </div>
            <div>
              <Text className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Active Users</Text>
              <div className="text-2xl font-semibold text-zinc-900 dark:text-white">
                {summary?.active_users ?? 0}
              </div>
            </div>
          </div>
        </div>

        {/* Total Tools Served */}
        <div className="rounded-lg bg-white dark:bg-white/5 ring-1 ring-zinc-950/10 dark:ring-white/10 p-6">
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-purple-500/10">
              <WrenchScrewdriverIcon className="h-6 w-6 text-purple-500" />
            </div>
            <div>
              <Text className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Total Tools Served</Text>
              <div className="text-2xl font-semibold text-zinc-900 dark:text-white">
                {summary?.total_tools_served ?? 0}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Health Alert */}
      {summary && summary.unhealthy_instances > 0 && (
        <div className="rounded-lg bg-red-50 dark:bg-red-500/10 ring-1 ring-red-600/20 dark:ring-red-500/20 p-4">
          <div className="flex items-start gap-3">
            <ExclamationTriangleIcon className="h-5 w-5 text-red-600 dark:text-red-400 mt-0.5 flex-shrink-0" />
            <div className="flex-1">
              <div className="text-sm font-medium text-red-900 dark:text-red-200">
                {summary.unhealthy_instances} unhealthy instance{summary.unhealthy_instances !== 1 ? 's' : ''} detected
              </div>
              <div className="mt-1 text-sm text-red-700 dark:text-red-300">
                Some user MCP instances are experiencing errors or connectivity issues. Review the table below for details.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Filters Section */}
      <div className="rounded-lg bg-white dark:bg-white/5 ring-1 ring-zinc-950/10 dark:ring-white/10 p-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Search Input */}
          <div>
            <label htmlFor="search" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-2">
              Search
            </label>
            <Input
              id="search"
              type="text"
              placeholder="Search by username or MCP name..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          {/* Status Filter */}
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-2">
              Status
            </label>
            <Listbox value={statusFilter} onChange={setStatusFilter}>
              <ListboxOption value="all">
                <ListboxLabel>All Statuses</ListboxLabel>
              </ListboxOption>
              <ListboxOption value="healthy">
                <ListboxLabel>Healthy</ListboxLabel>
              </ListboxOption>
              <ListboxOption value="unhealthy">
                <ListboxLabel>Unhealthy</ListboxLabel>
              </ListboxOption>
            </Listbox>
          </div>

          {/* MCP Filter */}
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-2">
              MCP
            </label>
            <Listbox value={mcpFilter} onChange={setMcpFilter}>
              <ListboxOption value="all">
                <ListboxLabel>All MCPs</ListboxLabel>
              </ListboxOption>
              {mcpNames.map(name => (
                <ListboxOption key={name} value={name}>
                  <ListboxLabel>{name}</ListboxLabel>
                </ListboxOption>
              ))}
            </Listbox>
          </div>
        </div>
      </div>

      {/* Table Section */}
      <div className="rounded-lg bg-white dark:bg-white/5 ring-1 ring-zinc-950/10 dark:ring-white/10 overflow-hidden">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 px-4">
            <ServerStackIcon className="h-12 w-12 text-zinc-400 dark:text-zinc-600 mb-4" />
            <Text className="text-center text-zinc-500 dark:text-zinc-400 mb-1 font-medium">
              No instances found
            </Text>
            <Text className="text-center text-sm text-zinc-400 dark:text-zinc-500">
              {instances.length === 0
                ? 'No user MCP instances are currently active.'
                : 'Try adjusting your filters to see results.'}
            </Text>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeader>User</TableHeader>
                  <TableHeader>MCP Name</TableHeader>
                  <TableHeader>Status</TableHeader>
                  <TableHeader className="text-right">Tools</TableHeader>
                  <TableHeader>Spawned</TableHeader>
                  <TableHeader>Uptime</TableHeader>
                  <TableHeader>Last Error</TableHeader>
                  <TableHeader>Actions</TableHeader>
                </TableRow>
              </TableHead>
              <TableBody>
                {filtered.map(inst => {
                  const key = rowKey(inst);
                  const isExpanded = expandedRow === key;
                  const healthy = isHealthy(inst);

                  return (
                    <>
                      <TableRow
                        key={key}
                        className={!healthy ? 'bg-red-50/50 dark:bg-red-900/10' : undefined}
                      >
                        <TableCell>
                          <Link
                            to={`/app/admin/users/${inst.user_id}`}
                            className="font-medium text-blue-600 dark:text-blue-400 hover:underline"
                          >
                            {inst.username}
                          </Link>
                        </TableCell>
                        <TableCell>
                          <span className="font-mono text-sm">{inst.mcp_name}</span>
                        </TableCell>
                        <TableCell>
                          <Badge color={healthy ? 'green' : 'red'}>
                            {inst.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">{inst.tool_count}</TableCell>
                        <TableCell className="text-sm text-zinc-600 dark:text-zinc-400">
                          {inst.spawned_at ? formatRelativeTime(inst.spawned_at) : '—'}
                        </TableCell>
                        <TableCell className="text-sm text-zinc-600 dark:text-zinc-400">
                          {inst.uptime_ms !== null ? formatUptime(inst.uptime_ms) : '—'}
                        </TableCell>
                        <TableCell>
                          {inst.last_error ? (
                            <span
                              className="text-sm text-red-600 dark:text-red-400 truncate max-w-xs block"
                              title={inst.last_error}
                            >
                              {inst.last_error}
                            </span>
                          ) : (
                            <span className="text-zinc-400 dark:text-zinc-600">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Button
                              color="zinc"
                              onClick={() => handleRestart(inst)}
                              disabled={restartUserMcp.isPending}
                            >
                              <ArrowPathIcon className="h-4 w-4" />
                              Restart
                            </Button>
                            <Button
                              color="zinc"
                              onClick={() => toggleRow(key)}
                            >
                              {isExpanded ? (
                                <ChevronUpIcon className="h-4 w-4" />
                              ) : (
                                <ChevronDownIcon className="h-4 w-4" />
                              )}
                              Logs
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>

                      {isExpanded && (
                        <TableRow key={`${key}-detail`}>
                          <TableCell colSpan={8} className="bg-zinc-50 dark:bg-zinc-900/50">
                            <div className="py-4 space-y-4">
                              <div>
                                <div className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-2">
                                  Instance Details
                                </div>
                                <div className="grid grid-cols-2 gap-4 text-sm">
                                  <div>
                                    <span className="text-zinc-500 dark:text-zinc-400">User ID:</span>{' '}
                                    <span className="font-mono text-zinc-900 dark:text-zinc-100">{inst.user_id}</span>
                                  </div>
                                  <div>
                                    <span className="text-zinc-500 dark:text-zinc-400">Error Count:</span>{' '}
                                    <span className="font-mono text-zinc-900 dark:text-zinc-100">{inst.error_count}</span>
                                  </div>
                                </div>
                              </div>

                              {inst.last_error && (
                                <div>
                                  <div className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-2">
                                    Last Error
                                  </div>
                                  <div className="rounded-lg bg-zinc-900 dark:bg-zinc-950 p-4 overflow-x-auto">
                                    <pre className="text-sm text-red-400 font-mono whitespace-pre-wrap break-words">
                                      {inst.last_error}
                                    </pre>
                                  </div>
                                </div>
                              )}

                              <div className="text-xs text-zinc-500 dark:text-zinc-400 italic">
                                Note: Full error history and detailed logs are available on the individual MCP detail pages.
                              </div>
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}
