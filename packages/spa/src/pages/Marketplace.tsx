import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Search, Package, Key } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/catalyst/card';
import { Input } from '@/components/catalyst/input';
import { Badge } from '@/components/catalyst/badge';
import { Button } from '@/components/catalyst/button';
import { Skeleton } from '@/components/catalyst/skeleton';
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
      <div className="flex items-center justify-between pb-4 border-b border-border mb-6">
        <div>
          <h1 className="text-xl font-semibold">Marketplace</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Discover and subscribe to MCP servers
          </p>
        </div>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
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
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-6 w-3/4" />
                <Skeleton className="h-4 w-full" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-20 w-full" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : filteredMcps.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No MCPs Found</CardTitle>
            <CardDescription>
              {searchQuery
                ? 'No MCPs match your search criteria. Try a different search term.'
                : 'No MCPs are currently available in the marketplace.'}
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filteredMcps.map((mcp) => (
            <Card key={mcp.id} className="flex flex-col border border-border rounded-md p-4 hover:border-primary transition-colors">
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="font-semibold text-base">{mcp.name}</h3>
                  <Package className="h-5 w-5 text-muted-foreground shrink-0" />
                </div>
                <p className="text-sm text-muted-foreground line-clamp-2">
                  {mcp.description || 'No description available'}
                </p>
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
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
                <Button asChild color="zinc" className="text-sm w-full">
                  <Link to={`/app/marketplace/${mcp.id}`}>
                    View Details
                  </Link>
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
