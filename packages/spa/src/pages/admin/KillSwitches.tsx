import { useState } from 'react';
import { Power, AlertTriangle } from 'lucide-react';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useAdminClients, useAdminMcps, useKillSwitch } from '@/api/hooks/use-admin';
import { usePageTitle } from '@/hooks/usePageTitle';

export function KillSwitches() {
  usePageTitle('Admin - Kill Switches');
  const { data: clientsData, isLoading: clientsLoading } = useAdminClients();
  const { data: mcpsData, isLoading: mcpsLoading } = useAdminMcps();
  const killSwitch = useKillSwitch();
  const { addToast } = useToast();

  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false);
  const [selectedTarget, setSelectedTarget] = useState<{ target: string; enabled: boolean } | null>(
    null
  );

  const handleToggle = (target: string, currentlyEnabled: boolean) => {
    setSelectedTarget({ target, enabled: !currentlyEnabled });
    setConfirmDialogOpen(true);
  };

  const handleConfirm = async () => {
    if (!selectedTarget) return;
    try {
      await killSwitch.mutateAsync({
        target: selectedTarget.target,
        enabled: selectedTarget.enabled,
      });
      setConfirmDialogOpen(false);
      setSelectedTarget(null);
    } catch (error) {
      addToast({ title: 'Kill switch failed', description: (error as Error)?.message ?? String(error), variant: 'destructive' });
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Kill Switches</h1>
        <p className="text-muted-foreground">
          Emergency controls to disable clients or MCPs
        </p>
      </div>

      <Card className="border-destructive">
        <CardHeader>
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-destructive" />
            <CardTitle className="text-destructive">Warning</CardTitle>
          </div>
          <CardDescription>
            Kill switches immediately disable access. Use with caution. Disabled entities will
            not be able to make requests until re-enabled.
          </CardDescription>
        </CardHeader>
      </Card>

      {/* Client Kill Switches */}
      <Card>
        <CardHeader>
          <CardTitle>Client Kill Switches</CardTitle>
          <CardDescription>
            Disable individual API clients
          </CardDescription>
        </CardHeader>
        <CardContent>
          {clientsLoading ? (
            <p className="text-sm text-muted-foreground">Loading clients...</p>
          ) : clientsData && clientsData.data.length > 0 ? (
            <div className="space-y-3">
              {clientsData.data.map((client: any) => (
                <div
                  key={client.client_id || client.id}
                  className="flex items-center justify-between p-3 border rounded-lg"
                >
                  <div>
                    <p className="font-medium">{client.client_name || client.clientName}</p>
                    <p className="text-sm text-muted-foreground">
                      {client.key_prefix || client.keyPrefix}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge variant={client.status === 'active' ? 'default' : 'secondary'}>
                      {client.status}
                    </Badge>
                    <Button
                      variant={client.status === 'active' ? 'destructive' : 'default'}
                      size="sm"
                      onClick={() =>
                        handleToggle(
                          `client:${client.client_id || client.id}`,
                          client.status === 'active'
                        )
                      }
                    >
                      <Power className="mr-2 h-4 w-4" />
                      {client.status === 'active' ? 'Disable' : 'Enable'}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No clients found</p>
          )}
        </CardContent>
      </Card>

      {/* MCP Kill Switches */}
      <Card>
        <CardHeader>
          <CardTitle>MCP Kill Switches</CardTitle>
          <CardDescription>
            Disable MCP servers system-wide
          </CardDescription>
        </CardHeader>
        <CardContent>
          {mcpsLoading ? (
            <p className="text-sm text-muted-foreground">Loading MCPs...</p>
          ) : mcpsData && mcpsData.data.length > 0 ? (
            <div className="space-y-3">
              {mcpsData.data.map((mcp) => (
                <div
                  key={mcp.mcp_id}
                  className="flex items-center justify-between p-3 border rounded-lg"
                >
                  <div>
                    <p className="font-medium">{mcp.display_name}</p>
                    <p className="text-sm text-muted-foreground font-mono">{mcp.name}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge
                      variant={
                        mcp.status === 'published'
                          ? 'default'
                          : mcp.status === 'draft'
                          ? 'secondary'
                          : 'outline'
                      }
                    >
                      {mcp.status}
                    </Badge>
                    <Button
                      variant={mcp.status === 'published' ? 'destructive' : 'default'}
                      size="sm"
                      onClick={() =>
                        handleToggle(`mcp:${mcp.name}`, mcp.status === 'published')
                      }
                      disabled={mcp.status === 'archived'}
                    >
                      <Power className="mr-2 h-4 w-4" />
                      {mcp.status === 'published' ? 'Disable' : 'Enable'}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No MCPs found</p>
          )}
        </CardContent>
      </Card>

      {/* Confirmation Dialog */}
      <AlertDialog open={confirmDialogOpen} onOpenChange={setConfirmDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {selectedTarget?.enabled ? 'Disable' : 'Enable'} {selectedTarget?.target}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {selectedTarget?.enabled
                ? 'This will immediately block all requests from this entity. Active connections may be terminated.'
                : 'This will re-enable access for this entity.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setSelectedTarget(null)}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirm}
              className={
                selectedTarget?.enabled
                  ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                  : ''
              }
            >
              {selectedTarget?.enabled ? 'Disable' : 'Enable'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
