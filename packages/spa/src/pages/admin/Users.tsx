import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Eye, Trash2, Key } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/catalyst/card';
import { Button } from '@/components/catalyst/button';
import { Badge } from '@/components/catalyst/badge';
import { Dialog, DialogDescription, DialogActions,  DialogTitle } from '@/components/catalyst/dialog';
import { Input } from '@/components/catalyst/input';
import { Field, Label } from '@/components/catalyst/fieldset';
import { Checkbox, CheckboxField } from '@/components/catalyst/checkbox';
import {
  Alert,
  AlertDescription,
  AlertActions,
  AlertTitle,
} from '@/components/catalyst/alert';
import { DataTable, type ColumnDef } from '@/components/data/DataTable';
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

  const columns: ColumnDef<AdminUser>[] = [
    {
      header: 'Username',
      accessor: 'username',
      cell: (user) => (
        <Link
          to={`/app/admin/users/${user.user_id}`}
          className="font-medium hover:underline"
        >
          {user.username}
        </Link>
      ),
    },
    {
      header: 'Display Name',
      accessor: 'display_name',
      cell: (user) => user.display_name || '—',
    },
    {
      header: 'Email',
      accessor: 'email',
      cell: (user) => user.email || '—',
    },
    {
      header: 'Admin',
      accessor: 'is_admin',
      cell: (user) =>
        user.is_admin ? <Badge color="teal">Admin</Badge> : <Badge color="zinc">User</Badge>,
    },
    {
      header: 'Status',
      accessor: 'status',
      cell: (user) => (
        <Badge color={user.status === 'active' ? 'emerald' : 'zinc'}>
          {user.status}
        </Badge>
      ),
    },
    {
      header: 'Created',
      accessor: 'created_at',
      cell: (user) => new Date(user.created_at).toLocaleDateString(),
    },
    {
      header: 'Last Login',
      accessor: 'last_login_at',
      cell: (user) =>
        user.last_login_at ? new Date(user.last_login_at).toLocaleDateString() : '—',
    },
    {
      header: 'Actions',
      accessor: 'user_id',
      cell: (user) => (
        <div className="flex items-center gap-2">
          <Button plain className="p-1" href={`/app/admin/users/${user.user_id}`}>
            <Eye className="h-4 w-4" />
          </Button>
          <Button
                        className="p-1"
            onClick={() => openEditDialog(user)}
          >
            <Eye className="h-4 w-4" />
          </Button>
          <Button
                        className="p-1"
            onClick={() => {
              setSelectedUser(user);
              setResetDialogOpen(true);
            }}
          >
            <Key className="h-4 w-4" />
          </Button>
          <Button
                        className="p-1"
            onClick={() => {
              setSelectedUser(user);
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
          <h1 className="text-xl font-semibold">User Management</h1>
          <p className="text-sm text-muted-foreground">
            Manage system users and permissions
          </p>
        </div>
        <Button className="h-8" onClick={() => setCreateDialogOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Create User
        </Button>
      </div>

      <Card className="p-6">
        <DataTable
          columns={columns}
          data={usersData?.data ?? []}
          isLoading={isLoading}
          emptyMessage="No users yet."
        />
      </Card>

      {/* Create User Dialog */}
      <Dialog open={createDialogOpen} onClose={setCreateDialogOpen}>
        
          
            <DialogTitle>Create New User</DialogTitle>
            <DialogDescription>
              Add a new user to the system
            </DialogDescription>
          
          <div className="space-y-4">
            <Field className="space-y-2">
              <Label>Username *</Label>
              <Input
                value={createFormData.username}
                onChange={(e) =>
                  setCreateFormData({ ...createFormData, username: e.target.value })
                }
              />
            </Field>
            <Field className="space-y-2">
              <Label>Password *</Label>
              <Input
                type="password"
                value={createFormData.password}
                onChange={(e) =>
                  setCreateFormData({ ...createFormData, password: e.target.value })
                }
              />
            </Field>
            <Field className="space-y-2">
              <Label>Display Name</Label>
              <Input
                value={createFormData.display_name}
                onChange={(e) =>
                  setCreateFormData({ ...createFormData, display_name: e.target.value })
                }
              />
            </Field>
            <Field className="space-y-2">
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
              <Label className="cursor-pointer">
                Administrator
              </Label>
            </CheckboxField>
          </div>
          <DialogActions>
            <Button color="zinc" className="h-8" onClick={() => setCreateDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              className="h-8"
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
          
          <div className="space-y-4">
            <Field className="space-y-2">
              <Label>Display Name</Label>
              <Input
                value={editFormData.display_name}
                onChange={(e) =>
                  setEditFormData({ ...editFormData, display_name: e.target.value })
                }
              />
            </Field>
            <Field className="space-y-2">
              <Label>Email</Label>
              <Input
                type="email"
                value={editFormData.email}
                onChange={(e) =>
                  setEditFormData({ ...editFormData, email: e.target.value })
                }
              />
            </Field>
            <Field className="space-y-2">
              <Label>Status</Label>
              <select
                value={editFormData.status}
                onChange={(e) =>
                  setEditFormData({
                    ...editFormData,
                    status: e.target.value as 'active' | 'suspended',
                  })
                }
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
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
              <Label className="cursor-pointer">
                Administrator
              </Label>
            </CheckboxField>
          </div>
          <DialogActions>
            <Button color="zinc" className="h-8" onClick={() => setEditDialogOpen(false)}>
              Cancel
            </Button>
            <Button className="h-8" onClick={handleEdit} disabled={updateUser.isPending}>
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
          
          <div className="space-y-4">
            <Field className="space-y-2">
              <Label>New Password</Label>
              <Input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </Field>
          </div>
          <DialogActions>
            <Button color="zinc" className="h-8" onClick={() => setResetDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              className="h-8"
              onClick={handleResetPassword}
              disabled={!newPassword || resetPassword.isPending}
            >
              {resetPassword.isPending ? 'Resetting...' : 'Reset Password'}
            </Button>
          </DialogActions>
        
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Alert open={deleteDialogOpen} onClose={setDeleteDialogOpen}>
        
          
            <AlertTitle>Are you sure?</AlertTitle>
            <AlertDescription>
              This will permanently delete the user {selectedUser?.username}. This action
              cannot be undone.
            </AlertDescription>
          
          <AlertActions>
            <Button plain onClick={() => setSelectedUser(null)}>
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
