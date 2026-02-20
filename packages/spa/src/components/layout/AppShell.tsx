import { Outlet } from 'react-router-dom';
import { SidebarLayout } from '@/components/catalyst/sidebar-layout';
import { AppSidebar } from './AppSidebar';
import { AppNavbar } from './AppNavbar';

export function AppShell() {
  return (
    <SidebarLayout
      sidebar={
        <div className="dark h-full bg-slate-900">
          <AppSidebar />
        </div>
      }
      navbar={<AppNavbar />}
    >
      <Outlet />
    </SidebarLayout>
  );
}
