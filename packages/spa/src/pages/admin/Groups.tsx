import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Eye, Trash2 } from 'lucide-react';
import { useToast } from '@/components/ui/toast';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/catalyst/button';
import { Dialog, DialogBody, DialogDescription, DialogActions, DialogTitle } from '@/components/catalyst/dialog';
import { Input } from '@/components/catalyst/input';
import { Label } from '@/components/catalyst/fieldset';
import { Textarea } from '@/components/catalyst/textarea';
import {
  Alert,
  AlertBody,
  AlertDescription,
  AlertActions,
  AlertTitle,
} from '@/components/catalyst/alert';
import { DataTable, type ColumnDef } from '@/components/data/DataTable';
import { useAdminGroups, useCreateGroup, useUpdateGroup, useDeleteGroup } from '@/api/hooks/use-admin';
import type { Group } from '@/api/types';
import { usePageTitle } from '@/hooks/usePageTitle';

export function GroupsAdmin() {
  usePageTitle('Admin - Groups');
  const { data: groups, isLoading } = useAdminGroups();
  const { addToast } = useToast();
  const createGroup = useCreateGroup();
  const updateGroup = useUpdateGroup();
  const deleteGroup = useDeleteGroup();

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState<Group | null>(null);

  const [createFormData, setCreateFormData] = useState({
    name: '',
    description: '',
  });

  const [editFormData, setEditFormData] = useState({
    name: '',
    description: '',
  });

  const handleCreate = async () => {
    try {
      await createGroup.mutateAsync({
        name: createFormData.name,
        description: createFormData.description || undefined,
      });
      setCreateDialogOpen(false);
      setCreateFormData({ name: '', description: '' });
    } catch (error) {
      addToast({ title: 'Create group failed', description: (error as Error)?.message ?? String(error), variant: 'red' });
    }
  };

  const handleEdit = async () => {
    if (!selectedGroup) return;
    try {
      await updateGroup.mutateAsync({
        groupId: selectedGroup.group_id,
        data: {
          name: editFormData.name || undefined,
          description: editFormData.description || undefined,
        },
      });
      setEditDialogOpen(false);
      setSelectedGroup(null);
    } catch (error) {
      addToast({ title: 'Update group failed', description: (error as Error)?.message ?? String(error), variant: 'red' });
    }
  };

  const handleDelete = async () => {
    if (!selectedGroup) return;
    try {
      await deleteGroup.mutateAsync(selectedGroup.group_id);
      setDeleteDialogOpen(false);
      setSelectedGroup(null);
    } catch (error) {
      addToast({ title: 'Delete group failed', description: (error as Error)?.message ?? String(error), variant: 'red' });
    }
  };

  const openEditDialog = (group: Group) => {
    setSelectedGroup(group);
    setEditFormData({
      name: group.name,
      description: group.description || '',
    });
    setEditDialogOpen(true);
  };

  const columns: ColumnDef<Group>[] = [
    {
      header: 'Name',
      accessor: 'name',
      cell: (group) => (
        <Link
          to={`/app/admin/groups/${group.group_id}`}
          className="font-medium hover:underline"
        >
          {group.name}
        </Link>
      ),
    },
    {
      header: 'Description',
      accessor: 'description',
      cell: (group) => group.description || '—',
    },
    {
      header: 'Created',
      accessor: 'created_at',
      cell: (group) => new Date(group.created_at).toLocaleDateString(),
    },
    {
      header: 'Updated',
      accessor: 'updated_at',
      cell: (group) => new Date(group.updated_at).toLocaleDateString(),
    },
    {
      header: 'Actions',
      accessor: 'group_id',
      cell: (group) => (
        <div className="flex items-center gap-2">
          <Button plain className="p-1" asChild>
            <Link to={`/app/admin/groups/${group.group_id}`}>
              <Eye className="h-4 w-4" />
            </Link>
          </Button>
          <Button
                        className="p-1"
            onClick={() => openEditDialog(group)}
          >
            <Eye className="h-4 w-4" />
          </Button>
          <Button
                        className="p-1"
            onClick={() => {
              setSelectedGroup(group);
              setDeleteDialogOpen(true);
            }}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between pb-4 border-b border-border mb-6">
        <div>
          <h1 className="text-xl font-semibold">Group Management</h1>
          <p className="text-sm text-muted-foreground">
            Manage user groups and access control
          </p>
        </div>
        <Button className="h-8" onClick={() => setCreateDialogOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Create Group
        </Button>
      </div>

      <Card className="p-6">
        <DataTable
          columns={columns}
          data={groups?.data ?? []}
          isLoading={isLoading}
          emptyMessage="No groups yet."
        />
      </Card>

      {/* Create Group Dialog */}
      <Dialog open={createDialogOpen} onClose={setCreateDialogOpen}>
        
          
            <DialogTitle>Create New Group</DialogTitle>
            <DialogDescription>
              Add a new group for organizing users
            </DialogDescription>
          
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Name *</Label>
              <Input
                id="name"
                value={createFormData.name}
                onChange={(e) =>
                  setCreateFormData({ ...createFormData, name: e.target.value })
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                value={createFormData.description}
                onChange={(e) =>
                  setCreateFormData({ ...createFormData, description: e.target.value })
                }
                rows={3}
              />
            </div>
          </div>
          <DialogActions>
            <Button color="zinc" className="h-8" onClick={() => setCreateDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              className="h-8"
              onClick={handleCreate}
              disabled={!createFormData.name || createGroup.isPending}
            >
              {createGroup.isPending ? 'Creating...' : 'Create'}
            </Button>
          </DialogActions>
        
      </Dialog>

      {/* Edit Group Dialog */}
      <Dialog open={editDialogOpen} onClose={setEditDialogOpen}>
        
          
            <DialogTitle>Edit Group</DialogTitle>
            <DialogDescription>
              Update group information
            </DialogDescription>
          
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="edit_name">Name</Label>
              <Input
                id="edit_name"
                value={editFormData.name}
                onChange={(e) =>
                  setEditFormData({ ...editFormData, name: e.target.value })
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit_description">Description</Label>
              <Textarea
                id="edit_description"
                value={editFormData.description}
                onChange={(e) =>
                  setEditFormData({ ...editFormData, description: e.target.value })
                }
                rows={3}
              />
            </div>
          </div>
          <DialogActions>
            <Button color="zinc" className="h-8" onClick={() => setEditDialogOpen(false)}>
              Cancel
            </Button>
            <Button className="h-8" onClick={handleEdit} disabled={updateGroup.isPending}>
              {updateGroup.isPending ? 'Saving...' : 'Save Changes'}
            </Button>
          </DialogActions>
        
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Alert open={deleteDialogOpen} onClose={setDeleteDialogOpen}>
        
          
            <AlertTitle>Are you sure?</AlertTitle>
            <AlertDescription>
              This will permanently delete the group &quot;{selectedGroup?.name}&quot;. This
              action cannot be undone.
            </AlertDescription>
          
          <AlertActions>
            <Button plain onClick={() => setSelectedGroup(null)}>
              Cancel
            </Button>
            <Button color="red"
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </Button>
          </AlertActions>
        
      </Alert>
    </div>
  );
}
