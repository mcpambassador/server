import { useState } from 'react';
import { MagnifyingGlassIcon, CubeIcon, KeyIcon } from '@heroicons/react/20/solid';
import { Heading } from '@/components/catalyst/heading';
import { Text } from '@/components/catalyst/text';
import { Input } from '@/components/catalyst/input';
import { Badge } from '@/components/catalyst/badge';
import { Button } from '@/components/catalyst/button';
import { useMarketplace } from '@/api/hooks/use-marketplace';
import { usePageTitle } from '@/hooks/usePageTitle';

export function Marketplace() {
  usePageTitle('Marketplace');
  const { data: marketplace, isLoading } = useMarketplace();
  const [searchQuery, setSearchQuery] = useState('');

  const filteredMcps = marketplace?.data?.filter((mcp) =>
    mcp.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    mcp.description?.toLowerCase().includes(searchQuery.toLowerCase())
  ) ?? [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <Heading>Marketplace</Heading>
        <Text>Discover and subscribe to MCP servers</Text>
      </div>

      {/* Search */}
      <div className="relative">
        <MagnifyingGlassIcon className="absolute left-3 top-1/2 size-5 -translate-y-1/2 text-zinc-400 dark:text-zinc-500" />
        <Input
          placeholder="Search MCPs..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-10"
        />
      </div>

      {/* MCP Grid */}
      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="rounded-lg bg-white dark:bg-white/5 p-6 ring-1 ring-zinc-950/5 dark:ring-white/10">
              <div className="animate-pulse space-y-3">
                <div className="h-6 w-3/4 rounded bg-zinc-200 dark:bg-zinc-700" />
                <div className="h-4 w-full rounded bg-zinc-200 dark:bg-zinc-700" />
                <div className="h-20 w-full rounded bg-zinc-200 dark:bg-zinc-700" />
              </div>
            </div>
          ))}
        </div>
      ) : filteredMcps.length === 0 ? (
        <div className="rounded-lg bg-white dark:bg-white/5 p-6 ring-1 ring-zinc-950/5 dark:ring-white/10 text-center">
          <h3 className="text-base/7 font-semibold text-zinc-900 dark:text-white">No MCPs Found</h3>
          <p className="mt-2 text-sm/6 text-zinc-500 dark:text-zinc-400">
            {searchQuery
              ? 'No MCPs match your search criteria. Try a different search term.'
              : 'No MCPs are currently available in the marketplace.'}
          </p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filteredMcps.map((mcp) => (
            <div
              key={mcp.id}
              className="flex flex-col rounded-lg bg-white dark:bg-white/5 p-6 ring-1 ring-zinc-950/5 dark:ring-white/10 hover:ring-zinc-950/10 dark:hover:ring-white/20 transition-shadow"
            >
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="text-base/7 font-semibold text-zinc-900 dark:text-white">{mcp.name}</h3>
                  <CubeIcon className="size-5 text-zinc-400 dark:text-zinc-500 shrink-0" />
                </div>
                <p className="text-sm/6 text-zinc-500 dark:text-zinc-400 line-clamp-2">
                  {mcp.description || 'No description available'}
                </p>
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                    <CubeIcon className="size-3.5" />
                    <span>{mcp.tools.length} tools</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Badge color="zinc" className="text-xs">
                      {mcp.isolationMode === 'per-user' ? 'Per-User' : 'Shared'}
                    </Badge>
                    {mcp.requiresUserCredentials && (
                      <Badge color="zinc" className="text-xs">
                        <KeyIcon className="size-3 mr-1" />
                        Credentials
                      </Badge>
                    )}
                  </div>
                </div>
                <Button href={`/app/marketplace/${mcp.id}`} color="zinc" className="w-full">
                  View Details
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
