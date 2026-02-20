import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Eye, Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Heading } from '@/components/catalyst/heading';
import { Text } from '@/components/catalyst/text';
import { Button } from '@/components/catalyst/button';
import { Table, TableHead, TableBody, TableRow, TableHeader, TableCell } from '@/components/catalyst/table';
import { Dialog, DialogBody, DialogTitle, DialogDescription, DialogActions } from '@/components/catalyst/dialog';
import { Alert, AlertTitle, AlertDescription, AlertActions } from '@/components/catalyst/alert';
import { Input } from '@/components/catalyst/input';
import { Field, Label } from '@/components/catalyst/fieldset';
import { Textarea } from '@/components/catalyst/textarea';
import { useAdminGroups, useCreateGroup, useUpdateGroup, useDeleteGroup } from '@/api/hooks/use-admin';
import type { Group } from '@/api/types';
import { usePageTitle } from '@/hooks/usePageTitle';

export function GroupsAdmin() {
  usePageTitle('Admin - Groups');
  const { data: groups, isLoading } = useAdminGroups();
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
      toast.error('Create group failed', { description: (error as Error)?.message ?? String(error) });
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
      toast.error('Update group failed', { description: (error as Error)?.message ?? String(error) });
    }
  };

  const handleDelete = async () => {
    if (!selectedGroup) return;
    try {
      await deleteGroup.mutateAsync(selectedGroup.group_id);
      setDeleteDialogOpen(false);
      setSelectedGroup(null);
    } catch (error) {
      toast.error('Delete group failed', { description: (error as Error)?.message ?? String(error) });
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

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <Heading>Group Management</Heading>
          <Text>Manage user groups and access control</Text>
        </div>
        <Button onClick={() => setCreateDialogOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Create Group
        </Button>
      </div>

      {/* Table */}
      <div className="rounded-lg bg-white ring-1 ring-zinc-950/5">
        <Table>
          <TableHead>
            <TableRow>
              <TableHeader>Name</TableHeader>
              <TableHeader>Description</TableHeader>
              <TableHeader>Created</TableHeader>
              <TableHeader>Updated</TableHeader>
              <TableHeader>Actions</TableHeader>
            </TableRow>
          </TableHead>
          <TableBody>
            {isLoading ? (
              <>
                {Array.from({ length: 3 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell>
                      <div className="animate-pulse h-4 w-32 rounded bg-zinc-200" />
                    </TableCell>
                    <TableCell>
                      <div className="animate-pulse h-4 w-48 rounded bg-zinc-200" />
                    </TableCell>
                    <TableCell>
                      <div className="animate-pulse h-4 w-24 rounded bg-zinc-200" />
                    </TableCell>
                    <TableCell>
                      <div className="animate-pulse h-4 w-24 rounded bg-zinc-200" />
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <div className="animate-pulse h-8 w-8 rounded bg-zinc-200" />
                        <div className="animate-pulse h-8 w-8 rounded bg-zinc-200" />
                        <div className="animate-pulse h-8 w-8 rounded bg-zinc-200" />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </>
            ) : groups?.data && groups.data.length > 0 ? (
              groups.data.map((group) => (
                <TableRow key={group.group_id}>
                  <TableCell>
                    <Link
                      to={`/app/admin/groups/${group.group_id}`}
                      className="font-medium text-zinc-900 hover:text-zinc-700"
                    >
                      {group.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-zinc-500">
                    {group.description || '—'}
                  </TableCell>
                  <TableCell className="text-zinc-500">
                    {new Date(group.created_at).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="text-zinc-500">
                    {new Date(group.updated_at).toLocaleDateString()}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Button plain href={`/app/admin/groups/${group.group_id}`}>
                        <Eye className="h-4 w-4" />
                      </Button>
                      <Button plain onClick={() => openEditDialog(group)}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        plain
                        onClick={() => {
                          setSelectedGroup(group);
                          setDeleteDialogOpen(true);
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-zinc-500">
                  No groups yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Create Group Dialog */}
      <Dialog open={createDialogOpen} onClose={setCreateDialogOpen}>
        <DialogTitle>Create New Group</DialogTitle>
        <DialogDescription>
          Add a new group for organizing users
        </DialogDescription>
        <DialogBody>
          <div className="space-y-4">
            <Field>
              <Label>Name *</Label>
              <Input
                value={createFormData.name}
                onChange={(e) =>
                  setCreateFormData({ ...createFormData, name: e.target.value })
                }
              />
            </Field>
            <Field>
              <Label>Description</Label>
              <Textarea
                value={createFormData.description}
                onChange={(e) =>
                  setCreateFormData({ ...createFormData, description: e.target.value })
                }
                rows={3}
              />
            </Field>
          </div>
        </DialogBody>
        <DialogActions>
          <Button plain onClick={() => setCreateDialogOpen(false)}>
            Cancel
          </Button>
          <Button
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
        <DialogBody>
          <div className="space-y-4">
            <Field>
              <Label>Name</Label>
              <Input
                value={editFormData.name}
                onChange={(e) =>
                  setEditFormData({ ...editFormData, name: e.target.value })
                }
              />
            </Field>
            <Field>
              <Label>Description</Label>
              <Textarea
                value={editFormData.description}
                onChange={(e) =>
                  setEditFormData({ ...editFormData, description: e.target.value })
                }
                rows={3}
              />
            </Field>
          </div>
        </DialogBody>
        <DialogActions>
          <Button plain onClick={() => setEditDialogOpen(false)}>
            Cancel
          </Button>
          <Button onClick={handleEdit} disabled={updateGroup.isPending}>
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
          <Button plain onClick={() => setDeleteDialogOpen(false)}>
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
