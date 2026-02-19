import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Search, Package, Key } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useMarketplace } from '@/api/hooks/use-marketplace';

export function Marketplace() {
  const { data: marketplace, isLoading } = useMarketplace();
  const [searchQuery, setSearchQuery] = useState('');

  const filteredMcps = marketplace?.data?.filter((mcp) =>
    mcp.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    mcp.description?.toLowerCase().includes(searchQuery.toLowerCase())
  ) ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Marketplace</h1>
        <p className="text-muted-foreground">
          Discover and subscribe to MCP servers
        </p>
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
            <Card key={mcp.id} className="flex flex-col hover:shadow-lg transition-shadow">
              <CardHeader>
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="text-lg">{mcp.name}</CardTitle>
                  <Package className="h-5 w-5 text-muted-foreground shrink-0" />
                </div>
                <CardDescription className="line-clamp-2">
                  {mcp.description || 'No description available'}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex-1 flex flex-col justify-between space-y-4">
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Package className="h-4 w-4" />
                    <span>{mcp.tools.length} tools</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Badge variant="outline">
                      {mcp.isolationMode === 'per-user' ? 'Per-User' : 'Shared'}
                    </Badge>
                    {mcp.requiresUserCredentials && (
                      <Badge variant="secondary">
                        <Key className="h-3 w-3 mr-1" />
                        Credentials
                      </Badge>
                    )}
                  </div>
                </div>
                <Button asChild className="w-full">
                  <Link to={`/app/marketplace/${mcp.id}`}>
                    View Details
                  </Link>
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
