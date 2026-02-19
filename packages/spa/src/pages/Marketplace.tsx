import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function Marketplace() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Marketplace</h1>
        <p className="text-muted-foreground">
          Discover and install MCP servers
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Coming Soon</CardTitle>
          <CardDescription>
            The MCP Marketplace is under development
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Browse and install MCP servers from the marketplace. This feature
            will allow you to discover new MCPs and add them to your clients.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
