import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function McpsAdmin() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">MCP Management</h1>
        <p className="text-muted-foreground">
          Administer MCP servers and configurations
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Coming Soon</CardTitle>
          <CardDescription>
            MCP management interface is under development
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Manage all MCP server installations. Configure server settings,
            monitor health, and control access permissions.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
