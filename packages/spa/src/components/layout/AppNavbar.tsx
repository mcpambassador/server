import { useNavigate } from 'react-router-dom';
import { User, LogOut } from 'lucide-react';
import { Navbar, NavbarSpacer } from '@/components/catalyst/navbar';
import { Avatar } from '@/components/catalyst/avatar';
import { Dropdown, DropdownButton, DropdownMenu, DropdownItem, DropdownDivider } from '@/components/catalyst/dropdown';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { authApi } from '@/api/auth';

export function AppNavbar() {
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

  const userInitials = session?.user.username
    ? session.user.username.substring(0, 2).toUpperCase()
    : 'U';

  return (
    <Navbar>
      <NavbarSpacer />
      <Dropdown>
        <DropdownButton as="div" className="cursor-pointer">
          <Avatar initials={userInitials} className="size-8 bg-slate-700 text-white" />
        </DropdownButton>
        <DropdownMenu anchor="bottom end">
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
    </Navbar>
  );
}
