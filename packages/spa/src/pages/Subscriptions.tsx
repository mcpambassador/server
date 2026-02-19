import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function Subscriptions() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">My Subscriptions</h1>
        <p className="text-muted-foreground">
          View your active MCP subscriptions
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Coming Soon</CardTitle>
          <CardDescription>
            Subscription management interface is under development
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Manage your active subscriptions to MCP servers. View usage,
            billing details, and subscription history.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
