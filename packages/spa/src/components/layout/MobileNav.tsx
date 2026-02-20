import * as React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { X, LayoutDashboard, Store, UserCircle, Package, Users as UsersIcon, UserPlus, ScrollText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { authApi } from '@/api/auth';

interface MobileNavProps {
  open: boolean;
  onClose: () => void;
}

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
  { title: 'My Subscriptions', href: '/app/subscriptions', icon: Package },
];

const adminNavItems: NavItem[] = [
  { title: 'Users', href: '/app/admin/users', icon: UsersIcon, adminOnly: true },
  { title: 'Groups', href: '/app/admin/groups', icon: UserPlus, adminOnly: true },
  { title: 'MCPs', href: '/app/admin/mcps', icon: Package, adminOnly: true },
  { title: 'Audit Logs', href: '/app/admin/audit', icon: ScrollText, adminOnly: true },
];

export function MobileNav({ open, onClose }: MobileNavProps) {
  const location = useLocation();
  const { data: session } = useQuery({
    queryKey: ['session'],
    queryFn: authApi.getSession,
  });

  const isActive = (href: string) => location.pathname === href;

  React.useEffect(() => {
    // Close mobile nav on route change
    onClose();
  }, [location.pathname, onClose]);

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-50 bg-background md:hidden"
        onClick={onClose}
      />

      {/* Mobile Navigation Panel */}
      <aside className="fixed left-0 top-0 z-50 h-screen w-64 border-r bg-background md:hidden">
        <div className="flex h-full flex-col">
          {/* Header */}
          <div className="flex h-16 items-center justify-between border-b px-4">
            <div className="flex items-center gap-2">
              <Package className="h-6 w-6 text-primary" />
              <span className="font-semibold">MCP Ambassador</span>
            </div>
            <Button variant="ghost" size="icon" onClick={onClose}>
              <X className="h-5 w-5" />
            </Button>
          </div>

          {/* Navigation */}
          <nav className="flex-1 space-y-1 overflow-y-auto p-4">
            {/* User Section */}
            <div className="space-y-1">
              <p className="px-3 text-xs font-semibold uppercase text-muted-foreground">
                User
              </p>
              {userNavItems.map((item) => {
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    to={item.href}
                    className={cn(
                      'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                      isActive(item.href)
                        ? 'bg-primary text-primary-foreground'
                        : 'hover:bg-accent hover:text-accent-foreground'
                    )}
                  >
                    <Icon className="h-5 w-5 shrink-0" />
                    <span>{item.title}</span>
                  </Link>
                );
              })}
            </div>

            {/* Admin Section */}
            {session?.user.isAdmin && (
              <>
                <Separator className="my-4" />
                <div className="space-y-1">
                  <p className="px-3 text-xs font-semibold uppercase text-muted-foreground">
                    Admin
                  </p>
                  {adminNavItems.map((item) => {
                    const Icon = item.icon;
                    return (
                      <Link
                        key={item.href}
                        to={item.href}
                        className={cn(
                          'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                          isActive(item.href)
                            ? 'bg-primary text-primary-foreground'
                            : 'hover:bg-accent hover:text-accent-foreground'
                        )}
                      >
                        <Icon className="h-5 w-5 shrink-0" />
                        <span>{item.title}</span>
                      </Link>
                    );
                  })}
                </div>
              </>
            )}
          </nav>
        </div>
      </aside>
    </>
  );
}
