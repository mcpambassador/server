import { useState } from 'react';
import { CheckCircle2, AlertCircle } from 'lucide-react';
import { Heading } from '@/components/catalyst/heading';
import { Text } from '@/components/catalyst/text';
import { Button } from '@/components/catalyst/button';
import { Field, Label } from '@/components/catalyst/fieldset';
import { Input } from '@/components/catalyst/input';
import { InlineAlert, InlineAlertDescription } from '@/components/catalyst/inline-alert';
import { useProfile, useChangePassword } from '@/api/hooks/use-profile';
import { usePageTitle } from '@/hooks/usePageTitle';

export function Profile() {
  usePageTitle('Profile');
  const { data: user, isLoading } = useProfile();
  const changePassword = useChangePassword();

  const [passwordForm, setPasswordForm] = useState({
    current_password: '',
    new_password: '',
    confirm_password: '',
  });
  const [passwordError, setPasswordError] = useState('');
  const [passwordSuccess, setPasswordSuccess] = useState(false);

  const handlePasswordChange = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordError('');
    setPasswordSuccess(false);

    // Validation
    if (passwordForm.new_password.length < 8) {
      setPasswordError('New password must be at least 8 characters');
      return;
    }

    if (passwordForm.new_password !== passwordForm.confirm_password) {
      setPasswordError('New passwords do not match');
      return;
    }

    try {
      await changePassword.mutateAsync({
        current_password: passwordForm.current_password,
        new_password: passwordForm.new_password,
      });
      setPasswordSuccess(true);
      setPasswordForm({
        current_password: '',
        new_password: '',
        confirm_password: '',
      });
      setTimeout(() => setPasswordSuccess(false), 5000);
    } catch (error: any) {
      setPasswordError(error.message || 'Failed to change password');
    }
  };

  const getPasswordStrength = (password: string): string => {
    if (!password) return '';
    if (password.length < 8) return 'Weak';
    if (password.length < 12) return 'Medium';
    if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
      return 'Medium';
    }
    return 'Strong';
  };

  const passwordStrength = getPasswordStrength(passwordForm.new_password);
  const strengthColor =
    passwordStrength === 'Strong' ? 'text-green-600' :
    passwordStrength === 'Medium' ? 'text-yellow-600' : 'text-red-600';

  return (
    <div className="space-y-6">
      <div>
        <Heading>Profile</Heading>
        <Text>Manage your account settings and preferences</Text>
      </div>

      {/* User Information */}
      <div className="rounded-lg bg-white p-6 ring-1 ring-zinc-950/5">
        <h3 className="text-base/7 font-semibold text-zinc-900">User Information</h3>
        <p className="text-sm/6 text-zinc-500">Your account details</p>

        {isLoading ? (
          <div className="mt-4 space-y-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="space-y-2">
                <div className="h-4 w-24 animate-pulse rounded bg-zinc-200" />
                <div className="h-6 w-full animate-pulse rounded bg-zinc-200" />
              </div>
            ))}
          </div>
        ) : user ? (
          <dl className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
            <div>
              <dt className="text-sm/6 font-medium text-zinc-500">Username</dt>
              <dd className="text-sm/6 text-zinc-900">{user.username}</dd>
            </div>
            {user.displayName && (
              <div>
                <dt className="text-sm/6 font-medium text-zinc-500">Display Name</dt>
                <dd className="text-sm/6 text-zinc-900">{user.displayName}</dd>
              </div>
            )}
            {user.email && (
              <div>
                <dt className="text-sm/6 font-medium text-zinc-500">Email</dt>
                <dd className="text-sm/6 text-zinc-900">{user.email}</dd>
              </div>
            )}
            <div>
              <dt className="text-sm/6 font-medium text-zinc-500">Role</dt>
              <dd className="text-sm/6 text-zinc-900">{user.isAdmin ? 'Administrator' : 'User'}</dd>
            </div>
            <div>
              <dt className="text-sm/6 font-medium text-zinc-500">Account Created</dt>
              <dd className="text-sm/6 text-zinc-900">
                {new Date(user.createdAt).toLocaleDateString()}
              </dd>
            </div>
            {user.lastLoginAt && (
              <div>
                <dt className="text-sm/6 font-medium text-zinc-500">Last Login</dt>
                <dd className="text-sm/6 text-zinc-900">
                  {new Date(user.lastLoginAt).toLocaleString()}
                </dd>
              </div>
            )}
          </dl>
        ) : (
          <p className="mt-4 text-sm/6 text-zinc-500">Failed to load user information</p>
        )}
      </div>

      {/* Change Password */}
      <div className="rounded-lg bg-white p-6 ring-1 ring-zinc-950/5">
        <h3 className="text-base/7 font-semibold text-zinc-900">Change Password</h3>
        <p className="text-sm/6 text-zinc-500">Update your password to keep your account secure</p>

        <form onSubmit={handlePasswordChange} className="mt-4 space-y-4">
          {passwordSuccess && (
            <InlineAlert color="success">
              <CheckCircle2 className="h-4 w-4" />
              <InlineAlertDescription>
                Password changed successfully
              </InlineAlertDescription>
            </InlineAlert>
          )}

          {passwordError && (
            <InlineAlert color="error">
              <AlertCircle className="h-4 w-4" />
              <InlineAlertDescription>{passwordError}</InlineAlertDescription>
            </InlineAlert>
          )}

          <Field>
            <Label>Current Password</Label>
            <Input
              type="password"
              value={passwordForm.current_password}
              onChange={(e) =>
                setPasswordForm({ ...passwordForm, current_password: e.target.value })
              }
              required
            />
          </Field>

          <Field>
            <Label>New Password</Label>
            <Input
              type="password"
              value={passwordForm.new_password}
              onChange={(e) =>
                setPasswordForm({ ...passwordForm, new_password: e.target.value })
              }
              required
            />
            {passwordForm.new_password && (
              <p className={`text-sm ${strengthColor}`}>
                Password strength: {passwordStrength}
              </p>
            )}
          </Field>

          <Field>
            <Label>Confirm New Password</Label>
            <Input
              type="password"
              value={passwordForm.confirm_password}
              onChange={(e) =>
                setPasswordForm({ ...passwordForm, confirm_password: e.target.value })
              }
              required
            />
          </Field>

          <Button
            type="submit"
            disabled={
              !passwordForm.current_password ||
              !passwordForm.new_password ||
              !passwordForm.confirm_password ||
              changePassword.isPending
            }
          >
            {changePassword.isPending ? 'Changing...' : 'Change Password'}
          </Button>
        </form>
      </div>
    </div>
  );
}
