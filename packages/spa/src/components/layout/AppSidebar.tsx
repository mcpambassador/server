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
  QueueListIcon,
  ServerStackIcon,
  GlobeAltIcon,
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

// Arch/gateway logomark path from mcpa_logo.svg (website Logo.tsx)
const MARK_PATH =
  'm 38.792443,468.85625 c -0.06046,-0.13808 -0.09975,-42.88171 -0.08738,-94.98588 0.02269,-95.39017 0.04483,-97.45924 1.162799,-108.59849 0.91614,-9.12818 3.431217,-23.03631 5.946523,-32.88368 1.66327,-6.51169 6.139856,-19.92462 9.020315,-27.02703 2.80752,-6.92258 10.573971,-22.5826 14.078497,-28.38745 5.52279,-9.14786 13.041452,-19.96986 18.116063,-26.07538 3.22232,-3.87693 7.839282,-9.17581 9.779935,-11.2244 1.11789,-1.18006 2.90754,-3.08452 3.977025,-4.23213 2.61435,-2.80535 13.41196,-12.59813 18.37221,-16.66247 24.93116,-20.428177 55.18988,-35.54289 85.40399,-42.660678 2.0878,-0.491832 4.02881,-1.014901 4.31336,-1.162365 0.28453,-0.147453 1.01865,-1.798675 1.63132,-3.669367 4.48139,-13.682854 14.42876,-23.907941 28.00451,-28.78641 13.00684,-4.674033 28.92946,-2.639748 40.21798,5.138273 5.12176,3.529013 10.99311,9.926404 13.88124,15.124972 1.14641,2.063569 3.35687,7.237281 4.19744,9.824484 0.31048,0.955562 0.75805,1.930921 0.99459,2.167475 0.23654,0.236554 1.96929,0.767385 3.85053,1.179634 19.69292,4.315435 42.47477,13.78875 62.17583,25.854382 27.27218,16.70248 52.60844,41.51368 69.52805,68.08712 12.41251,19.4948 21.11755,38.99231 27.19043,60.90098 3.5169,12.68776 5.75389,26.2125 7.15215,43.24134 0.25234,3.07314 0.40745,34.03859 0.49977,99.77211 l 0.13389,95.31596 -14.62228,-0.086 -14.62227,-0.086 -0.19654,-97.70563 c -0.1081,-53.73809 -0.28944,-98.15125 -0.40306,-98.69589 -0.11361,-0.54464 -0.44509,-3.14407 -0.73663,-5.77651 -1.25597,-11.34118 -2.66524,-18.88086 -5.27511,-28.22241 -6.22989,-22.29877 -13.87614,-38.66647 -27.29363,-58.42532 -4.98012,-7.33379 -6.04046,-8.73437 -11.12055,-14.68886 -19.00708,-22.27855 -43.8598,-40.71087 -70.01665,-51.9287 -4.93232,-2.1153 -19.41844,-7.1417 -25.9048,-8.98845 -1.08928,-0.31014 -2.15111,-0.62915 -2.35963,-0.70891 -0.21353,-0.0817 -1.06218,1.19818 -1.94331,2.93072 -4.96075,9.75441 -15.14242,18.52781 -24.53945,21.14533 -1.47173,0.40994 -2.67702,0.84624 -2.67838,0.96952 -0.003,0.29664 2.5719,0.79075 7.42445,1.42455 9.54424,1.24682 20.3266,4.06636 31.00805,8.11225 39.99968,15.13966 71.36558,47.39285 85.28853,87.73578 4.89285,14.18265 7.45178,27.26715 8.39898,42.96553 0.2427,4.02498 0.43662,46.0082 0.49972,108.0429 l 0.0963,97.36718 -14.67762,0 -14.67762,0 -0.12437,-94.48563 c -0.0684,-51.96709 -0.27414,-96.06122 -0.45721,-97.98694 -2.14614,-22.57367 -8.62987,-42.74174 -19.73085,-61.39985 -7.15853,-12.02395 -18.91949,-26.51671 -29.05598,-35.78625 -4.39207,-4.0172 -13.75756,-11.07906 -16.47982,-12.4281 -0.24728,-0.12257 -0.90756,0.62449 -1.95076,2.20937 -5.18488,7.87493 -13.73072,14.49012 -22.61006,17.50427 -6.37474,2.16346 -10.47556,2.88953 -17.62684,3.12106 -4.68484,0.15164 -6.70267,0.0757 -10.00781,-0.37649 -5.7648,-0.78858 -10.1529,-2.09459 -15.43127,-4.59183 -7.51133,-3.55379 -13.85536,-8.94689 -18.81753,-15.98503 -1.15816,-1.64239 -2.1893,-2.88765 -2.29141,-2.76713 -0.10213,0.12052 -1.82791,1.50476 -3.83506,3.07609 -6.59174,5.15868 -14.7906,13.34422 -20.30073,20.26153 -10.29613,12.92441 -18.39367,28.89429 -23.32805,45.99696 -3.49067,12.1042 -4.34949,18.83653 -4.82419,37.83854 -0.18455,7.39199 -0.24012,35.50968 -0.16827,85.04655 l 0.11249,74.17892 -14.580667,0 -14.580668,0 z';

interface NavItem {
  title: string;
  href: string;
  icon: React.ComponentType;
}

const userNavItems: NavItem[] = [
  { title: 'Dashboard', href: '/app/dashboard', icon: HomeIcon },
  { title: 'Marketplace', href: '/app/marketplace', icon: BuildingStorefrontIcon },
  { title: 'My Clients', href: '/app/clients', icon: UserCircleIcon },
  { title: 'Subscriptions', href: '/app/subscriptions', icon: QueueListIcon },
  { title: 'Credentials', href: '/app/credentials', icon: KeyIcon },
];

const adminNavItems: NavItem[] = [
  { title: 'Admin Dashboard', href: '/app/admin/dashboard', icon: HomeIcon },
  { title: 'Users', href: '/app/admin/users', icon: UsersIcon },
  { title: 'Groups', href: '/app/admin/groups', icon: UserGroupIcon },
  { title: 'MCPs', href: '/app/admin/mcps', icon: CubeIcon },
  { title: 'Registry', href: '/app/admin/registry', icon: GlobeAltIcon },
  { title: 'User Instances', href: '/app/admin/user-instances', icon: ServerStackIcon },
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
          <svg aria-hidden="true" viewBox="0 0 512 512" className="h-8 w-8">
            <rect width="512" height="512" rx="114" fill="#5B21B6" />
            <g transform="translate(59, 49) scale(0.773)">
              <path d={MARK_PATH} fill="#ffffff" />
            </g>
          </svg>
          <SidebarLabel>
            <div className="flex items-baseline gap-1">
              <span className="font-mono text-sm font-bold text-violet-400">MCP</span>
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
