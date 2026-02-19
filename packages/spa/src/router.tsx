import { createBrowserRouter, Navigate } from 'react-router-dom';
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
import { UsersAdmin } from '@/pages/admin/Users';
import { GroupsAdmin } from '@/pages/admin/Groups';
import { McpsAdmin } from '@/pages/admin/Mcps';
import { AuditLogsAdmin } from '@/pages/admin/AuditLogs';

export const router = createBrowserRouter([
  {
    path: '/login',
    element: <Login />,
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
        path: 'admin/users',
        element: (
          <AdminRoute>
            <UsersAdmin />
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
        path: 'admin/mcps',
        element: (
          <AdminRoute>
            <McpsAdmin />
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
