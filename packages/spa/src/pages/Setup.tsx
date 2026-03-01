import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient, useQuery } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { Button } from '@/components/catalyst/button';
import { Input } from '@/components/catalyst/input';
import { Field, Label, Description } from '@/components/catalyst/fieldset';
import { Heading } from '@/components/catalyst/heading';
import { Text } from '@/components/catalyst/text';
import { setupApi } from '@/api/setup';
import { ApiError } from '@/api/client';
import { usePageTitle } from '@/hooks/usePageTitle';
import { Logomark } from '@/components/brand/Logomark';
import { toast } from 'sonner';

type FormValues = {
  username: string;
  password: string;
  confirmPassword: string;
  displayName: string;
  email?: string;
};

export function Setup() {
  usePageTitle('Setup');
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const {
    data: setupStatus,
    isLoading: setupLoading,
    isError: setupError,
    refetch: refetchSetup,
  } = useQuery({
    queryKey: ['setup-status'],
    queryFn: setupApi.getStatus,
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });

  React.useEffect(() => {
    if (!setupLoading && setupStatus && !setupStatus.needsSetup) {
      navigate('/login', { replace: true });
    }
  }, [setupLoading, setupStatus, navigate]);

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ mode: 'onTouched' });

  const password = React.useRef('');
  password.current = watch('password', '');

  const onSubmit = async (values: FormValues) => {
    try {
      const response = await setupApi.createAdmin({
        username: values.username,
        password: values.password,
        display_name: values.displayName,
        email: values.email?.trim() || undefined,
      });

      queryClient.setQueryData(['session'], response);
      navigate('/app/dashboard');
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'SETUP_COMPLETE') {
          toast.error('Setup has already been completed');
          navigate('/login');
          return;
        }

        if (err.code === 'SETUP_CONFLICT') {
          // show inline error banner
          toast.error('Another administrator was created while you were completing setup');
          return;
        }

        toast.error(err.message || 'An error occurred');
      } else {
        toast.error('An unexpected error occurred');
      }
    }
  };

  if (setupLoading) {
    return null;
  }

  if (setupError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-zinc-950 px-4">
        <div className="w-full max-w-sm space-y-4 rounded-lg border border-red-200 bg-red-50 p-6 dark:border-red-800 dark:bg-red-950">
          <Heading className="text-lg font-semibold text-red-800 dark:text-red-200">
            Unable to load setup status
          </Heading>
          <Text className="text-sm text-red-700 dark:text-red-300">
            Could not contact the server. Please check your connection and try again.
          </Text>
          <Button color="dark/zinc" onClick={() => refetchSetup()}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

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
          </div>

          <Heading className="mt-10 text-center text-2xl/9 font-bold tracking-tight text-zinc-900 dark:text-white">
            Welcome to MCP Ambassador
          </Heading>
          <Text className="mt-2 text-center text-sm text-zinc-600 dark:text-zinc-400">
            Create your administrator account to get started
          </Text>
        </div>

        <form className="space-y-6" onSubmit={handleSubmit(onSubmit)} noValidate>
          <div className="space-y-4">
            <Field>
              <Label>Username</Label>
              <Description className="text-xs">Letters, numbers, hyphens, and underscores only</Description>
              <Input
                type="text"
                {...register('username', {
                  required: 'Username is required',
                  minLength: { value: 3, message: 'Username must be at least 3 characters' },
                  maxLength: { value: 255, message: 'Username is too long' },
                  pattern: {
                    value: /^[a-zA-Z0-9_-]+$/,
                    message: 'Username may only contain letters, numbers, hyphens, and underscores',
                  },
                })}
                disabled={isSubmitting}
                autoComplete="username"
              />
              {errors.username && (
                <div className="mt-1 text-sm text-red-600 dark:text-red-400">{errors.username.message}</div>
              )}
            </Field>

            <Field>
              <Label>Password</Label>
              <Input
                type="password"
                {...register('password', {
                  required: 'Password is required',
                  minLength: { value: 8, message: 'Password must be at least 8 characters' },
                  maxLength: { value: 128, message: 'Password is too long' },
                })}
                disabled={isSubmitting}
                autoComplete="new-password"
              />
              {errors.password && (
                <div className="mt-1 text-sm text-red-600 dark:text-red-400">{errors.password.message}</div>
              )}
            </Field>

            <Field>
              <Label>Confirm Password</Label>
              <Input
                type="password"
                {...register('confirmPassword', {
                  required: 'Please confirm your password',
                  validate: (value) => value === password.current || 'Passwords do not match',
                })}
                disabled={isSubmitting}
                autoComplete="new-password"
              />
              {errors.confirmPassword && (
                <div className="mt-1 text-sm text-red-600 dark:text-red-400">{errors.confirmPassword.message}</div>
              )}
            </Field>

            <Field>
              <Label>Display Name</Label>
              <Input
                type="text"
                {...register('displayName', {
                  required: 'Display name is required',
                  minLength: { value: 1, message: 'Display name is required' },
                  maxLength: { value: 255, message: 'Display name is too long' },
                })}
                disabled={isSubmitting}
                autoComplete="name"
              />
              {errors.displayName && (
                <div className="mt-1 text-sm text-red-600 dark:text-red-400">{errors.displayName.message}</div>
              )}
            </Field>

            <Field>
              <Label>Email</Label>
              <Input
                type="email"
                {...register('email', {
                  pattern: { value: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, message: 'Invalid email address' },
                })}
                disabled={isSubmitting}
                autoComplete="email"
              />
              {errors.email && (
                <div className="mt-1 text-sm text-red-600 dark:text-red-400">{errors.email.message}</div>
              )}
            </Field>
          </div>

          <div>
            <Button type="submit" color="dark/zinc" className="w-full" disabled={isSubmitting}>
              {isSubmitting ? 'Creating account...' : 'Create Admin Account'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
