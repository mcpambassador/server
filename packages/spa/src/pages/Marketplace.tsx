import { useState } from 'react';
import { Search, Package, Key } from 'lucide-react';
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
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
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
            <div key={i} className="rounded-lg bg-white p-6 ring-1 ring-zinc-950/5">
              <div className="animate-pulse space-y-3">
                <div className="h-6 w-3/4 rounded bg-zinc-200" />
                <div className="h-4 w-full rounded bg-zinc-200" />
                <div className="h-20 w-full rounded bg-zinc-200" />
              </div>
            </div>
          ))}
        </div>
      ) : filteredMcps.length === 0 ? (
        <div className="rounded-lg bg-white p-6 ring-1 ring-zinc-950/5 text-center">
          <h3 className="text-base/7 font-semibold text-zinc-900">No MCPs Found</h3>
          <p className="mt-2 text-sm/6 text-zinc-500">
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
              className="flex flex-col rounded-lg bg-white p-6 ring-1 ring-zinc-950/5 hover:ring-zinc-950/10 transition-shadow"
            >
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="text-base/7 font-semibold text-zinc-900">{mcp.name}</h3>
                  <Package className="h-5 w-5 text-zinc-400 shrink-0" />
                </div>
                <p className="text-sm/6 text-zinc-500 line-clamp-2">
                  {mcp.description || 'No description available'}
                </p>
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-xs text-zinc-500">
                    <Package className="h-3.5 w-3.5" />
                    <span>{mcp.tools.length} tools</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Badge color="zinc" className="text-xs">
                      {mcp.isolationMode === 'per-user' ? 'Per-User' : 'Shared'}
                    </Badge>
                    {mcp.requiresUserCredentials && (
                      <Badge color="zinc" className="text-xs">
                        <Key className="h-3 w-3 mr-1" />
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
