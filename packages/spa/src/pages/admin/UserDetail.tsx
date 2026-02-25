import { useParams } from 'react-router-dom';
import { useState } from 'react';
import { ArrowLeftIcon, ShieldCheckIcon, KeyIcon, UserIcon } from '@heroicons/react/20/solid';
import { Heading } from '@/components/catalyst/heading';
import { Text } from '@/components/catalyst/text';
import { Badge } from '@/components/catalyst/badge';
import { Button } from '@/components/catalyst/button';
import { Divider } from '@/components/catalyst/divider';
import { useAdminUser, useAdminUserGroups, useAuditEvents } from '@/api/hooks/use-admin';
import { useUpdateUser, useResetPassword } from '@/api/hooks/use-admin';
import { toast } from 'sonner';
import { Dialog, DialogBody, DialogTitle, DialogDescription, DialogActions } from '@/components/catalyst/dialog';
import { Field, Label } from '@/components/catalyst/fieldset';
import { Input } from '@/components/catalyst/input';
import { Checkbox, CheckboxField } from '@/components/catalyst/checkbox';
import { usePageTitle } from '@/hooks/usePageTitle';
import { Breadcrumb } from '@/components/shared/Breadcrumb';

export function UserDetail() {
  const { userId } = useParams<{ userId: string }>();
  const { data: user, isLoading: userLoading } = useAdminUser(userId!);
  usePageTitle(user ? `Admin - ${user.username}` : 'Admin - User Details');
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editFormData, setEditFormData] = useState<{ display_name: string; email: string; is_admin: boolean }>({
    display_name: '',
    email: '',
    is_admin: false,
  });
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [newPassword, setNewPassword] = useState('');

  const updateUser = useUpdateUser();
  const resetPassword = useResetPassword();
  const { data: userGroups = [], isLoading: groupsLoading } = useAdminUserGroups(userId!);
  const { data: auditData, isLoading: auditLoading } = useAuditEvents({
    user_id: userId,
    limit: 20,
  });

  if (userLoading) {
    return (
      <div className="space-y-6">
        <div className="animate-pulse h-8 w-64 rounded bg-zinc-200 dark:bg-zinc-700" />
        <div className="animate-pulse h-48 w-full rounded bg-zinc-200 dark:bg-zinc-700" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="space-y-6">
        <Button plain href="/app/admin/users">
          <ArrowLeftIcon data-slot="icon" />
          Back to Users
        </Button>
        <div className="rounded-lg bg-white dark:bg-white/5 ring-1 ring-zinc-950/10 dark:ring-white/10 p-8 text-center">
          <Heading level={3}>User Not Found</Heading>
          <Text className="mt-2">The requested user could not be found.</Text>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Breadcrumb */}
      <Breadcrumb
        items={[
          { label: 'Users', href: '/app/admin/users' },
          { label: user.username },
        ]}
      />

      {/* Header */}
      <div>
        <div className="flex items-start justify-between">
          <div>
            <Heading>{user.username}</Heading>
            <Text className="mt-1">{user.display_name || 'No display name'}</Text>
          </div>
          <div className="flex items-center gap-2">
            {user.is_admin && (
              <Badge color="blue">
                <ShieldCheckIcon data-slot="icon" />
                Admin
              </Badge>
            )}
            <Badge color={user.status === 'active' ? 'green' : 'zinc'}>
              {user.status}
            </Badge>
          </div>
        </div>
      </div>

      {/* User Information */}
      <div className="rounded-lg bg-white dark:bg-white/5 ring-1 ring-zinc-950/10 dark:ring-white/10">
        <div className="px-6 py-4 border-b border-zinc-950/5 dark:border-white/10">
          <Heading level={2}>User Information</Heading>
        </div>
        <div className="px-6 py-6">
          <dl className="grid gap-6 sm:grid-cols-2">
            <div>
              <dt className="text-sm font-medium text-zinc-500 dark:text-zinc-400">User ID</dt>
              <dd className="mt-1 text-sm text-zinc-900 dark:text-white">
                <Text className="font-mono">{user.user_id}</Text>
              </dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Username</dt>
              <dd className="mt-1 text-sm text-zinc-900 dark:text-white">{user.username}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Email</dt>
              <dd className="mt-1 text-sm text-zinc-900 dark:text-white">{user.email || '—'}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Display Name</dt>
              <dd className="mt-1 text-sm text-zinc-900 dark:text-white">{user.display_name || '—'}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Created</dt>
              <dd className="mt-1 text-sm text-zinc-900 dark:text-white">
                {new Date(user.created_at).toLocaleString()}
              </dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Last Login</dt>
              <dd className="mt-1 text-sm text-zinc-900 dark:text-white">
                {user.last_login_at ? new Date(user.last_login_at).toLocaleString() : '—'}
              </dd>
            </div>
          </dl>
          <Divider className="my-6" />
          <div className="flex gap-2">
            <Button color="zinc" onClick={() => setResetDialogOpen(true)}>
              <KeyIcon data-slot="icon" />
              Reset Password
            </Button>
            <Button
              color="zinc"
              onClick={() => {
                setEditFormData({
                  display_name: user.display_name || '',
                  email: user.email || '',
                  is_admin: Boolean(user.is_admin),
                });
                setEditDialogOpen(true);
              }}
            >
              <UserIcon data-slot="icon" />
              Edit User
            </Button>
          </div>
        </div>
      </div>

      {/* Group Memberships */}
      <div className="rounded-lg bg-white dark:bg-white/5 ring-1 ring-zinc-950/10 dark:ring-white/10">
        <div className="px-6 py-4 border-b border-zinc-950/5 dark:border-white/10">
          <Heading level={2}>Group Memberships</Heading>
          <Text className="mt-1">Groups this user belongs to</Text>
        </div>
        <div className="px-6 py-6">
          {groupsLoading ? (
            <div className="space-y-2">
              <div className="animate-pulse h-16 w-full rounded bg-zinc-200 dark:bg-zinc-700" />
              <div className="animate-pulse h-16 w-full rounded bg-zinc-200 dark:bg-zinc-700" />
            </div>
          ) : userGroups.length > 0 ? (
            <div className="space-y-3">
              {userGroups.map((group: any) => (
                <div
                  key={group.group_id}
                  className="flex items-center justify-between rounded-lg border border-zinc-950/5 dark:border-white/10 p-4"
                >
                  <div>
                    <Text className="font-medium text-zinc-900 dark:text-white">{group.name}</Text>
                    <Text className="text-sm text-zinc-500 dark:text-zinc-400">{group.description}</Text>
                  </div>
                  <Button color="zinc" href={`/app/admin/groups/${group.group_id}`}>
                    View
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <Text className="text-zinc-500 dark:text-zinc-400">Not a member of any groups</Text>
          )}
        </div>
      </div>

      {/* Recent Activity */}
      <div className="rounded-lg bg-white dark:bg-white/5 ring-1 ring-zinc-950/10 dark:ring-white/10">
        <div className="px-6 py-4 border-b border-zinc-950/5 dark:border-white/10">
          <Heading level={2}>Recent Activity</Heading>
          <Text className="mt-1">Audit log entries for this user</Text>
        </div>
        <div className="px-6 py-6">
          {auditLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="animate-pulse h-16 w-full rounded bg-zinc-200 dark:bg-zinc-700" />
              ))}
            </div>
          ) : auditData && auditData.data.length > 0 ? (
            <div className="divide-y divide-zinc-950/5 dark:divide-white/10">
              {auditData.data.map((event) => (
                <div key={event.event_id} className="py-4 first:pt-0 last:pb-0">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <Text className="font-medium text-zinc-900 dark:text-white">{event.action}</Text>
                      <Text className="text-sm text-zinc-500 dark:text-zinc-400">
                        {event.event_type} • {event.source_ip}
                      </Text>
                    </div>
                    <div className="ml-4 text-right">
                      <Badge
                        color={
                          event.severity === 'error'
                            ? 'red'
                            : event.severity === 'warn'
                            ? 'amber'
                            : 'zinc'
                        }
                      >
                        {event.severity}
                      </Badge>
                      <Text className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                        {new Date(event.timestamp).toLocaleString()}
                      </Text>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <Text className="text-zinc-500 dark:text-zinc-400">No recent activity</Text>
          )}
        </div>
      </div>

      {/* Edit User Dialog */}
      <Dialog open={editDialogOpen} onClose={setEditDialogOpen}>
        <DialogBody>
          <DialogTitle>Edit User</DialogTitle>
          <DialogDescription>Update user information</DialogDescription>
          <div className="space-y-4 mt-4">
            <Field>
              <Label>Display Name</Label>
              <Input
                value={editFormData.display_name}
                onChange={(e) => setEditFormData({ ...editFormData, display_name: e.target.value })}
              />
            </Field>
            <Field>
              <Label>Email</Label>
              <Input value={editFormData.email} onChange={(e) => setEditFormData({ ...editFormData, email: e.target.value })} />
            </Field>
            <CheckboxField>
              <Checkbox
                name="is_admin"
                checked={editFormData.is_admin}
                onChange={(checked) => setEditFormData({ ...editFormData, is_admin: checked })}
              />
              <Label>Administrator</Label>
            </CheckboxField>
          </div>
          <DialogActions>
            <Button plain onClick={() => setEditDialogOpen(false)}>Cancel</Button>
            <Button
              onClick={async () => {
                try {
                  await updateUser.mutateAsync({ userId: user.user_id, data: {
                    display_name: editFormData.display_name || undefined,
                    email: editFormData.email || undefined,
                    is_admin: editFormData.is_admin,
                  } });
                  toast.success('User updated');
                  setEditDialogOpen(false);
                } catch (error) {
                  toast.error('Failed to update user', { description: (error as Error)?.message ?? String(error) });
                }
              }}
              disabled={updateUser.isPending}
            >
              {updateUser.isPending ? 'Saving...' : 'Save Changes'}
            </Button>
          </DialogActions>
        </DialogBody>
      </Dialog>

      {/* Reset Password Dialog */}
      <Dialog open={resetDialogOpen} onClose={setResetDialogOpen}>
        <DialogBody>
          <DialogTitle>Reset Password</DialogTitle>
          <DialogDescription>Set a new password for {user.username}. They will need to use this password to log in.</DialogDescription>
          <div className="space-y-4 mt-4">
            <Field>
              <Label>New Password</Label>
              <Input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
            </Field>
          </div>
          <DialogActions>
            <Button plain onClick={() => { setResetDialogOpen(false); setNewPassword(''); }}>Cancel</Button>
            <Button
              color="amber"
              onClick={async () => {
                try {
                  await resetPassword.mutateAsync({ userId: user.user_id, newPassword });
                  toast.success('Password reset');
                  setResetDialogOpen(false);
                  setNewPassword('');
                } catch (error) {
                  toast.error('Failed to reset password', { description: (error as Error)?.message ?? String(error) });
                }
              }}
              disabled={resetPassword.isPending || !newPassword}
            >
              {resetPassword.isPending ? 'Resetting...' : 'Reset Password'}
            </Button>
          </DialogActions>
        </DialogBody>
      </Dialog>
    </div>
  );
}
