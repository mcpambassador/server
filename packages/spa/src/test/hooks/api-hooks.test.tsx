import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect } from 'vitest';
import { server } from '../mocks/server';
import { http, HttpResponse } from 'msw';

import * as cred from '../../api/hooks/use-credentials';
import * as profile from '../../api/hooks/use-profile';
import * as clients from '../../api/hooks/use-clients';
import * as marketplace from '../../api/hooks/use-marketplace';
import * as admin from '../../api/hooks/use-admin';
import type {
  CreateClientRequest,
  CreateClientResponse,
  Client,
  UpdateClientRequest,
  Subscription,
  CreateSubscriptionRequest,
  UpdateSubscriptionRequest,
  CreateUserRequest,
  AdminUser,
} from '../../api/types';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe('API Hooks (success paths)', () => {
  it('useCredentialStatus returns credentials', async () => {
    const { result } = renderHook(() => cred.useCredentialStatus(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(Array.isArray(result.current.data)).toBe(true);
  });

  it('useProfile returns profile', async () => {
    const { result } = renderHook(() => profile.useProfile(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data!.username).toBe('alice');
  });

  it('useClients returns client list and useClient returns a client', async () => {
    const { result } = renderHook(() => clients.useClients(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(Array.isArray(result.current.data)).toBe(true);
    // ensure explicit handler for single client
    server.use(http.get('/v1/users/me/clients/c1', () => HttpResponse.json({ ok: true, data: { id: 'c1', clientName: 'Client c1', keyPrefix: 'amb_', status: 'active', createdAt: new Date().toISOString() } })));

    const { result: single } = renderHook(() => clients.useClient('c1'), { wrapper: createWrapper() });
    await waitFor(() => expect(single.current.data).toBeDefined());
    expect(single.current.data!.id).toBe('c1');
  });

  it('create, update, delete client mutations succeed', async () => {
    const wrapper = createWrapper();

    const { result: create } = renderHook(() => clients.useCreateClient(), { wrapper });
    const created = await create.current.mutateAsync({ client_name: 'new' } as CreateClientRequest);
    expect((created as CreateClientResponse).client?.id).toBe('new');

    // ensure explicit handlers for update/delete to avoid regex mismatches
    server.use(http.patch('/v1/users/me/clients/c1', () => HttpResponse.json({ ok: true, data: { id: 'c1', clientName: 'updated', keyPrefix: 'amb_', status: 'active', createdAt: new Date().toISOString() } })));
    server.use(http.delete('/v1/users/me/clients/c1', () => HttpResponse.json({ ok: true, data: { message: 'deleted' } })));

    const { result: update } = renderHook(() => clients.useUpdateClient(), { wrapper });
    const updated = await update.current.mutateAsync({ clientId: 'c1', data: { status: 'active' } as UpdateClientRequest });
    expect((updated as Client).id).toBe('c1');

    const { result: del } = renderHook(() => clients.useDeleteClient(), { wrapper });
    const deleted = await del.current.mutateAsync('c1');
    expect(deleted).toBeDefined();
  });

  it('subscription hooks work', async () => {
    const wrapper = createWrapper();

    const { result: subs } = renderHook(() => clients.useClientSubscriptions('c1'), { wrapper });
    await waitFor(() => expect(subs.current.data).toBeDefined());

    const { result: subscribe } = renderHook(() => clients.useSubscribe(), { wrapper });
    const created = await subscribe.current.mutateAsync({ clientId: 'c1', data: { mcp_id: 'p' } as CreateSubscriptionRequest });
    expect((created as Subscription).id).toBe('s-new');

    const { result: updateSub } = renderHook(() => clients.useUpdateSubscription(), { wrapper });
    const upd = await updateSub.current.mutateAsync({ clientId: 'c1', subscriptionId: 's1', data: { selected_tools: ['x'] } as UpdateSubscriptionRequest });
    expect(upd).toBeDefined();

    const { result: unsub } = renderHook(() => clients.useUnsubscribe(), { wrapper });
    const un = await unsub.current.mutateAsync({ clientId: 'c1', subscriptionId: 's1' });
    expect(un).toBeDefined();
  });

  it('marketplace hooks return data', async () => {
    const { result } = renderHook(() => marketplace.useMarketplace(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.data).toBeDefined());

    // Ensure explicit handler for the detail endpoint
    server.use(http.get('/v1/marketplace/m1', () => HttpResponse.json({ ok: true, data: { id: 'm1', name: 'MCP m1', description: 'Test MCP', isolationMode: 'shared', requiresUserCredentials: false, tools: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } })));

    const { result: detail } = renderHook(() => marketplace.useMcpDetail('m1'), { wrapper: createWrapper() });
    await waitFor(() => expect(detail.current.data).toBeDefined());
    expect(detail.current.data!.id).toBe('m1');
  });

  it('admin generic GET and mutation hooks resolve', async () => {
    const wrapper = createWrapper();

    const { result: users } = renderHook(() => admin.useAdminUsers(), { wrapper });
    await waitFor(() => expect(users.current.data).toBeDefined());

    // Add specific handler that returns a proper AdminUser shape
    server.use(
      http.post('/v1/admin/users', () =>
        HttpResponse.json({ ok: true, data: { user_id: 'u1', username: 'a', display_name: 'a', role: 'viewer', status: 'active', created_at: new Date().toISOString() } })
      )
    );

    const { result: createUser } = renderHook(() => admin.useCreateUser(), { wrapper });
    const cu = await createUser.current.mutateAsync({ username: 'a', password: 'testpass' } as CreateUserRequest);
    expect((cu as AdminUser).user_id).toBeDefined();
  });
});

describe('API Hooks (error paths)', () => {
  it('useProfile surfaces error envelope', async () => {
    server.use(
      http.get('/v1/users/me', () => HttpResponse.json({ ok: false, error: { code: 'E', message: 'fail' } }, { status: 400 }))
    );

    const { result } = renderHook(() => profile.useProfile(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  it('mutation surfaces error envelope', async () => {
    server.use(
      http.post('/v1/users/me/clients', () => HttpResponse.json({ ok: false, error: { code: 'E', message: 'bad' } }, { status: 400 }))
    );

    const { result } = renderHook(() => clients.useCreateClient(), { wrapper: createWrapper() });
    await expect(result.current.mutateAsync({ client_name: 'x' } as CreateClientRequest)).rejects.toThrow();
  });
});
