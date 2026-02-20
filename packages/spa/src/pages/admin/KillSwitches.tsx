import { useState } from 'react';
import { Power, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/catalyst/card';
import { Badge } from '@/components/catalyst/badge';
import { Button } from '@/components/catalyst/button';
import {
  Alert,
  AlertDescription,
  AlertActions,
  AlertTitle,
} from '@/components/catalyst/alert';
import { useAdminClients, useAdminMcps, useKillSwitch } from '@/api/hooks/use-admin';
import { usePageTitle } from '@/hooks/usePageTitle';

export function KillSwitches() {
  usePageTitle('Admin - Kill Switches');
  const { data: clientsData, isLoading: clientsLoading } = useAdminClients();
  const { data: mcpsData, isLoading: mcpsLoading } = useAdminMcps();
  const killSwitch = useKillSwitch();

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
      toast.error('Kill switch failed', { description: (error as Error)?.message ?? String(error) });
    }
  };

  return (
    <div className="space-y-6">
      <div className="pb-4 border-b border-border mb-6">
        <h1 className="text-xl font-semibold">Kill Switches</h1>
        <p className="text-sm text-muted-foreground">
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
                    <Badge color={client.status === 'active' ? 'teal' : 'zinc'}>
                      {client.status}
                    </Badge>
                    <Button
                      color={client.status === 'active' ? 'red' : 'teal'}
                      className="h-8"
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
                      color={
                        mcp.status === 'published'
                          ? 'teal'
                          : mcp.status === 'draft'
                          ? 'zinc'
                          : 'zinc'
                      }
                    >
                      {mcp.status}
                    </Badge>
                    <Button
                      color={mcp.status === 'published' ? 'red' : 'teal'}
                      className="h-8"
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
      <Alert open={confirmDialogOpen} onClose={setConfirmDialogOpen}>
        
          
            <AlertTitle>
              {selectedTarget?.enabled ? 'Disable' : 'Enable'} {selectedTarget?.target}?
            </AlertTitle>
            <AlertDescription>
              {selectedTarget?.enabled
                ? 'This will immediately block all requests from this entity. Active connections may be terminated.'
                : 'This will re-enable access for this entity.'}
            </AlertDescription>
          
          <AlertActions>
            <Button plain onClick={() => setSelectedTarget(null)}>
              Cancel
            </Button>
            <Button color="red"
              onClick={handleConfirm}
              className={
                selectedTarget?.enabled
                  ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                  : ''
              }
            >
              {selectedTarget?.enabled ? 'Disable' : 'Enable'}
            </Button>
          </AlertActions>
        
      </Alert>
    </div>
  );
}
