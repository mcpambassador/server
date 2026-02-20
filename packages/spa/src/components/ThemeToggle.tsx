import { Moon, Sun, Monitor } from 'lucide-react';
import {
  Dropdown,
  DropdownButton,
  DropdownMenu,
  DropdownItem,
} from '@/components/catalyst/dropdown';
import { useTheme } from '@/stores/theme';

export function ThemeToggle() {
  const { setTheme } = useTheme();

  return (
    <Dropdown>
      <DropdownButton plain className="p-1">
        <Sun className="h-[1.2rem] w-[1.2rem] rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
        <Moon className="absolute h-[1.2rem] w-[1.2rem] rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
        <span className="sr-only">Toggle theme</span>
      </DropdownButton>
      <DropdownMenu anchor="bottom end">
        <DropdownItem onClick={() => setTheme('light')}>
          <Sun className="mr-2 h-4 w-4" />
          <span>Light</span>
        </DropdownItem>
        <DropdownItem onClick={() => setTheme('dark')}>
          <Moon className="mr-2 h-4 w-4" />
          <span>Dark</span>
        </DropdownItem>
        <DropdownItem onClick={() => setTheme('system')}>
          <Monitor className="mr-2 h-4 w-4" />
          <span>System</span>
        </DropdownItem>
      </DropdownMenu>
    </Dropdown>
  );
}
