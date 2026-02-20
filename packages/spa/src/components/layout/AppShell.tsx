import { Outlet } from 'react-router-dom';
import { SidebarLayout } from '@/components/catalyst/sidebar-layout';
import { AppSidebar } from './AppSidebar';
import { AppNavbar } from './AppNavbar';

export function AppShell() {
  return (
    <SidebarLayout
      sidebar={<AppSidebar />}
      navbar={<AppNavbar />}
    >
      <Outlet />
    </SidebarLayout>
  );
}
