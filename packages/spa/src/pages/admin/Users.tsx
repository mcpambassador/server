import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Eye, Trash2, Key, Pencil } from 'lucide-react';
import { toast } from 'sonner';
import { Heading } from '@/components/catalyst/heading';
import { Text } from '@/components/catalyst/text';
import { Badge } from '@/components/catalyst/badge';
import { Button } from '@/components/catalyst/button';
import { Table, TableHead, TableBody, TableRow, TableHeader, TableCell } from '@/components/catalyst/table';
import { Dialog, DialogBody, DialogTitle, DialogDescription, DialogActions } from '@/components/catalyst/dialog';
import { Alert, AlertTitle, AlertDescription, AlertActions } from '@/components/catalyst/alert';
import { Input } from '@/components/catalyst/input';
import { Field, Label } from '@/components/catalyst/fieldset';
import { Checkbox, CheckboxField } from '@/components/catalyst/checkbox';
import { useAdminUsers, useCreateUser, useUpdateUser, useDeleteUser, useResetPassword } from '@/api/hooks/use-admin';
import type { AdminUser } from '@/api/types';
import { usePageTitle } from '@/hooks/usePageTitle';

export function UsersAdmin() {
  usePageTitle('Admin - Users');
  const { data: usersData, isLoading } = useAdminUsers();
  const createUser = useCreateUser();
  const updateUser = useUpdateUser();
  const deleteUser = useDeleteUser();
  const resetPassword = useResetPassword();

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedUser, setSelectedUser] = useState<AdminUser | null>(null);

  const [createFormData, setCreateFormData] = useState({
    username: '',
    password: '',
    display_name: '',
    email: '',
    is_admin: false,
  });

  const [editFormData, setEditFormData] = useState({
    display_name: '',
    email: '',
    is_admin: false,
    status: 'active' as 'active' | 'suspended',
  });

  const [newPassword, setNewPassword] = useState('');

  const handleCreate = async () => {
    try {
      await createUser.mutateAsync({
        username: createFormData.username,
        password: createFormData.password,
        display_name: createFormData.display_name || undefined,
        email: createFormData.email || undefined,
        is_admin: createFormData.is_admin,
      });
      setCreateDialogOpen(false);
      setCreateFormData({ username: '', password: '', display_name: '', email: '', is_admin: false });
    } catch (error) {
      toast.error('Create user failed', { description: (error as Error)?.message ?? String(error) });
    }
  };

  const handleEdit = async () => {
    if (!selectedUser) return;
    try {
      await updateUser.mutateAsync({
        userId: selectedUser.user_id,
        data: {
          display_name: editFormData.display_name || undefined,
          email: editFormData.email || undefined,
          is_admin: editFormData.is_admin,
          status: editFormData.status,
        },
      });
      setEditDialogOpen(false);
      setSelectedUser(null);
    } catch (error) {
      toast.error('Update user failed', { description: (error as Error)?.message ?? String(error) });
    }
  };

  const handleResetPassword = async () => {
    if (!selectedUser || !newPassword) return;
    try {
      await resetPassword.mutateAsync({
        userId: selectedUser.user_id,
        newPassword,
      });
      setResetDialogOpen(false);
      setSelectedUser(null);
      setNewPassword('');
    } catch (error) {
      toast.error('Reset password failed', { description: (error as Error)?.message ?? String(error) });
    }
  };

  const handleDelete = async () => {
    if (!selectedUser) return;
    try {
      await deleteUser.mutateAsync(selectedUser.user_id);
      setDeleteDialogOpen(false);
      setSelectedUser(null);
    } catch (error) {
      toast.error('Delete user failed', { description: (error as Error)?.message ?? String(error) });
    }
  };

  const openEditDialog = (user: AdminUser) => {
    setSelectedUser(user);
    setEditFormData({
      display_name: user.display_name || '',
      email: user.email || '',
      is_admin: user.is_admin,
      status: user.status,
    });
    setEditDialogOpen(true);
  };

  return (
    <div className="space-y-8">
      {/* Page Header */}
      <div className="flex items-end justify-between">
        <div>
          <Heading>User Management</Heading>
          <Text className="mt-1">Manage system users and permissions</Text>
        </div>
        <Button onClick={() => setCreateDialogOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Create User
        </Button>
      </div>

      {/* Table Section */}
      <div className="rounded-lg bg-white ring-1 ring-zinc-950/5">
        <Table>
          <TableHead>
            <TableRow>
              <TableHeader>Username</TableHeader>
              <TableHeader>Display Name</TableHeader>
              <TableHeader>Email</TableHeader>
              <TableHeader>Admin</TableHeader>
              <TableHeader>Status</TableHeader>
              <TableHeader>Created</TableHeader>
              <TableHeader>Last Login</TableHeader>
              <TableHeader>Actions</TableHeader>
            </TableRow>
          </TableHead>
          <TableBody>
            {isLoading ? (
              <>
                {[...Array(5)].map((_, i) => (
                  <TableRow key={i}>
                    <TableCell><div className="animate-pulse h-4 w-24 rounded bg-zinc-200" /></TableCell>
                    <TableCell><div className="animate-pulse h-4 w-32 rounded bg-zinc-200" /></TableCell>
                    <TableCell><div className="animate-pulse h-4 w-40 rounded bg-zinc-200" /></TableCell>
                    <TableCell><div className="animate-pulse h-5 w-16 rounded bg-zinc-200" /></TableCell>
                    <TableCell><div className="animate-pulse h-5 w-16 rounded bg-zinc-200" /></TableCell>
                    <TableCell><div className="animate-pulse h-4 w-20 rounded bg-zinc-200" /></TableCell>
                    <TableCell><div className="animate-pulse h-4 w-20 rounded bg-zinc-200" /></TableCell>
                    <TableCell><div className="animate-pulse h-4 w-24 rounded bg-zinc-200" /></TableCell>
                  </TableRow>
                ))}
              </>
            ) : usersData?.data && usersData.data.length > 0 ? (
              usersData.data.map((user) => (
                <TableRow key={user.user_id}>
                  <TableCell>
                    <Link
                      to={`/app/admin/users/${user.user_id}`}
                      className="font-medium text-zinc-900 hover:text-zinc-700"
                    >
                      {user.username}
                    </Link>
                  </TableCell>
                  <TableCell className="text-zinc-500">
                    {user.display_name || '—'}
                  </TableCell>
                  <TableCell className="text-zinc-500">
                    {user.email || '—'}
                  </TableCell>
                  <TableCell>
                    {user.is_admin ? (
                      <Badge color="blue">Admin</Badge>
                    ) : (
                      <Badge color="zinc">User</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {user.status === 'active' ? (
                      <Badge color="green">active</Badge>
                    ) : (
                      <Badge color="zinc">suspended</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-zinc-500">
                    {new Date(user.created_at).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="text-zinc-500">
                    {user.last_login_at ? new Date(user.last_login_at).toLocaleDateString() : '—'}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Button plain href={`/app/admin/users/${user.user_id}`}>
                        <Eye className="h-4 w-4" />
                      </Button>
                      <Button plain onClick={() => openEditDialog(user)}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        plain
                        onClick={() => {
                          setSelectedUser(user);
                          setResetDialogOpen(true);
                        }}
                      >
                        <Key className="h-4 w-4" />
                      </Button>
                      <Button
                        plain
                        onClick={() => {
                          setSelectedUser(user);
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
                <TableCell colSpan={8} className="text-center text-zinc-500 py-12">
                  No users yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Create User Dialog */}
      <Dialog open={createDialogOpen} onClose={setCreateDialogOpen}>
        <DialogTitle>Create New User</DialogTitle>
        <DialogDescription>
          Add a new user to the system
        </DialogDescription>
        <DialogBody>
          <div className="space-y-4">
            <Field>
              <Label>Username *</Label>
              <Input
                value={createFormData.username}
                onChange={(e) =>
                  setCreateFormData({ ...createFormData, username: e.target.value })
                }
              />
            </Field>
            <Field>
              <Label>Password *</Label>
              <Input
                type="password"
                value={createFormData.password}
                onChange={(e) =>
                  setCreateFormData({ ...createFormData, password: e.target.value })
                }
              />
            </Field>
            <Field>
              <Label>Display Name</Label>
              <Input
                value={createFormData.display_name}
                onChange={(e) =>
                  setCreateFormData({ ...createFormData, display_name: e.target.value })
                }
              />
            </Field>
            <Field>
              <Label>Email</Label>
              <Input
                type="email"
                value={createFormData.email}
                onChange={(e) =>
                  setCreateFormData({ ...createFormData, email: e.target.value })
                }
              />
            </Field>
            <CheckboxField>
              <Checkbox
                name="is_admin"
                checked={createFormData.is_admin}
                onChange={(checked) =>
                  setCreateFormData({ ...createFormData, is_admin: checked })
                }
              />
              <Label>Administrator</Label>
            </CheckboxField>
          </div>
        </DialogBody>
        <DialogActions>
          <Button plain onClick={() => setCreateDialogOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleCreate}
            disabled={
              !createFormData.username || !createFormData.password || createUser.isPending
            }
          >
            {createUser.isPending ? 'Creating...' : 'Create'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Edit User Dialog */}
      <Dialog open={editDialogOpen} onClose={setEditDialogOpen}>
        <DialogTitle>Edit User</DialogTitle>
        <DialogDescription>
          Update user information and permissions
        </DialogDescription>
        <DialogBody>
          <div className="space-y-4">
            <Field>
              <Label>Display Name</Label>
              <Input
                value={editFormData.display_name}
                onChange={(e) =>
                  setEditFormData({ ...editFormData, display_name: e.target.value })
                }
              />
            </Field>
            <Field>
              <Label>Email</Label>
              <Input
                type="email"
                value={editFormData.email}
                onChange={(e) =>
                  setEditFormData({ ...editFormData, email: e.target.value })
                }
              />
            </Field>
            <Field>
              <Label>Status</Label>
              <select
                value={editFormData.status}
                onChange={(e) =>
                  setEditFormData({
                    ...editFormData,
                    status: e.target.value as 'active' | 'suspended',
                  })
                }
                className="block w-full rounded-lg border-none bg-white py-1.5 px-3 text-sm/6 text-zinc-900 ring-1 ring-zinc-950/10 focus:ring-2 focus:ring-zinc-950/20"
              >
                <option value="active">Active</option>
                <option value="suspended">Suspended</option>
              </select>
            </Field>
            <CheckboxField>
              <Checkbox
                name="edit_is_admin"
                checked={editFormData.is_admin}
                onChange={(checked) =>
                  setEditFormData({ ...editFormData, is_admin: checked })
                }
              />
              <Label>Administrator</Label>
            </CheckboxField>
          </div>
        </DialogBody>
        <DialogActions>
          <Button plain onClick={() => setEditDialogOpen(false)}>
            Cancel
          </Button>
          <Button onClick={handleEdit} disabled={updateUser.isPending}>
            {updateUser.isPending ? 'Saving...' : 'Save Changes'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Reset Password Dialog */}
      <Dialog open={resetDialogOpen} onClose={setResetDialogOpen}>
        <DialogTitle>Reset Password</DialogTitle>
        <DialogDescription>
          Set a new password for {selectedUser?.username}
        </DialogDescription>
        <DialogBody>
          <Field>
            <Label>New Password</Label>
            <Input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </Field>
        </DialogBody>
        <DialogActions>
          <Button plain onClick={() => setResetDialogOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleResetPassword}
            disabled={!newPassword || resetPassword.isPending}
          >
            {resetPassword.isPending ? 'Resetting...' : 'Reset Password'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Delete Confirmation Alert */}
      <Alert open={deleteDialogOpen} onClose={setDeleteDialogOpen}>
        <AlertTitle>Are you sure?</AlertTitle>
        <AlertDescription>
          This will permanently delete the user {selectedUser?.username}. This action
          cannot be undone.
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
