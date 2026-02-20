import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { usePageTitle } from '@/hooks/usePageTitle';

export function Subscriptions() {
  usePageTitle('My Subscriptions');
  return (
    <div className="space-y-6">
      <div className="pb-4 border-b border-border mb-6">
        <h1 className="text-xl font-semibold">My Subscriptions</h1>
        <p className="text-sm text-muted-foreground">
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
