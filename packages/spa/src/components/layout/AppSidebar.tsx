import { useLocation, useNavigate } from 'react-router-dom';
import {
  HomeIcon,
  BuildingStorefrontIcon,
  UserCircleIcon,
  KeyIcon,
  UsersIcon,
  UserGroupIcon,
  CubeIcon,
  DocumentTextIcon,
  PowerIcon,
  Cog6ToothIcon,
  SunIcon,
  MoonIcon,
} from '@heroicons/react/20/solid';
import {
  UserCircleIcon as UserCircleIcon16,
  ArrowRightStartOnRectangleIcon,
  ChevronUpIcon,
} from '@heroicons/react/16/solid';
import {
  Sidebar,
  SidebarHeader,
  SidebarBody,
  SidebarFooter,
  SidebarSection,
  SidebarItem,
  SidebarLabel,
  SidebarHeading,
  SidebarSpacer,
} from '@/components/catalyst/sidebar';
import { Avatar } from '@/components/catalyst/avatar';
import { 
  Dropdown, 
  DropdownButton, 
  DropdownMenu, 
  DropdownItem, 
  DropdownDivider,
  DropdownLabel,
} from '@/components/catalyst/dropdown';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { authApi } from '@/api/auth';
import { useTheme } from '@/stores/theme';

interface NavItem {
  title: string;
  href: string;
  icon: React.ComponentType;
}

const userNavItems: NavItem[] = [
  { title: 'Dashboard', href: '/app/dashboard', icon: HomeIcon },
  { title: 'Marketplace', href: '/app/marketplace', icon: BuildingStorefrontIcon },
  { title: 'My Clients', href: '/app/clients', icon: UserCircleIcon },
  { title: 'Credentials', href: '/app/credentials', icon: KeyIcon },
];

const adminNavItems: NavItem[] = [
  { title: 'Admin Dashboard', href: '/app/admin/dashboard', icon: HomeIcon },
  { title: 'Users', href: '/app/admin/users', icon: UsersIcon },
  { title: 'Groups', href: '/app/admin/groups', icon: UserGroupIcon },
  { title: 'MCPs', href: '/app/admin/mcps', icon: CubeIcon },
  { title: 'Audit Logs', href: '/app/admin/audit', icon: DocumentTextIcon },
  { title: 'Kill Switches', href: '/app/admin/kill-switches', icon: PowerIcon },
  { title: 'Settings', href: '/app/admin/settings', icon: Cog6ToothIcon },
];

export function AppSidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { resolvedTheme, setTheme } = useTheme();
  
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
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600">
            <span className="font-mono text-sm font-bold text-white">M</span>
          </div>
          <SidebarLabel>
            <div className="flex items-baseline gap-1">
              <span className="font-mono text-sm font-bold text-blue-500">MCP</span>
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
                <Icon />
                <SidebarLabel>{item.title}</SidebarLabel>
              </SidebarItem>
            );
          })}
        </SidebarSection>

        {/* Admin Section */}
        {session?.user.isAdmin && (
          <SidebarSection>
            <SidebarHeading>Admin</SidebarHeading>
            {adminNavItems.map((item) => {
              const Icon = item.icon;
              const active = isActive(item.href);
              return (
                <SidebarItem key={item.href} href={item.href} current={active}>
                  <Icon />
                  <SidebarLabel>{item.title}</SidebarLabel>
                </SidebarItem>
              );
            })}
          </SidebarSection>
        )}

        <SidebarSpacer />

        {/* Theme toggle */}
        <SidebarSection>
          <SidebarItem
            onClick={() => {
              const next = resolvedTheme === 'dark' ? 'light' : 'dark';
              setTheme(next);
            }}
          >
            {resolvedTheme === 'dark' ? <SunIcon /> : <MoonIcon />}
            <SidebarLabel>{resolvedTheme === 'dark' ? 'Light mode' : 'Dark mode'}</SidebarLabel>
          </SidebarItem>
        </SidebarSection>
      </SidebarBody>

      <SidebarFooter className="max-lg:hidden">
        <Dropdown>
          <DropdownButton as={SidebarItem}>
            <span className="flex min-w-0 items-center gap-3">
              <Avatar initials={userInitials} className="size-10 bg-slate-700 text-white" square alt="" />
              <span className="min-w-0">
                <span className="block truncate text-sm/5 font-medium text-zinc-950 dark:text-white">
                  {session?.user.username}
                </span>
                <span className="block truncate text-xs/5 font-normal text-zinc-500 dark:text-zinc-400">
                  {session?.user.email || 'user@mcpambassador.com'}
                </span>
              </span>
            </span>
            <ChevronUpIcon />
          </DropdownButton>
          <DropdownMenu anchor="top start">
            <DropdownItem href="/app/profile">
              <UserCircleIcon16 />
              <DropdownLabel>Profile</DropdownLabel>
            </DropdownItem>
            <DropdownDivider />
            <DropdownItem onClick={handleLogout}>
              <ArrowRightStartOnRectangleIcon />
              <DropdownLabel>Log out</DropdownLabel>
            </DropdownItem>
          </DropdownMenu>
        </Dropdown>
      </SidebarFooter>
    </Sidebar>
  );
}
