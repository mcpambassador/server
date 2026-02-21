import { useState, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { 
  PlusIcon, 
  EyeIcon, 
  ArrowPathIcon, 
  ArchiveBoxIcon, 
  TrashIcon 
} from '@heroicons/react/20/solid';
import { CheckCircleIcon } from '@heroicons/react/16/solid';
import { toast } from 'sonner';
import { Heading } from '@/components/catalyst/heading';
import { Text } from '@/components/catalyst/text';
import { Badge } from '@/components/catalyst/badge';
import { Button } from '@/components/catalyst/button';
import { Listbox, ListboxOption, ListboxLabel } from '@/components/catalyst/listbox';
import { Table, TableHead, TableBody, TableRow, TableHeader, TableCell } from '@/components/catalyst/table';
import { Alert, AlertTitle, AlertDescription, AlertActions } from '@/components/catalyst/alert';
import {
  useAdminMcps,
  useAdminMcpHealth,
  useDeleteMcp,
  useValidateMcp,
  usePublishMcp,
  useArchiveMcp,
} from '@/api/hooks/use-admin';
import type { McpCatalogEntry, McpHealthEntry } from '@/api/types';
import { usePageTitle } from '@/hooks/usePageTitle';

export function McpsAdmin() {
  usePageTitle('Admin - MCPs');
  const navigate = useNavigate();
  const [statusFilter, setStatusFilter] = useState<'draft' | 'published' | 'archived' | undefined>(undefined);
  const { data: mcpsData, isLoading } = useAdminMcps({ status: statusFilter });
  const { data: healthData } = useAdminMcpHealth();
  const deleteMcp = useDeleteMcp();
  const validateMcp = useValidateMcp();
  const publishMcp = usePublishMcp();
  const archiveMcp = useArchiveMcp();

  // Build a lookup map from MCP internal name to health entry
  const healthByName = useMemo(() => {
    const map = new Map<string, McpHealthEntry>();
    if (healthData?.shared) {
      for (const entry of healthData.shared) {
        map.set(entry.name, entry);
      }
    }
    return map;
  }, [healthData]);

  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [mcpToDelete, setMcpToDelete] = useState<McpCatalogEntry | null>(null);

  const handleValidate = async (mcpId: string) => {
    try {
      const result = await validateMcp.mutateAsync(mcpId);
      if (result.valid) {
        toast.success('Validation passed');
      } else {
        toast.error('Validation failed', { description: result.errors.join(', ') });
      }
    } catch (error) {
      toast.error('Validate MCP failed', { description: (error as Error)?.message ?? String(error) });
    }
  };

  const handlePublish = async (mcpId: string) => {
    try {
      await publishMcp.mutateAsync(mcpId);
    } catch (error) {
      toast.error('Publish MCP failed', { description: (error as Error)?.message ?? String(error) });
    }
  };

  const handleArchive = async (mcpId: string) => {
    try {
      await archiveMcp.mutateAsync(mcpId);
    } catch (error) {
      toast.error('Archive MCP failed', { description: (error as Error)?.message ?? String(error) });
    }
  };

  const handleDelete = async () => {
    if (!mcpToDelete) return;
    try {
      await deleteMcp.mutateAsync(mcpToDelete.mcp_id);
      setDeleteDialogOpen(false);
      setMcpToDelete(null);
    } catch (error) {
      toast.error('Delete MCP failed', { description: (error as Error)?.message ?? String(error) });
    }
  };

  const mcps = mcpsData?.data ?? [];

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <Heading>MCP Management</Heading>
          <Text>Administer MCP servers and configurations</Text>
        </div>
        <Button onClick={() => navigate('/app/admin/mcps/new')}>
          <PlusIcon />
          Create MCP
        </Button>
      </div>

      {/* Status Filter */}
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium text-zinc-700 dark:text-white">Status:</span>
        <Listbox
          name="status"
          value={statusFilter || ''}
          onChange={(value: string) =>
            setStatusFilter(value ? (value as any) : undefined)
          }
        >
          <ListboxOption value="">
            <ListboxLabel>All</ListboxLabel>
          </ListboxOption>
          <ListboxOption value="draft">
            <ListboxLabel>Draft</ListboxLabel>
          </ListboxOption>
          <ListboxOption value="published">
            <ListboxLabel>Published</ListboxLabel>
          </ListboxOption>
          <ListboxOption value="archived">
            <ListboxLabel>Archived</ListboxLabel>
          </ListboxOption>
        </Listbox>
      </div>

      {/* Table */}
      <div className="rounded-lg bg-white dark:bg-white/5 ring-1 ring-zinc-950/5 dark:ring-white/10">
        <Table className="mt-4 [--gutter:--spacing(6)] lg:[--gutter:--spacing(10)]">
          <TableHead>
            <TableRow>
              <TableHeader>Name</TableHeader>
              <TableHeader>Internal Name</TableHeader>
              <TableHeader>Transport</TableHeader>
              <TableHeader>Status</TableHeader>
              <TableHeader>Validation</TableHeader>
              <TableHeader>Health</TableHeader>
              <TableHeader>Isolation</TableHeader>
              <TableHeader>Created</TableHeader>
              <TableHeader>Actions</TableHeader>
            </TableRow>
          </TableHead>
          <TableBody>
            {isLoading ? (
              // Loading state with animate-pulse
              <>
                {[...Array(5)].map((_, i) => (
                  <TableRow key={i}>
                    <TableCell>
                      <div className="h-4 w-32 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
                    </TableCell>
                    <TableCell>
                      <div className="h-4 w-24 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
                    </TableCell>
                    <TableCell>
                      <div className="h-4 w-20 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
                    </TableCell>
                    <TableCell>
                      <div className="h-5 w-16 animate-pulse rounded-full bg-zinc-200 dark:bg-zinc-700" />
                    </TableCell>
                    <TableCell>
                      <div className="h-5 w-16 animate-pulse rounded-full bg-zinc-200 dark:bg-zinc-700" />
                    </TableCell>
                    <TableCell>
                      <div className="h-4 w-20 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
                    </TableCell>
                    <TableCell>
                      <div className="h-4 w-20 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
                    </TableCell>
                    <TableCell>
                      <div className="h-4 w-24 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <div className="h-8 w-8 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
                        <div className="h-8 w-8 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
                        <div className="h-8 w-8 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </>
            ) : mcps.length === 0 ? (
              // Empty state
              <TableRow>
                <TableCell colSpan={9} className="h-32 text-center text-zinc-500">
                  No MCPs yet.
                </TableCell>
              </TableRow>
            ) : (
              // Data rows
              mcps.map((mcp) => (
                <TableRow key={mcp.mcp_id}>
                  <TableCell>
                    <Link
                      to={`/app/admin/mcps/${mcp.mcp_id}`}
                      className="font-medium text-zinc-900 dark:text-white hover:underline"
                    >
                      {mcp.display_name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <code className="rounded bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 text-sm font-mono text-zinc-900 dark:text-white">
                      {mcp.name}
                    </code>
                  </TableCell>
                  <TableCell className="text-zinc-700 dark:text-zinc-300">{mcp.transport_type}</TableCell>
                  <TableCell>
                    <Badge
                      color={
                        mcp.status === 'draft'
                          ? 'zinc'
                          : mcp.status === 'published'
                          ? 'green'
                          : 'zinc'
                      }
                    >
                      {mcp.status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {mcp.validation_status ? (
                      <Badge
                        color={
                          mcp.validation_status === 'valid'
                            ? 'green'
                            : mcp.validation_status === 'invalid'
                            ? 'red'
                            : 'zinc'
                        }
                      >
                        {mcp.validation_status}
                      </Badge>
                    ) : (
                      <span className="text-zinc-500">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {(() => {
                      const health = healthByName.get(mcp.name);
                      if (!health) {
                        return <span className="text-zinc-400 dark:text-zinc-500">—</span>;
                      }
                      return (
                        <div className="flex items-center gap-1.5">
                          <span
                            className={`inline-block size-2 rounded-full ${
                              health.connected
                                ? 'bg-green-500'
                                : 'bg-red-500'
                            }`}
                            title={health.connected ? 'Connected' : 'Disconnected'}
                          />
                          <span className={`text-sm ${
                            health.connected
                              ? 'text-green-700 dark:text-green-400'
                              : 'text-red-700 dark:text-red-400'
                          }`}>
                            {health.connected ? 'Online' : 'Offline'}
                          </span>
                          {health.detail.toolCount != null && health.detail.toolCount > 0 && (
                            <Badge color="zinc" className="ml-1">
                              {health.detail.toolCount} tools
                            </Badge>
                          )}
                        </div>
                      );
                    })()}
                  </TableCell>
                  <TableCell className="text-zinc-700 dark:text-zinc-300">{mcp.isolation_mode}</TableCell>
                  <TableCell className="text-zinc-700 dark:text-zinc-300">
                    {new Date(mcp.created_at).toLocaleDateString()}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      {/* View */}
                      <Button plain title="View Details" href={`/app/admin/mcps/${mcp.mcp_id}`}>
                        <EyeIcon />
                      </Button>
                      {/* Validate */}
                      <Button
                        plain
                        title="Validate"
                        onClick={() => handleValidate(mcp.mcp_id)}
                        disabled={validateMcp.isPending}
                      >
                        <ArrowPathIcon />
                      </Button>
                      {/* Publish (draft + valid only) */}
                      {mcp.status === 'draft' && mcp.validation_status === 'valid' && (
                        <Button
                          plain
                          onClick={() => handlePublish(mcp.mcp_id)}
                          disabled={publishMcp.isPending}
                        >
                          <CheckCircleIcon />
                        </Button>
                      )}
                      {/* Archive (published only) */}
                      {mcp.status === 'published' && (
                        <Button
                          plain
                          title="Archive"
                          onClick={() => handleArchive(mcp.mcp_id)}
                          disabled={archiveMcp.isPending}
                        >
                          <ArchiveBoxIcon />
                        </Button>
                      )}
                      {/* Delete (draft or archived) */}
                      {(mcp.status === 'draft' || mcp.status === 'archived') && (
                        <Button
                          plain
                          title="Delete"
                          onClick={() => {
                            setMcpToDelete(mcp);
                            setDeleteDialogOpen(true);
                          }}
                        >
                          <TrashIcon />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Delete Confirmation Alert */}
      <Alert open={deleteDialogOpen} onClose={setDeleteDialogOpen}>
        <AlertTitle>Are you sure?</AlertTitle>
        <AlertDescription>
          This will permanently delete the MCP &quot;{mcpToDelete?.display_name}&quot;. Draft and
          archived MCPs can be deleted. This action cannot be undone.
        </AlertDescription>
        <AlertActions>
          <Button
            plain
            onClick={() => {
              setDeleteDialogOpen(false);
              setMcpToDelete(null);
            }}
          >
            Cancel
          </Button>
          <Button color="red" onClick={handleDelete}>
            Delete
          </Button>
        </AlertActions>
      </Alert>
    </div>
  );
}
