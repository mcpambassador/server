import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/catalyst/button';
import { Input } from '@/components/catalyst/input';
import { Label } from '@/components/catalyst/fieldset';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { authApi } from '@/api/auth';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '@/api/client';
import { usePageTitle } from '@/hooks/usePageTitle';

export function Login() {
  usePageTitle('Login');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [username, setUsername] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState('');
  const [isLoading, setIsLoading] = React.useState(false);

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
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md border-border">
        <CardHeader className="space-y-4">
          <div className="flex flex-col items-center gap-3">
            {/* Brand mark */}
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary">
                <span className="font-mono text-base font-bold text-primary-foreground">M</span>
              </div>
              <div className="flex items-baseline gap-1">
                <span className="font-mono text-lg font-bold text-primary">MCP</span>
                <span className="text-lg font-semibold">Ambassador</span>
              </div>
            </div>
            <p className="text-xs uppercase tracking-widest text-muted-foreground">
              Protocol Gateway
            </p>
          </div>
          <CardTitle className="text-xl text-center">Welcome back</CardTitle>
          <CardDescription className="text-center">
            Enter your credentials to access your account
          </CardDescription>
        </CardHeader>
        <form onSubmit={handleSubmit}>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="username">Username</Label>
              <Input
                id="username"
                type="text"
                placeholder="Enter your username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                disabled={isLoading}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                placeholder="Enter your password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                disabled={isLoading}
              />
            </div>
            {error && (
              <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                {error}
              </div>
            )}
          </CardContent>
          <CardFooter>
            <Button type="submit" className="w-full" disabled={isLoading}>
              {isLoading ? 'Signing in...' : 'Sign in'}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
