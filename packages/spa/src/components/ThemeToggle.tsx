import { SunIcon, MoonIcon, ComputerDesktopIcon } from '@heroicons/react/20/solid';
import {
  Dropdown,
  DropdownButton,
  DropdownMenu,
  DropdownItem,
  DropdownLabel,
} from '@/components/catalyst/dropdown';
import { useTheme } from '@/stores/theme';

export function ThemeToggle() {
  const { setTheme } = useTheme();

  return (
    <Dropdown>
      <DropdownButton plain className="p-1">
        <SunIcon className="size-5 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
        <MoonIcon className="absolute size-5 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
        <span className="sr-only">Toggle theme</span>
      </DropdownButton>
      <DropdownMenu anchor="bottom end">
        <DropdownItem onClick={() => setTheme('light')}>
          <SunIcon />
          <DropdownLabel>Light</DropdownLabel>
        </DropdownItem>
        <DropdownItem onClick={() => setTheme('dark')}>
          <MoonIcon />
          <DropdownLabel>Dark</DropdownLabel>
        </DropdownItem>
        <DropdownItem onClick={() => setTheme('system')}>
          <ComputerDesktopIcon />
          <DropdownLabel>System</DropdownLabel>
        </DropdownItem>
      </DropdownMenu>
    </Dropdown>
  );
}
