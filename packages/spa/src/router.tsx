/* eslint-disable react-refresh/only-export-components -- file intentionally exports a router config rather than a component */
import { createBrowserRouter, Navigate, useLocation } from 'react-router-dom';
import { AppShell } from '@/components/layout/AppShell';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { AdminRoute } from '@/components/auth/AdminRoute';
import { Login } from '@/pages/Login';
import { Dashboard } from '@/pages/Dashboard';
import { Marketplace } from '@/pages/Marketplace';
import { McpDetail } from '@/pages/McpDetail';
import { Clients } from '@/pages/Clients';
import { ClientDetail } from '@/pages/ClientDetail';
import { Credentials } from '@/pages/Credentials';
import { Profile } from '@/pages/Profile';
import { Subscriptions } from '@/pages/Subscriptions';
import { Dashboard as AdminDashboard } from '@/pages/admin/Dashboard';
import { UsersAdmin } from '@/pages/admin/Users';
import { UserDetail } from '@/pages/admin/UserDetail';
import { GroupsAdmin } from '@/pages/admin/Groups';
import { GroupDetail } from '@/pages/admin/GroupDetail';
import { McpsAdmin } from '@/pages/admin/Mcps';
import { McpDetail as AdminMcpDetail } from '@/pages/admin/McpDetail';
import { McpWizard } from '@/pages/admin/McpWizard';
import { UserInstances } from '@/pages/admin/UserInstances';
import { AuditLogsAdmin } from '@/pages/admin/AuditLogs';
import { KillSwitches } from '@/pages/admin/KillSwitches';
import { Settings } from '@/pages/admin/Settings';
import { Registry } from '@/pages/admin/Registry';

// Redirect component for OAuth callback
function ConnectionsRedirect() {
  const location = useLocation();
  return <Navigate to={`/app/credentials${location.search}`} replace />;
}

export const router = createBrowserRouter([
  {
    path: '/login',
    element: <Login />,
  },
  {
    path: '/connections',
    element: <ConnectionsRedirect />,
  },
  {
    path: '/app',
    element: (
      <ProtectedRoute>
        <AppShell />
      </ProtectedRoute>
    ),
    children: [
      {
        index: true,
        element: <Navigate to="/app/dashboard" replace />,
      },
      {
        path: 'dashboard',
        element: <Dashboard />,
      },
      {
        path: 'marketplace',
        element: <Marketplace />,
      },
      {
        path: 'marketplace/:mcpId',
        element: <McpDetail />,
      },
      {
        path: 'clients',
        element: <Clients />,
      },
      {
        path: 'clients/:clientId',
        element: <ClientDetail />,
      },
      {
        path: 'credentials',
        element: <Credentials />,
      },
      {
        path: 'profile',
        element: <Profile />,
      },
      {
        path: 'subscriptions',
        element: <Subscriptions />,
      },
      {
        path: 'admin/dashboard',
        element: (
          <AdminRoute>
            <AdminDashboard />
          </AdminRoute>
        ),
      },
      {
        path: 'admin/users',
        element: (
          <AdminRoute>
            <UsersAdmin />
          </AdminRoute>
        ),
      },
      {
        path: 'admin/users/:userId',
        element: (
          <AdminRoute>
            <UserDetail />
          </AdminRoute>
        ),
      },
      {
        path: 'admin/groups',
        element: (
          <AdminRoute>
            <GroupsAdmin />
          </AdminRoute>
        ),
      },
      {
        path: 'admin/groups/:groupId',
        element: (
          <AdminRoute>
            <GroupDetail />
          </AdminRoute>
        ),
      },
      {
        path: 'admin/mcps',
        element: (
          <AdminRoute>
            <McpsAdmin />
          </AdminRoute>
        ),
      },
      {
        path: 'admin/mcps/new',
        element: (
          <AdminRoute>
            <McpWizard />
          </AdminRoute>
        ),
      },
      {
        path: 'admin/mcps/:mcpId',
        element: (
          <AdminRoute>
            <AdminMcpDetail />
          </AdminRoute>
        ),
      },
      {
        path: 'admin/user-instances',
        element: (
          <AdminRoute>
            <UserInstances />
          </AdminRoute>
        ),
      },
      {
        path: 'admin/audit',
        element: (
          <AdminRoute>
            <AuditLogsAdmin />
          </AdminRoute>
        ),
      },
      {
        path: 'admin/kill-switches',
        element: (
          <AdminRoute>
            <KillSwitches />
          </AdminRoute>
        ),
      },
      {
        path: 'admin/registry',
        element: (
          <AdminRoute>
            <Registry />
          </AdminRoute>
        ),
      },
      {
        path: 'admin/settings',
        element: (
          <AdminRoute>
            <Settings />
          </AdminRoute>
        ),
      },
    ],
  },
  {
    path: '/',
    element: <Navigate to="/app/dashboard" replace />,
  },
  {
    path: '*',
    element: <Navigate to="/app/dashboard" replace />,
  },
]);
