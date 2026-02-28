import { useState, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { 
  PlusIcon, 
  EyeIcon, 
  ArrowPathIcon, 
  ArchiveBoxIcon, 
  TrashIcon,
  ArrowPathRoundedSquareIcon,
  ExclamationTriangleIcon,
  CubeIcon,
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
import { Dialog, DialogTitle, DialogDescription, DialogBody, DialogActions } from '@/components/catalyst/dialog';
import { EmptyState } from '@/components/shared/EmptyState';
import {
  useAdminMcps,
  useAdminMcpHealth,
  useDeleteMcp,
  useValidateMcp,
  usePublishMcp,
  useArchiveMcp,
  useCatalogStatus,
  useApplyCatalogChanges,
} from '@/api/hooks/use-admin';
import type { McpCatalogEntry, McpHealthEntry, CatalogApplyResult } from '@/api/types';
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

  // Catalog status and apply changes
  const { data: catalogStatus } = useCatalogStatus();
  const applyCatalogChanges = useApplyCatalogChanges();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [applyResult, setApplyResult] = useState<CatalogApplyResult | null>(null);
  const [resultOpen, setResultOpen] = useState(false);

  const hasPendingChanges = catalogStatus?.has_changes ?? false;
  const totalChanges = hasPendingChanges
    ? (catalogStatus!.shared.to_add.length + catalogStatus!.shared.to_remove.length + catalogStatus!.shared.to_update.length +
       catalogStatus!.per_user.to_add.length + catalogStatus!.per_user.to_remove.length + catalogStatus!.per_user.to_update.length)
    : 0;

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
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);
  const [publishDialogOpen, setPublishDialogOpen] = useState(false);
  const [mcpToDelete, setMcpToDelete] = useState<McpCatalogEntry | null>(null);
  const [mcpToArchive, setMcpToArchive] = useState<McpCatalogEntry | null>(null);
  const [mcpToPublish, setMcpToPublish] = useState<McpCatalogEntry | null>(null);

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

  const handlePublish = async () => {
    if (!mcpToPublish) return;
    try {
      await publishMcp.mutateAsync(mcpToPublish.mcp_id);
      setPublishDialogOpen(false);
      setMcpToPublish(null);
    } catch (error) {
      toast.error('Publish MCP failed', { description: (error as Error)?.message ?? String(error) });
    }
  };

  const handleArchive = async () => {
    if (!mcpToArchive) return;
    try {
      await archiveMcp.mutateAsync(mcpToArchive.mcp_id);
      setArchiveDialogOpen(false);
      setMcpToArchive(null);
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

  const handleApply = async () => {
    try {
      const result = await applyCatalogChanges.mutateAsync();
      setPreviewOpen(false);
      setApplyResult(result);
      setResultOpen(true);
      if (result.summary.failed === 0) {
        toast.success(`${result.summary.successful} changes applied successfully`);
      } else {
        toast.warning(`${result.summary.successful} succeeded, ${result.summary.failed} failed`);
      }
    } catch (error) {
      toast.error('Apply changes failed', { description: (error as Error)?.message ?? String(error) });
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
        <div className="flex items-center gap-3">
          <Button
            color={hasPendingChanges ? 'amber' : 'zinc'}
            disabled={!hasPendingChanges}
            onClick={() => setPreviewOpen(true)}
          >
            <ArrowPathRoundedSquareIcon />
            Apply Changes
            {hasPendingChanges && totalChanges > 0 && (
              <Badge color="zinc" className="ml-1">{totalChanges}</Badge>
            )}
          </Button>
          <Button onClick={() => navigate('/app/admin/mcps/new')}>
            <PlusIcon />
            Create MCP
          </Button>
        </div>
      </div>

      {/* Status Filter */}
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium text-zinc-700 dark:text-white">Status:</span>
        <Listbox
          name="status"
          value={statusFilter || ''}
          onChange={(value: string) =>
            setStatusFilter(value ? (value as 'draft' | 'published' | 'archived') : undefined)
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

      {/* Pending Changes Banner */}
      {hasPendingChanges && catalogStatus && (
        <div className="rounded-lg bg-amber-50 dark:bg-amber-500/10 ring-1 ring-amber-600/20 dark:ring-amber-400/20 p-4">
          <div className="flex items-start gap-3">
            <ExclamationTriangleIcon className="size-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
                {totalChanges} pending change{totalChanges !== 1 ? 's' : ''}:
                {' '}
                {[
                  catalogStatus.shared.to_add.length + catalogStatus.per_user.to_add.length > 0 &&
                    `${catalogStatus.shared.to_add.length + catalogStatus.per_user.to_add.length} to add`,
                  catalogStatus.shared.to_update.length + catalogStatus.per_user.to_update.length > 0 &&
                    `${catalogStatus.shared.to_update.length + catalogStatus.per_user.to_update.length} to update`,
                  catalogStatus.shared.to_remove.length + catalogStatus.per_user.to_remove.length > 0 &&
                    `${catalogStatus.shared.to_remove.length + catalogStatus.per_user.to_remove.length} to remove`,
                ].filter(Boolean).join(', ')}
              </p>
              <p className="text-xs text-amber-700 dark:text-amber-300 mt-1">
                Click &quot;Apply Changes&quot; to preview and apply these changes to the running server
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Clean Status */}
      {!hasPendingChanges && (
        <div className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
          <CheckCircleIcon className="size-5 text-green-600 dark:text-green-400" />
          <span>All changes applied — running state matches catalog</span>
        </div>
      )}

      {/* Table */}
      <div className="rounded-lg bg-white dark:bg-white/5 ring-1 ring-zinc-950/10 dark:ring-white/10">
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
                <TableCell colSpan={9}>
                  <EmptyState
                    icon={<CubeIcon className="size-6 text-zinc-400" />}
                    title="No MCPs configured yet"
                    description="Create your first MCP server configuration to get started."
                    action={{
                      label: 'Create MCP',
                      onClick: () => navigate('/app/admin/mcps/new'),
                    }}
                  />
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
                          title="Publish"
                          onClick={() => {
                            setMcpToPublish(mcp);
                            setPublishDialogOpen(true);
                          }}
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
                          onClick={() => {
                            setMcpToArchive(mcp);
                            setArchiveDialogOpen(true);
                          }}
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

      {/* Publish Confirmation Alert */}
      <Alert open={publishDialogOpen} onClose={setPublishDialogOpen}>
        <AlertTitle>Publish MCP?</AlertTitle>
        <AlertDescription>
          This will publish &quot;{mcpToPublish?.display_name}&quot; and make it available to authorized users. Ensure the configuration is correct before publishing.
        </AlertDescription>
        <AlertActions>
          <Button
            plain
            onClick={() => {
              setPublishDialogOpen(false);
              setMcpToPublish(null);
            }}
          >
            Cancel
          </Button>
          <Button color="green" onClick={handlePublish}>
            Publish
          </Button>
        </AlertActions>
      </Alert>

      {/* AlertActions>
      </Alert>

      {/* Archive Confirmation Alert */}
      <Alert open={archiveDialogOpen} onClose={setArchiveDialogOpen}>
        <AlertTitle>Archive MCP?</AlertTitle>
        <AlertDescription>
          This will archive &quot;{mcpToArchive?.display_name}&quot; and make it unavailable to users. You can re-publish it later.
        </AlertDescription>
        <AlertActions>
          <Button
            plain
            onClick={() => {
              setArchiveDialogOpen(false);
              setMcpToArchive(null);
            }}
          >
            Cancel
          </Button>
          <Button color="amber" onClick={handleArchive}>
            Archive
          </Button>
        </AlertActions>
      </Alert>

      {/* Preview Dialog */}
      <Dialog open={previewOpen} onClose={setPreviewOpen} size="xl">
        <DialogTitle>Review Pending Changes</DialogTitle>
        <DialogDescription>These changes will be applied to the running server</DialogDescription>
        <DialogBody>
          <div className="space-y-6">
            {/* Shared changes */}
            {catalogStatus?.shared.to_add && catalogStatus.shared.to_add.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <div className="flex items-center justify-center size-6 rounded-full bg-green-100 dark:bg-green-500/10 text-green-700 dark:text-green-400 text-sm font-bold">+</div>
                  <h4 className="text-sm font-semibold text-green-700 dark:text-green-400">To Add ({catalogStatus.shared.to_add.length + (catalogStatus.per_user.to_add?.length ?? 0)})</h4>
                </div>
                <div className="ml-8 space-y-2">
                  {catalogStatus.shared.to_add.map(item => (
                    <div key={item.name} className="rounded-lg bg-green-50 dark:bg-green-500/5 ring-1 ring-green-600/20 dark:ring-green-400/20 p-3">
                      <p className="text-sm font-medium text-green-900 dark:text-green-200">{item.name}</p>
                      <p className="text-xs text-green-700 dark:text-green-300 mt-1">
                        <span className="font-medium">Type:</span> {item.transport_type} · <span className="font-medium">Isolation:</span> shared
                      </p>
                    </div>
                  ))}
                  {catalogStatus.per_user.to_add.map(item => (
                    <div key={item.name} className="rounded-lg bg-green-50 dark:bg-green-500/5 ring-1 ring-green-600/20 dark:ring-green-400/20 p-3">
                      <p className="text-sm font-medium text-green-900 dark:text-green-200">{item.name}</p>
                      <p className="text-xs text-green-700 dark:text-green-300 mt-1">
                        <span className="font-medium">Isolation:</span> per_user
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* To Update section */}
            {((catalogStatus?.shared.to_update?.length ?? 0) + (catalogStatus?.per_user.to_update?.length ?? 0)) > 0 && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <div className="flex items-center justify-center size-6 rounded-full bg-amber-100 dark:bg-amber-500/10 text-amber-700 dark:text-amber-400 text-sm font-bold">↻</div>
                  <h4 className="text-sm font-semibold text-amber-700 dark:text-amber-400">To Update ({(catalogStatus?.shared.to_update?.length ?? 0) + (catalogStatus?.per_user.to_update?.length ?? 0)})</h4>
                </div>
                <div className="ml-8 space-y-2">
                  {catalogStatus?.shared.to_update.map(item => (
                    <div key={item.name} className="rounded-lg bg-amber-50 dark:bg-amber-500/5 ring-1 ring-amber-600/20 dark:ring-amber-400/20 p-3">
                      <p className="text-sm font-medium text-amber-900 dark:text-amber-200">{item.name}</p>
                      <p className="text-xs text-amber-700 dark:text-amber-300 mt-1">
                        <span className="font-medium">Changed:</span> {item.changed_fields.join(', ')} · <span className="font-medium">Isolation:</span> shared
                      </p>
                    </div>
                  ))}
                  {catalogStatus?.per_user.to_update.map(item => (
                    <div key={item.name} className="rounded-lg bg-amber-50 dark:bg-amber-500/5 ring-1 ring-amber-600/20 dark:ring-amber-400/20 p-3">
                      <p className="text-sm font-medium text-amber-900 dark:text-amber-200">{item.name}</p>
                      <p className="text-xs text-amber-700 dark:text-amber-300 mt-1">
                        <span className="font-medium">Isolation:</span> per_user
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* To Remove section */}
            {((catalogStatus?.shared.to_remove?.length ?? 0) + (catalogStatus?.per_user.to_remove?.length ?? 0)) > 0 && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <div className="flex items-center justify-center size-6 rounded-full bg-red-100 dark:bg-red-500/10 text-red-700 dark:text-red-400 text-sm font-bold">−</div>
                  <h4 className="text-sm font-semibold text-red-700 dark:text-red-400">To Remove ({(catalogStatus?.shared.to_remove?.length ?? 0) + (catalogStatus?.per_user.to_remove?.length ?? 0)})</h4>
                </div>
                <div className="ml-8 space-y-2">
                  {catalogStatus?.shared.to_remove.map(item => (
                    <div key={item.name} className="rounded-lg bg-red-50 dark:bg-red-500/5 ring-1 ring-red-600/20 dark:ring-red-400/20 p-3">
                      <p className="text-sm font-medium text-red-900 dark:text-red-200">{item.name}</p>
                      <p className="text-xs text-red-700 dark:text-red-300 mt-1">
                        <span className="font-medium">Reason:</span> {item.reason}
                      </p>
                    </div>
                  ))}
                  {catalogStatus?.per_user.to_remove.map(item => (
                    <div key={item.name} className="rounded-lg bg-red-50 dark:bg-red-500/5 ring-1 ring-red-600/20 dark:ring-red-400/20 p-3">
                      <p className="text-sm font-medium text-red-900 dark:text-red-200">{item.name}</p>
                      <p className="text-xs text-red-700 dark:text-red-300 mt-1">
                        <span className="font-medium">Isolation:</span> per_user
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Impact warning */}
            <div className="rounded-lg bg-amber-50 dark:bg-amber-500/10 ring-1 ring-amber-600/20 dark:ring-amber-400/20 p-4">
              <div className="flex gap-3">
                <ExclamationTriangleIcon className="size-5 text-amber-600 dark:text-amber-400 flex-shrink-0" />
                <div className="flex-1 text-xs text-amber-700 dark:text-amber-300">
                  <p className="font-medium mb-1">Impact on Connections:</p>
                  <ul className="space-y-1 list-disc list-inside">
                    <li>Shared MCPs will be restarted immediately</li>
                    <li>Per-user MCPs will update on next user connection</li>
                    <li>Active connections may be interrupted</li>
                  </ul>
                </div>
              </div>
            </div>
          </div>
        </DialogBody>
        <DialogActions>
          <Button plain onClick={() => setPreviewOpen(false)}>Cancel</Button>
          <Button color="amber" onClick={handleApply} disabled={applyCatalogChanges.isPending}>
            {applyCatalogChanges.isPending ? 'Applying...' : 'Apply Changes'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Result Dialog */}
      <Dialog open={resultOpen} onClose={setResultOpen} size="xl">
        {applyResult && (
          <>
            <div className="flex items-center gap-3">
              {applyResult.summary.failed === 0 ? (
                <div className="flex items-center justify-center size-10 rounded-full bg-green-100 dark:bg-green-500/10 text-green-700 dark:text-green-400">
                  <CheckCircleIcon className="size-6" />
                </div>
              ) : (
                <div className="flex items-center justify-center size-10 rounded-full bg-amber-100 dark:bg-amber-500/10 text-amber-700 dark:text-amber-400">
                  <ExclamationTriangleIcon className="size-6" />
                </div>
              )}
              <div>
                <DialogTitle>
                  {applyResult.summary.failed === 0 ? 'Changes Applied' : 'Changes Applied with Errors'}
                </DialogTitle>
                <DialogDescription>
                  {applyResult.summary.successful} succeeded
                  {applyResult.summary.failed > 0 && `, ${applyResult.summary.failed} failed`}
                </DialogDescription>
              </div>
            </div>
            <DialogBody>
              <div className="space-y-3">
                {/* Shared successes */}
                {applyResult.shared.added.map(name => (
                  <div key={`add-${name}`} className="flex items-start gap-3 p-3 rounded-lg bg-zinc-50 dark:bg-zinc-800/50">
                    <div className="flex items-center justify-center size-6 rounded-full bg-green-100 dark:bg-green-500/10 text-green-700 dark:text-green-400 flex-shrink-0 mt-0.5 text-sm font-bold">✓</div>
                    <div>
                      <p className="text-sm font-medium text-zinc-900 dark:text-white">{name}</p>
                      <p className="text-xs text-zinc-600 dark:text-zinc-400 mt-0.5">Added</p>
                    </div>
                  </div>
                ))}
                {applyResult.shared.updated.map(name => (
                  <div key={`upd-${name}`} className="flex items-start gap-3 p-3 rounded-lg bg-zinc-50 dark:bg-zinc-800/50">
                    <div className="flex items-center justify-center size-6 rounded-full bg-green-100 dark:bg-green-500/10 text-green-700 dark:text-green-400 flex-shrink-0 mt-0.5 text-sm font-bold">✓</div>
                    <div>
                      <p className="text-sm font-medium text-zinc-900 dark:text-white">{name}</p>
                      <p className="text-xs text-zinc-600 dark:text-zinc-400 mt-0.5">Updated</p>
                    </div>
                  </div>
                ))}
                {applyResult.shared.removed.map(name => (
                  <div key={`rem-${name}`} className="flex items-start gap-3 p-3 rounded-lg bg-zinc-50 dark:bg-zinc-800/50">
                    <div className="flex items-center justify-center size-6 rounded-full bg-green-100 dark:bg-green-500/10 text-green-700 dark:text-green-400 flex-shrink-0 mt-0.5 text-sm font-bold">✓</div>
                    <div>
                      <p className="text-sm font-medium text-zinc-900 dark:text-white">{name}</p>
                      <p className="text-xs text-zinc-600 dark:text-zinc-400 mt-0.5">Removed</p>
                    </div>
                  </div>
                ))}

                {/* Per-user changes */}
                {applyResult.per_user.configs_added.map(name => (
                  <div key={`pu-add-${name}`} className="flex items-start gap-3 p-3 rounded-lg bg-zinc-50 dark:bg-zinc-800/50">
                    <div className="flex items-center justify-center size-6 rounded-full bg-green-100 dark:bg-green-500/10 text-green-700 dark:text-green-400 flex-shrink-0 mt-0.5 text-sm font-bold">✓</div>
                    <div>
                      <p className="text-sm font-medium text-zinc-900 dark:text-white">{name}</p>
                      <p className="text-xs text-zinc-600 dark:text-zinc-400 mt-0.5">Added (per-user)</p>
                    </div>
                  </div>
                ))}
                {applyResult.per_user.configs_updated.map(name => (
                  <div key={`pu-upd-${name}`} className="flex items-start gap-3 p-3 rounded-lg bg-zinc-50 dark:bg-zinc-800/50">
                    <div className="flex items-center justify-center size-6 rounded-full bg-green-100 dark:bg-green-500/10 text-green-700 dark:text-green-400 flex-shrink-0 mt-0.5 text-sm font-bold">✓</div>
                    <div>
                      <p className="text-sm font-medium text-zinc-900 dark:text-white">{name}</p>
                      <p className="text-xs text-zinc-600 dark:text-zinc-400 mt-0.5">Updated (per-user)</p>
                    </div>
                  </div>
                ))}
                {applyResult.per_user.configs_removed.map(name => (
                  <div key={`pu-rem-${name}`} className="flex items-start gap-3 p-3 rounded-lg bg-zinc-50 dark:bg-zinc-800/50">
                    <div className="flex items-center justify-center size-6 rounded-full bg-green-100 dark:bg-green-500/10 text-green-700 dark:text-green-400 flex-shrink-0 mt-0.5 text-sm font-bold">✓</div>
                    <div>
                      <p className="text-sm font-medium text-zinc-900 dark:text-white">{name}</p>
                      <p className="text-xs text-zinc-600 dark:text-zinc-400 mt-0.5">Removed (per-user)</p>
                    </div>
                  </div>
                ))}

                {/* Errors */}
                {applyResult.shared.errors.map((err, i) => (
                  <div key={`err-${i}`} className="flex items-start gap-3 p-3 rounded-lg bg-red-50 dark:bg-red-500/5 ring-1 ring-red-600/20 dark:ring-red-400/20">
                    <div className="flex items-center justify-center size-6 rounded-full bg-red-100 dark:bg-red-500/20 text-red-700 dark:text-red-400 flex-shrink-0 mt-0.5 text-sm font-bold">✗</div>
                    <div>
                      <p className="text-sm font-medium text-red-900 dark:text-red-200">{err.name}</p>
                      <p className="text-xs text-red-700 dark:text-red-300 mt-0.5 font-medium">{err.action} failed</p>
                      <p className="text-xs text-red-600 dark:text-red-400 mt-1 font-mono">{err.error}</p>
                    </div>
                  </div>
                ))}

                {/* Per-user note */}
                {applyResult.per_user.active_users_affected > 0 && (
                  <div className="rounded-lg bg-zinc-50 dark:bg-zinc-800/50 p-3 text-xs text-zinc-600 dark:text-zinc-400">
                    {applyResult.per_user.note}
                    {' '}({applyResult.per_user.active_users_affected} active user{applyResult.per_user.active_users_affected !== 1 ? 's' : ''} affected)
                  </div>
                )}

                {/* Failure warning */}
                {applyResult.summary.failed > 0 && (
                  <div className="rounded-lg bg-amber-50 dark:bg-amber-500/10 ring-1 ring-amber-600/20 dark:ring-amber-400/20 p-3">
                    <p className="text-xs text-amber-700 dark:text-amber-300">
                      <span className="font-medium">Note:</span> Failed changes remain pending. Fix the issues and apply again.
                    </p>
                  </div>
                )}
              </div>
            </DialogBody>
            <DialogActions>
              <Button onClick={() => setResultOpen(false)}>Close</Button>
            </DialogActions>
          </>
        )}
      </Dialog>
    </div>
  );
}
