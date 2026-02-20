import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { describe, it, expect } from 'vitest';
import { server } from '../mocks/server';
import { http, HttpResponse } from 'msw';

import { Login } from '../../pages/Login';
import { Clients } from '../../pages/Clients';
import * as clientsHooks from '../../api/hooks/use-clients';

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function renderPage(ui: React.ReactElement, { route = '/' } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>
        {ui}
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('SPA form payloads', () => {
  it('login form submits correct payload', async () => {
    let captured: any = null;
    server.use(
      http.post('/v1/auth/login', async ({ request }) => {
        captured = await request.json();
        return HttpResponse.json({ ok: true, data: { user: { id: '1', username: 'test' } } });
      })
    );

    renderPage(<Login />, { route: '/login' });

    const userInput = screen.getByLabelText(/Username/i);
    const passInput = screen.getByLabelText(/Password/i);
    const submit = screen.getByRole('button', { name: /Sign in/i });

    fireEvent.change(userInput, { target: { value: 'alice' } });
    fireEvent.change(passInput, { target: { value: 'secret' } });
    fireEvent.click(submit);

    await waitFor(() => expect(captured).not.toBeNull());
    expect(captured).toEqual({ username: 'alice', password: 'secret' });
  });

  it('create client form submits correct payload', async () => {
    let captured: any = null;
    server.use(
      http.post('/v1/users/me/clients', async ({ request }) => {
        captured = await request.json();
        return HttpResponse.json({ ok: true, data: { client: { id: 'new', clientName: captured.client_name }, plaintext_key: 'k' } });
      })
    );

    renderPage(<Clients />, { route: '/app/clients' });

    // Open create dialog
    const openBtn = screen.getByRole('button', { name: /Create Client/i });
    fireEvent.click(openBtn);

    // Fill form
    const nameInput = await screen.findByLabelText(/Client Name/i);
    fireEvent.change(nameInput, { target: { value: 'My App' } });

    const createBtn = screen.getByRole('button', { name: /^Create$/i });
    fireEvent.click(createBtn);

    await waitFor(() => expect(captured).not.toBeNull());
    expect(captured).toEqual({ client_name: 'My App' });
  });

  it('subscribe mutation sends correct payload', async () => {
    let captured: any = null;
    server.use(
      http.post('/v1/users/me/clients/c1/subscriptions', async ({ request }) => {
        captured = await request.json();
        return HttpResponse.json({ ok: true, data: { subscription_id: 's1' } });
      })
    );

    const wrapper = createWrapper();
    const { result } = renderHook(() => clientsHooks.useSubscribe(), { wrapper });

    const payload = { clientId: 'c1', data: { mcp_id: 'm1', selected_tools: ['t1', 't2'] } } as any;
    await result.current.mutateAsync(payload);

    expect(captured).toEqual({ mcp_id: 'm1', selected_tools: ['t1', 't2'] });
  });
});
