import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PlusIcon, EyeIcon, PencilIcon, TrashIcon, UserGroupIcon } from '@heroicons/react/20/solid';
import { toast } from 'sonner';
import { Heading } from '@/components/catalyst/heading';
import { Text } from '@/components/catalyst/text';
import { Button } from '@/components/catalyst/button';
import { Badge } from '@/components/catalyst/badge';
import { Table, TableHead, TableBody, TableRow, TableHeader, TableCell } from '@/components/catalyst/table';
import { Dialog, DialogBody, DialogTitle, DialogDescription, DialogActions } from '@/components/catalyst/dialog';
import { Alert, AlertTitle, AlertDescription, AlertActions } from '@/components/catalyst/alert';
import { Input } from '@/components/catalyst/input';
import { Field, Label } from '@/components/catalyst/fieldset';
import { Textarea } from '@/components/catalyst/textarea';
import { useAdminGroups, useCreateGroup, useUpdateGroup, useDeleteGroup } from '@/api/hooks/use-admin';
import type { Group } from '@/api/types';
import { usePageTitle } from '@/hooks/usePageTitle';
import { EmptyState } from '@/components/shared/EmptyState';

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
          <PlusIcon data-slot="icon" />
          Create Group
        </Button>
      </div>

      {/* Table */}
      <div className="rounded-lg bg-white dark:bg-white/5 ring-1 ring-zinc-950/10 dark:ring-white/10">
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
                      <div className="animate-pulse h-4 w-32 rounded bg-zinc-200 dark:bg-zinc-700" />
                    </TableCell>
                    <TableCell>
                      <div className="animate-pulse h-4 w-48 rounded bg-zinc-200 dark:bg-zinc-700" />
                    </TableCell>
                    <TableCell>
                      <div className="animate-pulse h-4 w-24 rounded bg-zinc-200 dark:bg-zinc-700" />
                    </TableCell>
                    <TableCell>
                      <div className="animate-pulse h-4 w-24 rounded bg-zinc-200 dark:bg-zinc-700" />
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <div className="animate-pulse h-8 w-8 rounded bg-zinc-200 dark:bg-zinc-700" />
                        <div className="animate-pulse h-8 w-8 rounded bg-zinc-200 dark:bg-zinc-700" />
                        <div className="animate-pulse h-8 w-8 rounded bg-zinc-200 dark:bg-zinc-700" />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </>
            ) : groups?.data && groups.data.length > 0 ? (
              groups.data.map((group) => (
                <TableRow key={group.group_id}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Link
                        to={`/app/admin/groups/${group.group_id}`}
                        className="font-medium text-zinc-900 dark:text-white hover:text-zinc-700 dark:hover:text-zinc-300"
                      >
                        {group.name}
                      </Link>
                      {(group.is_system || group.created_by === 'system' || group.name === 'all-users') && (
                        <Badge color="purple" title="Auto-created system group. All users are assigned by default.">System</Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-zinc-500 dark:text-zinc-400">
                    {group.description || '—'}
                  </TableCell>
                  <TableCell className="text-zinc-500 dark:text-zinc-400">
                    {new Date(group.created_at).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="text-zinc-500 dark:text-zinc-400">
                    {new Date(group.updated_at).toLocaleDateString()}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Button plain title="View group" href={`/app/admin/groups/${group.group_id}`}>
                        <EyeIcon />
                      </Button>
                      <Button plain title="Edit group" onClick={() => openEditDialog(group)}>
                        <PencilIcon />
                      </Button>
                      <Button
                        plain
                        title="Delete group"
                        onClick={() => {
                          setSelectedGroup(group);
                          setDeleteDialogOpen(true);
                        }}
                      >
                        <TrashIcon />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={5}>
                  <EmptyState
                    icon={<UserGroupIcon className="size-6 text-zinc-400" />}
                    title="No groups found"
                    description="Create groups to organize users and manage MCP access."
                    action={{
                      label: 'Create Group',
                      onClick: () => setCreateDialogOpen(true),
                    }}
                  />
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
