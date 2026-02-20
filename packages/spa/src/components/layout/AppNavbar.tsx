import { useNavigate } from 'react-router-dom';
import { UserCircleIcon, ArrowRightStartOnRectangleIcon } from '@heroicons/react/16/solid';
import { Navbar, NavbarSection, NavbarSpacer, NavbarItem } from '@/components/catalyst/navbar';
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
      <NavbarSection>
        <Dropdown>
          <DropdownButton as={NavbarItem}>
            <Avatar initials={userInitials} className="bg-slate-700 text-white" square />
          </DropdownButton>
          <DropdownMenu anchor="bottom end">
            <DropdownItem href="/app/profile">
              <UserCircleIcon />
              <DropdownLabel>Profile</DropdownLabel>
            </DropdownItem>
            <DropdownDivider />
            <DropdownItem onClick={handleLogout}>
              <ArrowRightStartOnRectangleIcon />
              <DropdownLabel>Log out</DropdownLabel>
            </DropdownItem>
          </DropdownMenu>
        </Dropdown>
      </NavbarSection>
    </Navbar>
  );
}
