import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function Clients() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">My Clients</h1>
        <p className="text-muted-foreground">
          Manage your MCP clients and connections
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Coming Soon</CardTitle>
          <CardDescription>
            Client management interface is under development
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            View and manage all your MCP client connections. Monitor their
            status, configure settings, and troubleshoot issues.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
