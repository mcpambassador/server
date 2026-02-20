import { useState } from 'react';
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
  useDeleteMcp,
  useValidateMcp,
  usePublishMcp,
  useArchiveMcp,
} from '@/api/hooks/use-admin';
import type { McpCatalogEntry } from '@/api/types';
import { usePageTitle } from '@/hooks/usePageTitle';

export function McpsAdmin() {
  usePageTitle('Admin - MCPs');
  const navigate = useNavigate();
  const [statusFilter, setStatusFilter] = useState<'draft' | 'published' | 'archived' | undefined>(undefined);
  const { data: mcpsData, isLoading } = useAdminMcps({ status: statusFilter });
  const deleteMcp = useDeleteMcp();
  const validateMcp = useValidateMcp();
  const publishMcp = usePublishMcp();
  const archiveMcp = useArchiveMcp();

  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [mcpToDelete, setMcpToDelete] = useState<McpCatalogEntry | null>(null);

  const handleValidate = async (mcpId: string) => {
    try {
      const result = await validateMcp.mutateAsync(mcpId);
      if (result.valid) {
        toast.success('Validation passed', { description: `Discovered ${result.tools_discovered.length} tools.` });
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
        <span className="text-sm font-medium text-zinc-700">Status:</span>
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
      <div className="rounded-lg bg-white ring-1 ring-zinc-950/5">
        <Table className="mt-4 [--gutter:--spacing(6)] lg:[--gutter:--spacing(10)]">
          <TableHead>
            <TableRow>
              <TableHeader>Name</TableHeader>
              <TableHeader>Internal Name</TableHeader>
              <TableHeader>Transport</TableHeader>
              <TableHeader>Status</TableHeader>
              <TableHeader>Validation</TableHeader>
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
                      <div className="h-4 w-32 animate-pulse rounded bg-zinc-200" />
                    </TableCell>
                    <TableCell>
                      <div className="h-4 w-24 animate-pulse rounded bg-zinc-200" />
                    </TableCell>
                    <TableCell>
                      <div className="h-4 w-20 animate-pulse rounded bg-zinc-200" />
                    </TableCell>
                    <TableCell>
                      <div className="h-5 w-16 animate-pulse rounded-full bg-zinc-200" />
                    </TableCell>
                    <TableCell>
                      <div className="h-5 w-16 animate-pulse rounded-full bg-zinc-200" />
                    </TableCell>
                    <TableCell>
                      <div className="h-4 w-20 animate-pulse rounded bg-zinc-200" />
                    </TableCell>
                    <TableCell>
                      <div className="h-4 w-24 animate-pulse rounded bg-zinc-200" />
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <div className="h-8 w-8 animate-pulse rounded bg-zinc-200" />
                        <div className="h-8 w-8 animate-pulse rounded bg-zinc-200" />
                        <div className="h-8 w-8 animate-pulse rounded bg-zinc-200" />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </>
            ) : mcps.length === 0 ? (
              // Empty state
              <TableRow>
                <TableCell colSpan={8} className="h-32 text-center text-zinc-500">
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
                      className="font-medium text-zinc-900 hover:underline"
                    >
                      {mcp.display_name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-sm font-mono text-zinc-900">
                      {mcp.name}
                    </code>
                  </TableCell>
                  <TableCell className="text-zinc-700">{mcp.transport_type}</TableCell>
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
                  <TableCell className="text-zinc-700">{mcp.isolation_mode}</TableCell>
                  <TableCell className="text-zinc-700">
                    {new Date(mcp.created_at).toLocaleDateString()}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      {/* View */}
                      <Button plain href={`/app/admin/mcps/${mcp.mcp_id}`}>
                        <EyeIcon />
                      </Button>
                      {/* Validate */}
                      <Button
                        plain
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
                          onClick={() => handleArchive(mcp.mcp_id)}
                          disabled={archiveMcp.isPending}
                        >
                          <ArchiveBoxIcon />
                        </Button>
                      )}
                      {/* Delete (draft only) */}
                      {mcp.status === 'draft' && (
                        <Button
                          plain
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
          This will permanently delete the MCP &quot;{mcpToDelete?.display_name}&quot;. Only draft
          MCPs can be deleted. This action cannot be undone.
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
