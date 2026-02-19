import { useState, useEffect } from 'react';
import { RefreshCw } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DataTable, type ColumnDef } from '@/components/data/DataTable';
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

  const columns: ColumnDef<AuditEvent>[] = [
    {
      header: 'Timestamp',
      accessor: 'timestamp',
      cell: (event) => (
        <div>
          <p className="text-sm">{new Date(event.timestamp).toLocaleDateString()}</p>
          <p className="text-xs text-muted-foreground">
            {new Date(event.timestamp).toLocaleTimeString()}
          </p>
        </div>
      ),
    },
    {
      header: 'Event Type',
      accessor: 'event_type',
      cell: (event) => <code className="text-sm">{event.event_type}</code>,
    },
    {
      header: 'Severity',
      accessor: 'severity',
      cell: (event) => (
        <Badge
          variant={
            event.severity === 'error'
              ? 'destructive'
              : event.severity === 'warn'
              ? 'secondary'
              : 'outline'
          }
        >
          {event.severity}
        </Badge>
      ),
    },
    {
      header: 'Action',
      accessor: 'action',
      cell: (event) => <p className="text-sm max-w-sm truncate">{event.action}</p>,
    },
    {
      header: 'User ID',
      accessor: 'user_id',
      cell: (event) => (
        <code className="text-xs">{event.user_id || '—'}</code>
      ),
    },
    {
      header: 'Client ID',
      accessor: 'client_id',
      cell: (event) => (
        <code className="text-xs">{event.client_id || '—'}</code>
      ),
    },
    {
      header: 'Source IP',
      accessor: 'source_ip',
      cell: (event) => <code className="text-xs">{event.source_ip}</code>,
    },
    {
      header: 'Metadata',
      accessor: 'metadata',
      cell: (event) => (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">View</summary>
          <pre className="mt-2 bg-muted p-2 rounded overflow-x-auto max-w-xs">
            {JSON.stringify(event.metadata, null, 2)}
          </pre>
        </details>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Audit Logs</h1>
          <p className="text-muted-foreground">
            View system audit logs and activity history
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Refresh
        </Button>
      </div>

      {/* Filters */}
      <Card className="p-6">
        <div className="space-y-4">
          <h3 className="font-medium">Filters</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="space-y-2">
              <Label htmlFor="start_time">Start Time</Label>
              <Input
                id="start_time"
                type="datetime-local"
                value={filters.start_time}
                onChange={(e) =>
                  setFilters({ ...filters, start_time: e.target.value })
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="end_time">End Time</Label>
              <Input
                id="end_time"
                type="datetime-local"
                value={filters.end_time}
                onChange={(e) =>
                  setFilters({ ...filters, end_time: e.target.value })
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="event_type">Event Type</Label>
              <Input
                id="event_type"
                placeholder="e.g., user.login"
                value={filters.event_type}
                onChange={(e) =>
                  setFilters({ ...filters, event_type: e.target.value })
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="user_id">User ID</Label>
              <Input
                id="user_id"
                placeholder="Filter by user"
                value={filters.user_id}
                onChange={(e) =>
                  setFilters({ ...filters, user_id: e.target.value })
                }
              />
            </div>
          </div>
          <div className="flex gap-2">
            <Button onClick={handleApplyFilters} size="sm">
              Apply Filters
            </Button>
            <Button variant="outline" onClick={handleReset} size="sm">
              Reset
            </Button>
          </div>
        </div>
      </Card>

      {/* Audit Events Table */}
      <Card className="p-6">
        <DataTable
          columns={columns}
          data={events}
          isLoading={isLoading}
          emptyMessage="No audit events found."
          pagination={
            nextCursor
              ? {
                  hasMore: true,
                  onLoadMore: () => {
                    setAppliedFilters((prev) => ({ ...prev, cursor: nextCursor }));
                  },
                }
              : undefined
          }
        />
      </Card>
    </div>
  );
}
