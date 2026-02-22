import { useState } from 'react';
import { PowerIcon, ExclamationTriangleIcon, ServerIcon, CubeIcon } from '@heroicons/react/20/solid';
import { toast } from 'sonner';
import { Heading } from '@/components/catalyst/heading';
import { Text } from '@/components/catalyst/text';
import { Badge } from '@/components/catalyst/badge';
import { Button } from '@/components/catalyst/button';
import { Alert, AlertTitle, AlertDescription, AlertActions } from '@/components/catalyst/alert';
import { useAdminClients, useAdminMcps, useKillSwitch } from '@/api/hooks/use-admin';
import { usePageTitle } from '@/hooks/usePageTitle';
import { EmptyState } from '@/components/shared/EmptyState';

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
      {/* Page Header */}
      <div>
        <Heading>Kill Switches</Heading>
        <Text>Emergency controls to disable clients or MCPs</Text>
      </div>

      {/* Warning Banner */}
      <div className="rounded-lg bg-red-50 dark:bg-red-950/50 p-4 ring-1 ring-red-200 dark:ring-red-800">
        <div className="flex items-center gap-2">
          <ExclamationTriangleIcon className="size-5 text-red-600 dark:text-red-400" />
          <h3 className="text-sm/6 font-semibold text-red-900 dark:text-red-200">Warning</h3>
        </div>
        <p className="mt-1 text-sm/6 text-red-700 dark:text-red-300">
          Kill switches immediately disable access. Use with caution. Disabled entities will not be
          able to make requests until re-enabled.
        </p>
      </div>

      {/* Client Kill Switches */}
      <div className="rounded-lg bg-white dark:bg-white/5 p-6 ring-1 ring-zinc-950/10 dark:ring-white/10">
        <h3 className="text-base/7 font-semibold text-zinc-900 dark:text-white">Client Kill Switches</h3>
        <p className="text-sm/6 text-zinc-500 dark:text-zinc-400">Disable individual API clients</p>
        <div className="mt-4">
          {clientsLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="flex items-center justify-between py-3 animate-pulse"
                >
                  <div className="space-y-2">
                    <div className="h-4 w-32 rounded bg-zinc-200 dark:bg-zinc-700" />
                    <div className="h-3 w-24 rounded bg-zinc-200 dark:bg-zinc-700" />
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="h-5 w-16 rounded bg-zinc-200 dark:bg-zinc-700" />
                    <div className="h-8 w-20 rounded bg-zinc-200 dark:bg-zinc-700" />
                  </div>
                </div>
              ))}
            </div>
          ) : clientsData && clientsData.data.length > 0 ? (
            <div className="divide-y divide-zinc-950/5 dark:divide-white/10">
              {clientsData.data.map((client: any) => (
                <div
                  key={client.client_id || client.id}
                  className="flex items-center justify-between py-3"
                >
                  <div>
                    <p className="text-sm/6 font-medium text-zinc-900 dark:text-white">
                      {client.client_name || client.clientName}
                    </p>
                    <p className="text-sm/6 font-mono text-zinc-500 dark:text-zinc-400">
                      {client.key_prefix || client.keyPrefix}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge color={client.status === 'active' ? 'green' : 'zinc'}>
                      {client.status}
                    </Badge>
                    <Button
                      color={client.status === 'active' ? 'red' : 'green'}
                      onClick={() =>
                        handleToggle(
                          `client:${client.client_id || client.id}`,
                          client.status === 'active'
                        )
                      }
                    >
                      <PowerIcon data-slot="icon" />
                      {client.status === 'active' ? 'Disable' : 'Enable'}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              icon={<ServerIcon className="size-6 text-zinc-400" />}
              title="No clients found"
              description="API clients will appear here once they are registered."
            />
          )}
        </div>
      </div>

      {/* MCP Kill Switches */}
      <div className="rounded-lg bg-white dark:bg-white/5 p-6 ring-1 ring-zinc-950/10 dark:ring-white/10">
        <h3 className="text-base/7 font-semibold text-zinc-900 dark:text-white">MCP Kill Switches</h3>
        <p className="text-sm/6 text-zinc-500 dark:text-zinc-400">Disable MCP servers system-wide</p>
        <div className="mt-4">
          {mcpsLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="flex items-center justify-between py-3 animate-pulse"
                >
                  <div className="space-y-2">
                    <div className="h-4 w-32 rounded bg-zinc-200 dark:bg-zinc-700" />
                    <div className="h-3 w-24 rounded bg-zinc-200 dark:bg-zinc-700" />
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="h-5 w-16 rounded bg-zinc-200 dark:bg-zinc-700" />
                    <div className="h-8 w-20 rounded bg-zinc-200 dark:bg-zinc-700" />
                  </div>
                </div>
              ))}
            </div>
          ) : mcpsData && mcpsData.data.length > 0 ? (
            <div className="divide-y divide-zinc-950/5 dark:divide-white/10">
              {mcpsData.data.map((mcp) => (
                <div key={mcp.mcp_id} className="flex items-center justify-between py-3">
                  <div>
                    <p className="text-sm/6 font-medium text-zinc-900 dark:text-white">{mcp.display_name}</p>
                    <p className="text-sm/6 font-mono text-zinc-500 dark:text-zinc-400">{mcp.name}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge
                      color={
                        mcp.status === 'published'
                          ? 'green'
                          : mcp.status === 'draft'
                            ? 'zinc'
                            : 'zinc'
                      }
                    >
                      {mcp.status}
                    </Badge>
                    <Button
                      color={mcp.status === 'published' ? 'red' : 'green'}
                      onClick={() =>
                        handleToggle(`mcp:${mcp.name}`, mcp.status === 'published')
                      }
                      disabled={mcp.status === 'archived'}
                    >
                      <PowerIcon data-slot="icon" />
                      {mcp.status === 'published' ? 'Disable' : 'Enable'}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              icon={<CubeIcon className="size-6 text-zinc-400" />}
              title="No MCPs found"
              description="MCP servers will appear here once they are configured."
            />
          )}
        </div>
      </div>

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
          <Button
            plain
            onClick={() => {
              setConfirmDialogOpen(false);
              setSelectedTarget(null);
            }}
          >
            Cancel
          </Button>
          <Button color="red" onClick={handleConfirm}>
            {selectedTarget?.enabled ? 'Disable' : 'Enable'}
          </Button>
        </AlertActions>
      </Alert>
    </div>
  );
}
