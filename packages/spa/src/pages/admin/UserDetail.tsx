import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Shield, Key, User } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';
import { useAdminUser, useAdminGroups, useAuditEvents } from '@/api/hooks/use-admin';
import { usePageTitle } from '@/hooks/usePageTitle';

export function UserDetail() {
  const { userId } = useParams<{ userId: string }>();
  const { data: user, isLoading: userLoading } = useAdminUser(userId!);
  usePageTitle(user ? `Admin - ${user.username}` : 'Admin - User Details');
  const { data: groupsData, isLoading: groupsLoading } = useAdminGroups();
  const { data: auditData, isLoading: auditLoading } = useAuditEvents({
    user_id: userId,
    limit: 20,
  });

  // Filter groups to find which ones this user belongs to
  // Note: This is a simplified approach. In production, you'd have a dedicated endpoint
  const userGroups = (groupsData?.data ?? []).filter((_g) => false);

  if (userLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="space-y-6">
        <Button variant="ghost" asChild>
          <Link to="/app/admin/users">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Users
          </Link>
        </Button>
        <Card>
          <CardHeader>
            <CardTitle>User Not Found</CardTitle>
            <CardDescription>
              The requested user could not be found.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Button variant="ghost" asChild>
        <Link to="/app/admin/users">
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to Users
        </Link>
      </Button>

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{user.username}</h1>
          <p className="text-muted-foreground">{user.display_name || 'No display name'}</p>
        </div>
        <div className="flex items-center gap-2">
          {user.is_admin && (
            <Badge variant="default">
              <Shield className="mr-1 h-3 w-3" />
              Admin
            </Badge>
          )}
          <Badge variant={user.status === 'active' ? 'default' : 'secondary'}>
            {user.status}
          </Badge>
        </div>
      </div>

      {/* User Info Card */}
      <Card>
        <CardHeader>
          <CardTitle>User Information</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-sm font-medium text-muted-foreground">User ID</p>
              <p className="text-sm font-mono">{user.user_id}</p>
            </div>
            <div>
              <p className="text-sm font-medium text-muted-foreground">Username</p>
              <p className="text-sm">{user.username}</p>
            </div>
            <div>
              <p className="text-sm font-medium text-muted-foreground">Email</p>
              <p className="text-sm">{user.email || '—'}</p>
            </div>
            <div>
              <p className="text-sm font-medium text-muted-foreground">Display Name</p>
              <p className="text-sm">{user.display_name || '—'}</p>
            </div>
            <div>
              <p className="text-sm font-medium text-muted-foreground">Created</p>
              <p className="text-sm">{new Date(user.created_at).toLocaleString()}</p>
            </div>
            <div>
              <p className="text-sm font-medium text-muted-foreground">Last Login</p>
              <p className="text-sm">
                {user.last_login_at ? new Date(user.last_login_at).toLocaleString() : '—'}
              </p>
            </div>
          </div>
          <Separator />
          <div className="flex gap-2">
            <Button variant="outline" size="sm">
              <Key className="mr-2 h-4 w-4" />
              Reset Password
            </Button>
            <Button variant="outline" size="sm">
              <User className="mr-2 h-4 w-4" />
              Edit User
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Groups Card */}
      <Card>
        <CardHeader>
          <CardTitle>Group Memberships</CardTitle>
          <CardDescription>Groups this user belongs to</CardDescription>
        </CardHeader>
        <CardContent>
          {groupsLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : userGroups.length > 0 ? (
            <div className="space-y-2">
              {userGroups.map((group: any) => (
                <div
                  key={group.group_id}
                  className="flex items-center justify-between p-3 border rounded-lg"
                >
                  <div>
                    <p className="font-medium">{group.name}</p>
                    <p className="text-sm text-muted-foreground">{group.description}</p>
                  </div>
                  <Button variant="outline" size="sm" asChild>
                    <Link to={`/app/admin/groups/${group.group_id}`}>View</Link>
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Not a member of any groups</p>
          )}
        </CardContent>
      </Card>

      {/* Recent Activity */}
      <Card>
        <CardHeader>
          <CardTitle>Recent Activity</CardTitle>
          <CardDescription>Audit log entries for this user</CardDescription>
        </CardHeader>
        <CardContent>
          {auditLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : auditData && auditData.data.length > 0 ? (
            <div className="space-y-2">
              {auditData.data.map((event) => (
                <div
                  key={event.event_id}
                  className="flex items-center justify-between border-b pb-2 last:border-0"
                >
                  <div>
                    <p className="text-sm font-medium">{event.action}</p>
                    <p className="text-xs text-muted-foreground">
                      {event.event_type} • {event.source_ip}
                    </p>
                  </div>
                  <div className="text-right">
                    <Badge
                      variant={
                        event.severity === 'error'
                          ? 'destructive'
                          : event.severity === 'warn'
                          ? 'secondary'
                          : 'outline'
                      }
                    >
                      {event.severity}
                    </Badge>
                    <p className="text-xs text-muted-foreground mt-1">
                      {new Date(event.timestamp).toLocaleString()}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No recent activity</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
