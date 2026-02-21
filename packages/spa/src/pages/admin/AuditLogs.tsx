import { useState, useEffect } from 'react';
import { ArrowPathIcon } from '@heroicons/react/20/solid';
import { Heading, Subheading } from '@/components/catalyst/heading';
import { Text } from '@/components/catalyst/text';
import { Button } from '@/components/catalyst/button';
import { Badge } from '@/components/catalyst/badge';
import { Input } from '@/components/catalyst/input';
import { Field, Label } from '@/components/catalyst/fieldset';
import { Table, TableHead, TableBody, TableRow, TableHeader, TableCell } from '@/components/catalyst/table';
import { useAuditEvents } from '@/api/hooks/use-admin';
import type { AuditEvent } from '@/api/types';
import { usePageTitle } from '@/hooks/usePageTitle';

export function AuditLogsAdmin() {
  usePageTitle('Admin - Audit Logs');
  const [filters, setFilters] = useState({
    start_time: '',
    end_time: '',
    event_type: '',
    user_id: '',
    limit: 50,
  });

  const [appliedFilters, setAppliedFilters] = useState<typeof filters & { cursor?: string }>(filters);
  const { data: auditData, isLoading, refetch } = useAuditEvents(appliedFilters);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);

  useEffect(() => {
    if (!auditData) return;
    const page = auditData.data ?? [];
    if (appliedFilters.cursor) {
      setEvents((prev) => [...prev, ...page]);
    } else {
      setEvents(page);
    }
    setNextCursor(auditData.pagination?.next_cursor ?? null);
  }, [auditData, appliedFilters.cursor]);

  const handleApplyFilters = () => {
    setAppliedFilters({ ...filters, cursor: undefined });
    setEvents([]);
  };

  const handleReset = () => {
    const defaultFilters = {
      start_time: '',
      end_time: '',
      event_type: '',
      user_id: '',
      limit: 50,
    };
    setFilters(defaultFilters);
    setAppliedFilters({ ...defaultFilters, cursor: undefined });
    setEvents([]);
  };

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex items-start justify-between">
        <div>
          <Heading>Audit Logs</Heading>
          <Text>View system audit logs and activity history</Text>
        </div>
        <Button outline onClick={() => refetch()}>
          <ArrowPathIcon data-slot="icon" />
          Refresh
        </Button>
      </div>

      {/* Filters Panel */}
      <div className="rounded-lg bg-white dark:bg-white/5 ring-1 ring-zinc-950/5 dark:ring-white/10 p-6">
        <div className="space-y-4">
          <Subheading>Filters</Subheading>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Field>
              <Label>Start Time</Label>
              <Input
                type="datetime-local"
                value={filters.start_time}
                onChange={(e) =>
                  setFilters({ ...filters, start_time: e.target.value })
                }
              />
            </Field>
            <Field>
              <Label>End Time</Label>
              <Input
                type="datetime-local"
                value={filters.end_time}
                onChange={(e) =>
                  setFilters({ ...filters, end_time: e.target.value })
                }
              />
            </Field>
            <Field>
              <Label>Event Type</Label>
              <Input
                placeholder="e.g., user.login"
                value={filters.event_type}
                onChange={(e) =>
                  setFilters({ ...filters, event_type: e.target.value })
                }
              />
            </Field>
            <Field>
              <Label>User ID</Label>
              <Input
                placeholder="Filter by user"
                value={filters.user_id}
                onChange={(e) =>
                  setFilters({ ...filters, user_id: e.target.value })
                }
              />
            </Field>
          </div>
          <div className="flex gap-2">
            <Button onClick={handleApplyFilters}>Apply Filters</Button>
            <Button outline onClick={handleReset}>
              Reset
            </Button>
          </div>
        </div>
      </div>

      {/* Audit Events Table */}
      <div className="rounded-lg bg-white dark:bg-white/5 ring-1 ring-zinc-950/5 dark:ring-white/10 overflow-hidden">
        <Table>
          <TableHead>
            <TableRow>
              <TableHeader>Timestamp</TableHeader>
              <TableHeader>Event Type</TableHeader>
              <TableHeader>Severity</TableHeader>
              <TableHeader>Action</TableHeader>
              <TableHeader>User ID</TableHeader>
              <TableHeader>Client ID</TableHeader>
              <TableHeader>Source IP</TableHeader>
              <TableHeader>Metadata</TableHeader>
            </TableRow>
          </TableHead>
          <TableBody>
            {isLoading && events.length === 0 ? (
              // Loading state
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell>
                    <div className="animate-pulse h-4 w-24 rounded bg-zinc-200 dark:bg-zinc-700" />
                  </TableCell>
                  <TableCell>
                    <div className="animate-pulse h-4 w-32 rounded bg-zinc-200 dark:bg-zinc-700" />
                  </TableCell>
                  <TableCell>
                    <div className="animate-pulse h-5 w-16 rounded bg-zinc-200 dark:bg-zinc-700" />
                  </TableCell>
                  <TableCell>
                    <div className="animate-pulse h-4 w-48 rounded bg-zinc-200 dark:bg-zinc-700" />
                  </TableCell>
                  <TableCell>
                    <div className="animate-pulse h-4 w-20 rounded bg-zinc-200 dark:bg-zinc-700" />
                  </TableCell>
                  <TableCell>
                    <div className="animate-pulse h-4 w-20 rounded bg-zinc-200 dark:bg-zinc-700" />
                  </TableCell>
                  <TableCell>
                    <div className="animate-pulse h-4 w-28 rounded bg-zinc-200 dark:bg-zinc-700" />
                  </TableCell>
                  <TableCell>
                    <div className="animate-pulse h-4 w-12 rounded bg-zinc-200 dark:bg-zinc-700" />
                  </TableCell>
                </TableRow>
              ))
            ) : events.length === 0 ? (
              // Empty state
              <TableRow>
                <TableCell colSpan={8} className="text-center py-8 text-zinc-500 dark:text-zinc-400">
                  No audit events found.
                </TableCell>
              </TableRow>
            ) : (
              // Data rows
              events.map((event) => (
                <TableRow key={event.event_id}>
                  <TableCell>
                    <div className="text-sm text-zinc-900 dark:text-white">
                      {new Date(event.timestamp).toLocaleDateString()}
                    </div>
                    <div className="text-xs text-zinc-500 dark:text-zinc-400">
                      {new Date(event.timestamp).toLocaleTimeString()}
                    </div>
                  </TableCell>
                  <TableCell>
                    <code className="text-sm font-mono text-zinc-900 dark:text-white">
                      {event.event_type}
                    </code>
                  </TableCell>
                  <TableCell>
                    <Badge
                      color={
                        event.severity === 'error'
                          ? 'red'
                          : event.severity === 'warn'
                          ? 'amber'
                          : 'zinc'
                      }
                    >
                      {event.severity}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="text-sm text-zinc-900 dark:text-white max-w-sm truncate">
                      {event.action}
                    </div>
                  </TableCell>
                  <TableCell>
                    <code className="text-xs font-mono text-zinc-900 dark:text-white">
                      {event.user_id || '—'}
                    </code>
                  </TableCell>
                  <TableCell>
                    <code className="text-xs font-mono text-zinc-900 dark:text-white">
                      {event.client_id || '—'}
                    </code>
                  </TableCell>
                  <TableCell>
                    <code className="text-xs font-mono text-zinc-900 dark:text-white">
                      {event.source_ip}
                    </code>
                  </TableCell>
                  <TableCell>
                    <details className="text-xs">
                      <summary className="cursor-pointer text-zinc-500 dark:text-zinc-400">
                        View
                      </summary>
                      <pre className="mt-2 bg-zinc-50 dark:bg-zinc-800 p-2 rounded text-xs overflow-x-auto max-w-xs">
                        {JSON.stringify(event.metadata, null, 2)}
                      </pre>
                    </details>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
        {nextCursor && (
          <div className="px-4 py-3 border-t border-zinc-950/5 dark:border-white/10 text-center">
            <Button
              outline
              onClick={() =>
                setAppliedFilters((prev) => ({ ...prev, cursor: nextCursor }))
              }
            >
              Load More
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
