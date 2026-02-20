import React from 'react';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../../components/ui/toast';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { describe, it, expect } from 'vitest';

// Pages (user)
import { Login } from '../../pages/Login';
import { Dashboard } from '../../pages/Dashboard';
import { Clients } from '../../pages/Clients';
import { ClientDetail } from '../../pages/ClientDetail';
import { Marketplace } from '../../pages/Marketplace';
import { McpDetail } from '../../pages/McpDetail';
import { Credentials } from '../../pages/Credentials';

// Pages (admin)
import { Dashboard as AdminDashboard } from '../../pages/admin/Dashboard';
import { UsersAdmin } from '../../pages/admin/Users';
import { GroupsAdmin } from '../../pages/admin/Groups';
import { McpsAdmin } from '../../pages/admin/Mcps';
import { AuditLogsAdmin } from '../../pages/admin/AuditLogs';
import { KillSwitches } from '../../pages/admin/KillSwitches';
import { Settings } from '../../pages/admin/Settings';

function renderPage(ui: React.ReactElement, { route = '/' } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
}

describe('SPA page render tests (no crashes)', () => {
  it('renders Login page', async () => {
    const { container } = renderPage(<Login />, { route: '/login' });
    expect(container).toBeTruthy();
  });

  it('renders Dashboard page', async () => {
    const { container } = renderPage(<Dashboard />, { route: '/app/dashboard' });
    expect(container).toBeTruthy();
  });

  it('renders Clients page', async () => {
    const { container } = renderPage(<Clients />, { route: '/app/clients' });
    expect(container).toBeTruthy();
  });

  it('renders Client Detail page', async () => {
    const { container } = renderPage(
      <Routes>
        <Route path="/app/clients/:clientId" element={<ClientDetail />} />
      </Routes>,
      { route: '/app/clients/c1' }
    );
    expect(container).toBeTruthy();
  });

  it('renders Marketplace page', async () => {
    const { container } = renderPage(<Marketplace />, { route: '/app/marketplace' });
    expect(container).toBeTruthy();
  });

  it('renders Marketplace Detail (MCP) page', async () => {
    const { container } = renderPage(
      <Routes>
        <Route path="/app/marketplace/:mcpId" element={<McpDetail />} />
      </Routes>,
      { route: '/app/marketplace/m1' }
    );
    expect(container).toBeTruthy();
  });

  it('renders Credentials page', async () => {
    const { container } = renderPage(<Credentials />, { route: '/app/credentials' });
    expect(container).toBeTruthy();
  });

  // Admin pages
  it('renders Admin Dashboard page', async () => {
    const { container } = renderPage(<AdminDashboard />, { route: '/app/admin/dashboard' });
    expect(container).toBeTruthy();
  });

  it('renders Admin Users page', async () => {
    const { container } = renderPage(<UsersAdmin />, { route: '/app/admin/users' });
    expect(container).toBeTruthy();
  });

  it('renders Admin Groups page', async () => {
    const { container } = renderPage(<GroupsAdmin />, { route: '/app/admin/groups' });
    expect(container).toBeTruthy();
  });

  it('renders Admin MCPs page', async () => {
    const { container } = renderPage(<McpsAdmin />, { route: '/app/admin/mcps' });
    expect(container).toBeTruthy();
  });

  it('renders Admin Audit Logs page', async () => {
    const { container } = renderPage(<AuditLogsAdmin />, { route: '/app/admin/audit' });
    expect(container).toBeTruthy();
  });

  it('renders Admin Kill Switches page', async () => {
    const { container } = renderPage(<KillSwitches />, { route: '/app/admin/kill-switches' });
    // ensure it rendered without throwing (DOM container present)
    expect(container).toBeTruthy();
  });

  it('renders Admin Settings page', async () => {
    const { container } = renderPage(<Settings />, { route: '/app/admin/settings' });
    expect(container).toBeTruthy();
  });
});
