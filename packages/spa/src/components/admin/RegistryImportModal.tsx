/**
 * RegistryImportModal
 *
 * A searchable browser for community registry MCPs, used by the MCP creation
 * wizard to pre-fill all wizard fields from a selected registry entry.
 *
 * The modal fetches the registry list (reusing the existing useRegistry hook),
 * lets the admin filter by search text or category, and emits an `onSelect`
 * callback with the chosen RegistryMcp when the admin clicks "Use this MCP".
 */
import { useState } from 'react';
import {
  MagnifyingGlassIcon,
  CubeIcon,
  CheckBadgeIcon,
  XMarkIcon,
} from '@heroicons/react/20/solid';
import { Dialog, DialogTitle, DialogBody, DialogActions } from '@/components/catalyst/dialog';
import { Button } from '@/components/catalyst/button';
import { Badge } from '@/components/catalyst/badge';
import { Input } from '@/components/catalyst/input';
import { useRegistry } from '@/api/hooks/use-registry';
import type { RegistryMcp } from '@/api/types';

const CATEGORIES = [
  'all',
  'Developer Tools',
  'Finance & Data',
  'Search & Web',
  'Productivity',
  'Utilities',
];

function getTransportColor(transport: string): 'blue' | 'zinc' {
  return transport === 'http' ? 'blue' : 'zinc';
}

function getAuthColor(authType: string): 'green' | 'amber' | 'purple' | 'zinc' {
  switch (authType) {
    case 'none':
      return 'green';
    case 'static':
      return 'amber';
    case 'oauth2':
      return 'purple';
    default:
      return 'zinc';
  }
}

function getAuthLabel(authType: string): string {
  switch (authType) {
    case 'none':
      return 'No Auth';
    case 'static':
      return 'API Key';
    case 'oauth2':
      return 'OAuth2';
    default:
      return authType;
  }
}

export interface RegistryImportModalProps {
  /** Controls dialog visibility */
  open: boolean;
  /** Called when the admin closes the dialog without selecting */
  onClose: () => void;
  /**
   * Called when the admin selects a registry entry to import.
   * The parent is responsible for pre-filling form state from the entry.
   */
  onSelect: (entry: RegistryMcp) => void;
}

/**
 * Modal dialog for browsing and selecting a community registry MCP.
 * Renders a search input, category badges, and a scrollable grid of cards.
 */
export function RegistryImportModal({ open, onClose, onSelect }: RegistryImportModalProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');

  const { data: registryData, isLoading, isError } = useRegistry();

  const filteredMcps =
    registryData?.mcps?.filter((mcp) => {
      const q = searchQuery.toLowerCase();
      const matchesSearch =
        mcp.name.toLowerCase().includes(q) ||
        mcp.display_name.toLowerCase().includes(q) ||
        mcp.description.toLowerCase().includes(q) ||
        mcp.tags.some((tag) => tag.toLowerCase().includes(q));

      const matchesCategory =
        selectedCategory === 'all' || mcp.category === selectedCategory;

      return matchesSearch && matchesCategory;
    }) ?? [];

  const handleSelect = (mcp: RegistryMcp) => {
    onSelect(mcp);
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} size="4xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <DialogTitle>Import from Community Registry</DialogTitle>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Select an MCP to pre-fill the wizard. You can review and edit all values before
            creating.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-500"
          aria-label="Close registry browser"
        >
          <XMarkIcon className="size-5" />
        </button>
      </div>

      <DialogBody>
        {/* Search */}
        <div className="relative mb-4">
          <MagnifyingGlassIcon className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-400 dark:text-zinc-500" />
          <Input
            placeholder="Search by name, description, or tag..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
            aria-label="Search registry MCPs"
          />
        </div>

        {/* Category filter */}
        <div className="flex flex-wrap gap-2 mb-4" role="group" aria-label="Filter by category">
          {CATEGORIES.map((cat) => (
            <Badge
              key={cat}
              color={selectedCategory === cat ? 'blue' : 'zinc'}
              className="cursor-pointer select-none"
              role="button"
              tabIndex={0}
              onClick={() => setSelectedCategory(cat)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setSelectedCategory(cat);
                }
              }}
            >
              {cat === 'all' ? 'All Categories' : cat}
            </Badge>
          ))}
        </div>

        {/* MCP list */}
        <div className="max-h-[55vh] overflow-y-auto pr-1">
          {isLoading && (
            <div className="grid gap-3 sm:grid-cols-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <div
                  key={i}
                  className="animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-800 p-4 space-y-2"
                >
                  <div className="h-5 w-3/4 rounded bg-zinc-200 dark:bg-zinc-700" />
                  <div className="h-4 w-full rounded bg-zinc-200 dark:bg-zinc-700" />
                  <div className="h-4 w-2/3 rounded bg-zinc-200 dark:bg-zinc-700" />
                </div>
              ))}
            </div>
          )}

          {isError && (
            <div className="py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
              Failed to load registry. Ensure the registry is enabled and try refreshing.
            </div>
          )}

          {!isLoading && !isError && filteredMcps.length === 0 && (
            <div className="py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
              {searchQuery || selectedCategory !== 'all'
                ? 'No MCPs match your search. Try different terms or categories.'
                : 'No MCPs are available in the community registry.'}
            </div>
          )}

          {!isLoading && !isError && filteredMcps.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2">
              {filteredMcps.map((mcp) => (
                <button
                  key={mcp.name}
                  type="button"
                  onClick={() => handleSelect(mcp)}
                  className="text-left flex flex-col gap-2 rounded-lg bg-zinc-50 dark:bg-zinc-800/60 p-4 ring-1 ring-zinc-200 dark:ring-zinc-700 hover:ring-zinc-400 dark:hover:ring-zinc-500 hover:bg-white dark:hover:bg-zinc-800 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-500"
                  aria-label={`Import ${mcp.display_name}`}
                >
                  {/* Card header */}
                  <div className="flex items-start gap-3">
                    {mcp.icon_url ? (
                      <img
                        src={mcp.icon_url}
                        alt=""
                        className="size-8 rounded shrink-0"
                      />
                    ) : (
                      <CubeIcon className="size-8 text-zinc-400 dark:text-zinc-500 shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="font-semibold text-sm text-zinc-900 dark:text-white truncate">
                          {mcp.display_name}
                        </span>
                        {mcp.verified && (
                          <CheckBadgeIcon className="size-4 text-green-600 dark:text-green-500 shrink-0" />
                        )}
                        {mcp.installed && (
                          <Badge color="green" className="text-xs">
                            Installed
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-zinc-500 dark:text-zinc-400">{mcp.name}</p>
                    </div>
                  </div>

                  {/* Description */}
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 line-clamp-2">
                    {mcp.description}
                  </p>

                  {/* Badges */}
                  <div className="flex flex-wrap gap-1">
                    <Badge color={getTransportColor(mcp.transport_type)} className="text-xs">
                      {mcp.transport_type.toUpperCase()}
                    </Badge>
                    <Badge color={getAuthColor(mcp.auth_type)} className="text-xs">
                      {getAuthLabel(mcp.auth_type)}
                    </Badge>
                    <Badge color="zinc" className="text-xs">
                      {mcp.isolation_mode === 'per_user' ? 'Per-User' : 'Shared'}
                    </Badge>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </DialogBody>

      <DialogActions>
        <Button color="zinc" onClick={onClose}>
          Cancel
        </Button>
      </DialogActions>
    </Dialog>
  );
}
