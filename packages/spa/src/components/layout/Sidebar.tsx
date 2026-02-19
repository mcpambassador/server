import * as React from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  Store,
  Users as UsersIcon,
  Package,
  ChevronLeft,
  ChevronRight,
  ScrollText,
  UserCircle,
  UserPlus,
  KeyRound,
  Power,
  Settings as SettingsIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { ThemeToggle } from '@/components/ThemeToggle';
import { useSidebar } from '@/stores/sidebar';
import { useQuery } from '@tanstack/react-query';
import { authApi } from '@/api/auth';

interface NavItem {
  title: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  adminOnly?: boolean;
}

const userNavItems: NavItem[] = [
  { title: 'Dashboard', href: '/app/dashboard', icon: LayoutDashboard },
  { title: 'Marketplace', href: '/app/marketplace', icon: Store },
  { title: 'My Clients', href: '/app/clients', icon: UserCircle },
  { title: 'Credentials', href: '/app/credentials', icon: KeyRound },
];

const adminNavItems: NavItem[] = [
  { title: 'Dashboard', href: '/app/admin/dashboard', icon: LayoutDashboard, adminOnly: true },
  { title: 'Users', href: '/app/admin/users', icon: UsersIcon, adminOnly: true },
  { title: 'Groups', href: '/app/admin/groups', icon: UserPlus, adminOnly: true },
  { title: 'MCPs', href: '/app/admin/mcps', icon: Package, adminOnly: true },
  { title: 'Audit Logs', href: '/app/admin/audit', icon: ScrollText, adminOnly: true },
  { title: 'Kill Switches', href: '/app/admin/kill-switches', icon: Power, adminOnly: true },
  { title: 'Settings', href: '/app/admin/settings', icon: SettingsIcon, adminOnly: true },
];

export function Sidebar() {
  const location = useLocation();
  const { collapsed, toggle } = useSidebar();
  const { data: session } = useQuery({
    queryKey: ['session'],
    queryFn: authApi.getSession,
  });

  const isActive = (href: string) => {
    // Exact match for the base route
    if (location.pathname === href) return true;
    // Also match sub-routes (e.g., /app/admin/users/123 should highlight "Users")
    if (href !== '/app/dashboard' && location.pathname.startsWith(href + '/')) return true;
    return false;
  };

  return (
    <aside
      className={cn(
        'fixed left-0 top-0 z-40 h-screen border-r bg-background transition-all duration-300',
        collapsed ? 'w-16' : 'w-64'
      )}
    >
      <div className="flex h-full flex-col">
        {/* Logo / Brand */}
        <div className="flex h-16 items-center border-b px-4">
          {!collapsed && (
            <Link to="/app/dashboard" className="flex items-center gap-2">
              <Package className="h-6 w-6 text-primary" />
              <span className="font-semibold">MCP Ambassador</span>
            </Link>
          )}
          {collapsed && (
            <Link to="/app/dashboard" className="flex items-center">
              <Package className="h-6 w-6 text-primary" />
            </Link>
          )}
        </div>

        {/* Navigation */}
        <nav className="flex-1 space-y-1 overflow-y-auto p-4">
          {/* User Section */}
          <div className="space-y-1">
            {!collapsed && (
              <p className="px-3 text-xs font-semibold uppercase text-muted-foreground">
                User
              </p>
            )}
            {userNavItems.map((item) => {
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  to={item.href}
                  className={cn(
                    'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
                    isActive(item.href)
                      ? 'bg-primary text-primary-foreground'
                      : 'hover:bg-accent hover:text-accent-foreground',
                    collapsed && 'justify-center'
                  )}
                  title={collapsed ? item.title : undefined}
                >
                  <Icon className="h-5 w-5 shrink-0" />
                  {!collapsed && <span>{item.title}</span>}
                </Link>
              );
            })}
          </div>

          {/* Admin Section */}
          {session?.user.isAdmin && (
            <>
              <Separator className="my-4" />
              <div className="space-y-1">
                {!collapsed && (
                  <p className="px-3 text-xs font-semibold uppercase text-muted-foreground">
                    Admin
                  </p>
                )}
                {adminNavItems.map((item) => {
                  const Icon = item.icon;
                  return (
                    <Link
                      key={item.href}
                      to={item.href}
                      className={cn(
                        'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
                        isActive(item.href)
                          ? 'bg-primary text-primary-foreground'
                          : 'hover:bg-accent hover:text-accent-foreground',
                        collapsed && 'justify-center'
                      )}
                      title={collapsed ? item.title : undefined}
                    >
                      <Icon className="h-5 w-5 shrink-0" />
                      {!collapsed && <span>{item.title}</span>}
                    </Link>
                  );
                })}
              </div>
            </>
          )}
        </nav>

        {/* Footer */}
        <div className="border-t p-4">
          <div className={cn('flex items-center', collapsed ? 'justify-center' : 'justify-between')}>
            {!collapsed && <ThemeToggle />}
            <Button
              variant="ghost"
              size="icon"
              onClick={toggle}
              className="shrink-0"
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              {collapsed ? (
                <ChevronRight className="h-4 w-4" />
              ) : (
                <ChevronLeft className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>
      </div>
    </aside>
  );
}
