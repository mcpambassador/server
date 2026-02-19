import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Eye, CheckCircle, Archive, Trash2, RefreshCw } from 'lucide-react';
import { useToast } from '@/components/ui/toast';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { DataTable, type ColumnDef } from '@/components/data/DataTable';
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
  const { addToast } = useToast();
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
        addToast({ title: 'Validation passed', description: `Discovered ${result.tools_discovered.length} tools.`, variant: 'success' });
      } else {
        addToast({ title: 'Validation failed', description: result.errors.join(', '), variant: 'destructive' });
      }
    } catch (error) {
      addToast({ title: 'Validate MCP failed', description: (error as Error)?.message ?? String(error), variant: 'destructive' });
    }
  };

  const handlePublish = async (mcpId: string) => {
    try {
      await publishMcp.mutateAsync(mcpId);
    } catch (error) {
      addToast({ title: 'Publish MCP failed', description: (error as Error)?.message ?? String(error), variant: 'destructive' });
    }
  };

  const handleArchive = async (mcpId: string) => {
    try {
      await archiveMcp.mutateAsync(mcpId);
    } catch (error) {
      addToast({ title: 'Archive MCP failed', description: (error as Error)?.message ?? String(error), variant: 'destructive' });
    }
  };

  const handleDelete = async () => {
    if (!mcpToDelete) return;
    try {
      await deleteMcp.mutateAsync(mcpToDelete.mcp_id);
      setDeleteDialogOpen(false);
      setMcpToDelete(null);
    } catch (error) {
      addToast({ title: 'Delete MCP failed', description: (error as Error)?.message ?? String(error), variant: 'destructive' });
    }
  };

  const columns: ColumnDef<McpCatalogEntry>[] = [
    {
      header: 'Name',
      accessor: 'display_name',
      cell: (mcp) => (
        <Link
          to={`/app/admin/mcps/${mcp.mcp_id}`}
          className="font-medium hover:underline"
        >
          {mcp.display_name}
        </Link>
      ),
    },
    {
      header: 'Internal Name',
      accessor: 'name',
      cell: (mcp) => <code className="text-sm">{mcp.name}</code>,
    },
    {
      header: 'Transport',
      accessor: 'transport_type',
    },
    {
      header: 'Status',
      accessor: 'status',
      cell: (mcp) => {
        const variant =
          mcp.status === 'draft'
            ? 'secondary'
            : mcp.status === 'published'
            ? 'default'
            : 'outline';
        return <Badge variant={variant}>{mcp.status}</Badge>;
      },
    },
    {
      header: 'Validation',
      accessor: 'validation_status',
      cell: (mcp) =>
        mcp.validation_status ? (
          <Badge
            variant={
              mcp.validation_status === 'valid'
                ? 'default'
                : mcp.validation_status === 'invalid'
                ? 'destructive'
                : 'outline'
            }
          >
            {mcp.validation_status}
          </Badge>
        ) : (
          '—'
        ),
    },
    {
      header: 'Isolation',
      accessor: 'isolation_mode',
    },
    {
      header: 'Created',
      accessor: 'created_at',
      cell: (mcp) => new Date(mcp.created_at).toLocaleDateString(),
    },
    {
      header: 'Actions',
      accessor: 'mcp_id',
      cell: (mcp) => (
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" asChild>
            <Link to={`/app/admin/mcps/${mcp.mcp_id}`}>
              <Eye className="h-4 w-4" />
            </Link>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => handleValidate(mcp.mcp_id)}
            disabled={validateMcp.isPending}
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
          {mcp.status === 'draft' && mcp.validation_status === 'valid' && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => handlePublish(mcp.mcp_id)}
              disabled={publishMcp.isPending}
            >
              <CheckCircle className="h-4 w-4" />
            </Button>
          )}
          {mcp.status === 'published' && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => handleArchive(mcp.mcp_id)}
              disabled={archiveMcp.isPending}
            >
              <Archive className="h-4 w-4" />
            </Button>
          )}
          {mcp.status === 'draft' && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                setMcpToDelete(mcp);
                setDeleteDialogOpen(true);
              }}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">MCP Management</h1>
          <p className="text-muted-foreground">
            Administer MCP servers and configurations
          </p>
        </div>
        <Button onClick={() => navigate('/app/admin/mcps/new')}>
          <Plus className="mr-2 h-4 w-4" />
          Create MCP
        </Button>
      </div>

      <div className="flex items-center gap-2">
        <label className="text-sm font-medium">Status Filter:</label>
        <select
          value={statusFilter || ''}
          onChange={(e) =>
            setStatusFilter(e.target.value ? (e.target.value as any) : undefined)
          }
          className="flex h-9 w-40 rounded-md border border-input bg-background px-3 py-1 text-sm"
        >
          <option value="">All</option>
          <option value="draft">Draft</option>
          <option value="published">Published</option>
          <option value="archived">Archived</option>
        </select>
      </div>

      <Card className="p-6">
        <DataTable
          columns={columns}
          data={mcpsData?.data ?? []}
          isLoading={isLoading}
          emptyMessage="No MCPs yet."
        />
      </Card>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you sure?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the MCP &quot;{mcpToDelete?.display_name}&quot;. Only
              draft MCPs can be deleted. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setMcpToDelete(null)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
