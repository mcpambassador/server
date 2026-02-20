import { Outlet } from 'react-router-dom';
import { SidebarLayout } from '@/components/catalyst/sidebar-layout';
import { AppSidebar } from './AppSidebar';
import { AppNavbar } from './AppNavbar';

export function AppShell() {
  return (
    <SidebarLayout
      sidebar={
        <div className="dark h-full">
          <AppSidebar />
        </div>
      }
      navbar={<AppNavbar />}
    >
      <Outlet />
    </SidebarLayout>
  );
}
