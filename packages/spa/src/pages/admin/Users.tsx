import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Eye, Trash2, Key } from 'lucide-react';
import { useToast } from '@/components/ui/toast';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
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
import { useAdminUsers, useCreateUser, useUpdateUser, useDeleteUser, useResetPassword } from '@/api/hooks/use-admin';
import type { AdminUser } from '@/api/types';

export function UsersAdmin() {
  const { data: usersData, isLoading } = useAdminUsers();
  const createUser = useCreateUser();
  const updateUser = useUpdateUser();
  const deleteUser = useDeleteUser();
  const resetPassword = useResetPassword();
  const { addToast } = useToast();

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
      addToast({ title: 'Create user failed', description: (error as Error)?.message ?? String(error), variant: 'destructive' });
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
      addToast({ title: 'Update user failed', description: (error as Error)?.message ?? String(error), variant: 'destructive' });
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
      addToast({ title: 'Reset password failed', description: (error as Error)?.message ?? String(error), variant: 'destructive' });
    }
  };

  const handleDelete = async () => {
    if (!selectedUser) return;
    try {
      await deleteUser.mutateAsync(selectedUser.user_id);
      setDeleteDialogOpen(false);
      setSelectedUser(null);
    } catch (error) {
      addToast({ title: 'Delete user failed', description: (error as Error)?.message ?? String(error), variant: 'destructive' });
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
        user.is_admin ? <Badge variant="default">Admin</Badge> : <Badge variant="outline">User</Badge>,
    },
    {
      header: 'Status',
      accessor: 'status',
      cell: (user) => (
        <Badge variant={user.status === 'active' ? 'default' : 'secondary'}>
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
          <Button variant="ghost" size="icon" asChild>
            <Link to={`/app/admin/users/${user.user_id}`}>
              <Eye className="h-4 w-4" />
            </Link>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => openEditDialog(user)}
          >
            <Eye className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              setSelectedUser(user);
              setResetDialogOpen(true);
            }}
          >
            <Key className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">User Management</h1>
          <p className="text-muted-foreground">
            Manage system users and permissions
          </p>
        </div>
        <Button onClick={() => setCreateDialogOpen(true)}>
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
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create New User</DialogTitle>
            <DialogDescription>
              Add a new user to the system
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="username">Username *</Label>
              <Input
                id="username"
                value={createFormData.username}
                onChange={(e) =>
                  setCreateFormData({ ...createFormData, username: e.target.value })
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password *</Label>
              <Input
                id="password"
                type="password"
                value={createFormData.password}
                onChange={(e) =>
                  setCreateFormData({ ...createFormData, password: e.target.value })
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="display_name">Display Name</Label>
              <Input
                id="display_name"
                value={createFormData.display_name}
                onChange={(e) =>
                  setCreateFormData({ ...createFormData, display_name: e.target.value })
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={createFormData.email}
                onChange={(e) =>
                  setCreateFormData({ ...createFormData, email: e.target.value })
                }
              />
            </div>
            <div className="flex items-center space-x-2">
              <Checkbox
                id="is_admin"
                checked={createFormData.is_admin}
                onCheckedChange={(checked) =>
                  setCreateFormData({ ...createFormData, is_admin: checked as boolean })
                }
              />
              <Label htmlFor="is_admin" className="cursor-pointer">
                Administrator
              </Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleCreate}
              disabled={
                !createFormData.username || !createFormData.password || createUser.isPending
              }
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit User Dialog */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit User</DialogTitle>
            <DialogDescription>
              Update user information and permissions
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="edit_display_name">Display Name</Label>
              <Input
                id="edit_display_name"
                value={editFormData.display_name}
                onChange={(e) =>
                  setEditFormData({ ...editFormData, display_name: e.target.value })
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit_email">Email</Label>
              <Input
                id="edit_email"
                type="email"
                value={editFormData.email}
                onChange={(e) =>
                  setEditFormData({ ...editFormData, email: e.target.value })
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit_status">Status</Label>
              <select
                id="edit_status"
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
            </div>
            <div className="flex items-center space-x-2">
              <Checkbox
                id="edit_is_admin"
                checked={editFormData.is_admin}
                onCheckedChange={(checked) =>
                  setEditFormData({ ...editFormData, is_admin: checked as boolean })
                }
              />
              <Label htmlFor="edit_is_admin" className="cursor-pointer">
                Administrator
              </Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleEdit} disabled={updateUser.isPending}>
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reset Password Dialog */}
      <Dialog open={resetDialogOpen} onOpenChange={setResetDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset Password</DialogTitle>
            <DialogDescription>
              Set a new password for {selectedUser?.username}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="new_password">New Password</Label>
              <Input
                id="new_password"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleResetPassword}
              disabled={!newPassword || resetPassword.isPending}
            >
              Reset Password
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you sure?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the user {selectedUser?.username}. This action
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setSelectedUser(null)}>
              Cancel
            </AlertDialogCancel>
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
