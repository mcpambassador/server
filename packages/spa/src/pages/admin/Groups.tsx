import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function GroupsAdmin() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Group Management</h1>
        <p className="text-muted-foreground">
          Manage user groups and access control
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Coming Soon</CardTitle>
          <CardDescription>
            Group management interface is under development
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Create and manage user groups. Define group-level permissions and
            organize users by department or role.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
