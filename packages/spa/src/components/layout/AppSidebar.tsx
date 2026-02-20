import { useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  Store,
  Users as UsersIcon,
  Package,
  ScrollText,
  UserCircle,
  KeyRound,
  Power,
  Settings as SettingsIcon,
  UserPlus,
  User,
  LogOut,
} from 'lucide-react';
import {
  Sidebar,
  SidebarHeader,
  SidebarBody,
  SidebarFooter,
  SidebarSection,
  SidebarItem,
  SidebarLabel,
  SidebarHeading,
  SidebarDivider,
} from '@/components/catalyst/sidebar';
import { Avatar } from '@/components/catalyst/avatar';
import { Dropdown, DropdownButton, DropdownMenu, DropdownItem, DropdownDivider } from '@/components/catalyst/dropdown';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { authApi } from '@/api/auth';
import { useNavigate } from 'react-router-dom';

interface NavItem {
  title: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
}

const userNavItems: NavItem[] = [
  { title: 'Dashboard', href: '/app/dashboard', icon: LayoutDashboard },
  { title: 'Marketplace', href: '/app/marketplace', icon: Store },
  { title: 'My Clients', href: '/app/clients', icon: UserCircle },
  { title: 'Credentials', href: '/app/credentials', icon: KeyRound },
];

const adminNavItems: NavItem[] = [
  { title: 'Dashboard', href: '/app/admin/dashboard', icon: LayoutDashboard },
  { title: 'Users', href: '/app/admin/users', icon: UsersIcon },
  { title: 'Groups', href: '/app/admin/groups', icon: UserPlus },
  { title: 'MCPs', href: '/app/admin/mcps', icon: Package },
  { title: 'Audit Logs', href: '/app/admin/audit', icon: ScrollText },
  { title: 'Kill Switches', href: '/app/admin/kill-switches', icon: Power },
  { title: 'Settings', href: '/app/admin/settings', icon: SettingsIcon },
];

export function AppSidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  
  const { data: session } = useQuery({
    queryKey: ['session'],
    queryFn: authApi.getSession,
  });

  const handleLogout = async () => {
    try {
      await authApi.logout();
      queryClient.clear();
      navigate('/login');
    } catch (error) {
      console.error('Logout failed:', error);
    }
  };

  const isActive = (href: string) => {
    if (location.pathname === href) return true;
    if (href !== '/app/dashboard' && location.pathname.startsWith(href + '/')) return true;
    return false;
  };

  const userInitials = session?.user.username
    ? session.user.username.substring(0, 2).toUpperCase()
    : 'U';

  return (
    <Sidebar>
      <SidebarHeader>
        <SidebarItem href="/app/dashboard">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-teal-500">
            <span className="font-mono text-sm font-bold text-white">M</span>
          </div>
          <SidebarLabel>
            <div className="flex items-baseline gap-1">
              <span className="font-mono text-sm font-bold text-teal-500">MCP</span>
              <span className="font-semibold">Ambassador</span>
            </div>
          </SidebarLabel>
        </SidebarItem>
      </SidebarHeader>

      <SidebarBody>
        {/* User Section */}
        <SidebarSection>
          <SidebarHeading>User</SidebarHeading>
          {userNavItems.map((item) => {
            const Icon = item.icon;
            const active = isActive(item.href);
            return (
              <SidebarItem key={item.href} href={item.href} current={active}>
                <Icon data-slot="icon" />
                <SidebarLabel>{item.title}</SidebarLabel>
              </SidebarItem>
            );
          })}
        </SidebarSection>

        {/* Admin Section */}
        {session?.user.isAdmin && (
          <>
            <SidebarDivider />
            <SidebarSection>
              <SidebarHeading>Admin</SidebarHeading>
              {adminNavItems.map((item) => {
                const Icon = item.icon;
                const active = isActive(item.href);
                return (
                  <SidebarItem key={item.href} href={item.href} current={active}>
                    <Icon data-slot="icon" />
                    <SidebarLabel>{item.title}</SidebarLabel>
                  </SidebarItem>
                );
              })}
            </SidebarSection>
          </>
        )}
      </SidebarBody>

      <SidebarFooter>
        <Dropdown>
          <DropdownButton as={SidebarItem}>
            <Avatar initials={userInitials} className="size-8 bg-zinc-700 text-white" />
            <SidebarLabel>{session?.user.username}</SidebarLabel>
          </DropdownButton>
          <DropdownMenu anchor="top start">
            <DropdownItem href="/app/profile">
              <User data-slot="icon" />
              Profile
            </DropdownItem>
            <DropdownDivider />
            <DropdownItem onClick={handleLogout}>
              <LogOut data-slot="icon" />
              Log out
            </DropdownItem>
          </DropdownMenu>
        </Dropdown>
      </SidebarFooter>
    </Sidebar>
  );
}
