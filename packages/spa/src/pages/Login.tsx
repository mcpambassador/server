import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/catalyst/button';
import { Input } from '@/components/catalyst/input';
import { Field, Label } from '@/components/catalyst/fieldset';
import { Heading } from '@/components/catalyst/heading';
import { Text } from '@/components/catalyst/text';
import { authApi } from '@/api/auth';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '@/api/client';
import { useQuery } from '@tanstack/react-query';
import { Navigate } from 'react-router-dom';
import { setupApi } from '@/api/setup';
import { usePageTitle } from '@/hooks/usePageTitle';
import { Logomark } from '@/components/brand/Logomark';

export function Login() {
  usePageTitle('Login');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [username, setUsername] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState('');
  const [isLoading, setIsLoading] = React.useState(false);

  const { data: setupStatus, isLoading: setupLoading } = useQuery({
    queryKey: ['setup-status'],
    queryFn: setupApi.getStatus,
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });

  // Show nothing while checking setup status
  if (setupLoading) {
    return null;
  }

  // If setup is needed, redirect to /setup
  if (setupStatus?.needsSetup) {
    return <Navigate to="/setup" replace />;
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      const response = await authApi.login(username, password);
      queryClient.setQueryData(['session'], response);
      navigate('/app/dashboard');
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message || 'Invalid credentials');
      } else {
        setError('An unexpected error occurred');
      }
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-zinc-950 px-4 py-12 sm:px-6 lg:px-8">
      <div className="w-full max-w-sm space-y-10">
        <div>
          {/* Brand mark */}
          <div className="flex flex-col items-center gap-3">
              <div className="flex items-center gap-2">
                <Logomark className="h-10 w-10" />
                <div className="flex items-baseline gap-1">
                  <span className="font-mono text-xl font-bold text-violet-400">MCP</span>
                  <span className="text-xl font-semibold text-zinc-900 dark:text-white">Ambassador</span>
                </div>
              </div>
            <Text className="text-xs uppercase tracking-widest text-zinc-500">
              Protocol Gateway
            </Text>
          </div>
          <Heading className="mt-10 text-center text-2xl/9 font-bold tracking-tight text-zinc-900 dark:text-white">
            Sign in to your account
          </Heading>
        </div>
        <form className="space-y-6" onSubmit={handleSubmit}>
          <div className="space-y-4">
            <Field>
              <Label>Username</Label>
              <Input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                disabled={isLoading}
                autoComplete="username"
              />
            </Field>
            <Field>
              <Label>Password</Label>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                disabled={isLoading}
                autoComplete="current-password"
              />
            </Field>
          </div>

          {error && (
            <div className="rounded-md bg-red-50 dark:bg-red-950/50 px-3 py-2 text-sm text-red-600 dark:text-red-400">
              {error}
            </div>
          )}

          <div>
            <Button type="submit" color="dark/zinc" className="w-full" disabled={isLoading}>
              {isLoading ? 'Signing in...' : 'Sign in'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
