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
        'fixed left-0 top-0 z-40 h-screen border-r transition-all duration-300',
        'bg-[hsl(var(--color-sidebar))] border-[hsl(var(--color-sidebar-border))]',
        collapsed ? 'w-12' : 'w-60'
      )}
    >
      <div className="flex h-full flex-col">
        {/* Logo / Brand */}
        <div className="flex h-14 items-center border-b border-[hsl(var(--color-sidebar-border))] px-3">
          {!collapsed && (
            <Link to="/app/dashboard" className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[hsl(var(--color-sidebar-primary))]">
                <span className="font-mono text-sm font-bold text-[hsl(var(--color-sidebar-primary-foreground))]">M</span>
              </div>
              <div className="flex flex-col leading-tight">
                <div className="flex items-baseline gap-1">
                  <span className="font-mono text-sm font-bold text-[hsl(var(--color-sidebar-primary))]">MCP</span>
                  <span className="font-semibold text-[hsl(var(--color-sidebar-primary-foreground))]">Ambassador</span>
                </div>
              </div>
            </Link>
          )}
          {collapsed && (
            <Link to="/app/dashboard" className="flex items-center">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[hsl(var(--color-sidebar-primary))]">
                <span className="font-mono text-sm font-bold text-[hsl(var(--color-sidebar-primary-foreground))]">M</span>
              </div>
            </Link>
          )}
        </div>

        {/* Navigation */}
        <nav className="flex-1 space-y-1 overflow-y-auto p-3">
          {/* User Section */}
          <div className="space-y-0.5">
            {!collapsed && (
              <p className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-[hsl(var(--color-sidebar-muted-foreground))]">
                User
              </p>
            )}
            {userNavItems.map((item) => {
              const Icon = item.icon;
              const active = isActive(item.href);
              return (
                <Link
                  key={item.href}
                  to={item.href}
                  className={cn(
                    'flex h-8 items-center gap-3 rounded-md px-3 text-sm transition-colors',
                    'text-[hsl(var(--color-sidebar-foreground))]',
                    active
                      ? 'bg-[hsl(var(--color-sidebar-accent))] text-[hsl(var(--color-sidebar-primary))] border-l-2 border-[hsl(var(--color-sidebar-primary))]'
                      : 'hover:bg-[hsl(var(--color-sidebar-accent))] hover:text-[hsl(var(--color-sidebar-accent-foreground))]',
                    collapsed && 'justify-center px-0'
                  )}
                  title={collapsed ? item.title : undefined}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {!collapsed && <span>{item.title}</span>}
                </Link>
              );
            })}
          </div>

          {/* Admin Section */}
          {session?.user.isAdmin && (
            <>
              <Separator className="my-3 bg-[hsl(var(--color-sidebar-border))]" />
              <div className="space-y-0.5">
                {!collapsed && (
                  <p className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-[hsl(var(--color-sidebar-muted-foreground))]">
                    Admin
                  </p>
                )}
                {adminNavItems.map((item) => {
                  const Icon = item.icon;
                  const active = isActive(item.href);
                  return (
                    <Link
                      key={item.href}
                      to={item.href}
                      className={cn(
                        'flex h-8 items-center gap-3 rounded-md px-3 text-sm transition-colors',
                        'text-[hsl(var(--color-sidebar-foreground))]',
                        active
                          ? 'bg-[hsl(var(--color-sidebar-accent))] text-[hsl(var(--color-sidebar-primary))] border-l-2 border-[hsl(var(--color-sidebar-primary))]'
                          : 'hover:bg-[hsl(var(--color-sidebar-accent))] hover:text-[hsl(var(--color-sidebar-accent-foreground))]',
                        collapsed && 'justify-center px-0'
                      )}
                      title={collapsed ? item.title : undefined}
                    >
                      <Icon className="h-4 w-4 shrink-0" />
                      {!collapsed && <span>{item.title}</span>}
                    </Link>
                  );
                })}
              </div>
            </>
          )}
        </nav>

        {/* Footer */}
        <div className="border-t border-[hsl(var(--color-sidebar-border))] p-3">
          <div className={cn('flex items-center gap-2', collapsed ? 'justify-center' : 'justify-between')}>
            {!collapsed && <ThemeToggle />}
            <Button
              variant="ghost"
              size="icon"
              onClick={toggle}
              className="h-8 w-8 shrink-0 text-[hsl(var(--color-sidebar-foreground))] hover:bg-[hsl(var(--color-sidebar-accent))] hover:text-[hsl(var(--color-sidebar-accent-foreground))]"
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
