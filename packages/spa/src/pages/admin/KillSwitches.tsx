import { useState } from 'react';
import {
  PowerIcon,
  ExclamationTriangleIcon,
  ServerIcon,
  CubeIcon,
} from '@heroicons/react/20/solid';
import { toast } from 'sonner';
import { Heading } from '@/components/catalyst/heading';
import { Text } from '@/components/catalyst/text';
import { Badge } from '@/components/catalyst/badge';
import { Button } from '@/components/catalyst/button';
import { Alert, AlertTitle, AlertDescription, AlertActions } from '@/components/catalyst/alert';
import {
  useAdminClients,
  useAdminMcps,
  useKillSwitch,
  useKillSwitches,
} from '@/api/hooks/use-admin';
import type { AdminClient } from '@/api/types';
import { usePageTitle } from '@/hooks/usePageTitle';
import { EmptyState } from '@/components/shared/EmptyState';

export function KillSwitches() {
  usePageTitle('Admin - Kill Switches');
  const { data: clientsData, isLoading: clientsLoading } = useAdminClients();
  const { data: mcpsData, isLoading: mcpsLoading } = useAdminMcps();
  const {
    data: switchesData,
    isLoading: switchesLoading,
    isError: switchesError,
  } = useKillSwitches();
  const killSwitch = useKillSwitch();

  // Kill-switch state comes ONLY from the server's active list; client/MCP status is unrelated.
  const activeByTarget = new Map((switchesData ?? []).map(s => [s.target, s]));
  const activeKeys = { has: (t: string) => activeByTarget.has(t) };
  const killedInfo = (t: string) => {
    const s = activeByTarget.get(t);
    return s ? `Activated ${new Date(s.activated_at).toLocaleString()} by ${s.activated_by}` : '';
  };
  const switchStateKnown = !switchesLoading && !switchesError;

  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false);
  // enabled === true means "activate the kill switch" (block); false means "restore access".
  const [selectedTarget, setSelectedTarget] = useState<{ target: string; enabled: boolean } | null>(
    null
  );

  const handleToggle = (target: string, currentlyKilled: boolean) => {
    setSelectedTarget({ target, enabled: !currentlyKilled });
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
      toast.error('Kill switch failed', {
        description: (error as Error)?.message ?? String(error),
      });
    }
  };

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div>
        <Heading>Kill Switches</Heading>
        <Text>Emergency controls to disable clients or MCPs</Text>
      </div>

      {switchesError && (
        <div
          role="alert"
          className="rounded-lg bg-amber-50 dark:bg-amber-950/50 p-4 text-sm/6 text-amber-800 dark:text-amber-200 ring-1 ring-amber-200 dark:ring-amber-800"
        >
          Could not load kill-switch state, so controls are disabled. Reload to retry.
        </div>
      )}

      {/* Warning Banner */}
      <div className="rounded-lg bg-red-50 dark:bg-red-950/50 p-4 ring-1 ring-red-200 dark:ring-red-800">
        <div className="flex items-center gap-2">
          <ExclamationTriangleIcon className="size-5 text-red-600 dark:text-red-400" />
          <h3 className="text-sm/6 font-semibold text-red-900 dark:text-red-200">Warning</h3>
        </div>
        <p className="mt-1 text-sm/6 text-red-700 dark:text-red-300">
          Kill switches immediately disable access. Use with caution. Disabled entities will not be
          able to make requests until restored.
        </p>
      </div>

      {/* Every active switch, including ones whose client/MCP is deleted, archived or off-page */}
      {switchStateKnown && (switchesData ?? []).length > 0 && (
        <div
          data-testid="active-kill-switches"
          className="rounded-lg bg-white dark:bg-white/5 p-6 ring-1 ring-zinc-950/10 dark:ring-white/10"
        >
          <h3 className="text-base/7 font-semibold text-zinc-900 dark:text-white">
            Active kill switches
          </h3>
          <p className="text-sm/6 text-zinc-500 dark:text-zinc-400">
            All switches currently in effect
          </p>
          <div className="mt-4 divide-y divide-zinc-950/5 dark:divide-white/10">
            {(switchesData ?? []).map(s => (
              <div key={s.target} className="flex items-center justify-between py-3">
                <div>
                  <p className="text-sm/6 font-mono font-medium text-zinc-900 dark:text-white">
                    {s.target}
                  </p>
                  <p className="text-sm/6 text-zinc-500 dark:text-zinc-400">
                    {s.type} · {killedInfo(s.target)}
                  </p>
                </div>
                <Button
                  color="green"
                  aria-label={`Restore ${s.target}`}
                  onClick={() => handleToggle(s.target, true)}
                >
                  <PowerIcon data-slot="icon" />
                  Restore
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Client Kill Switches */}
      <div className="rounded-lg bg-white dark:bg-white/5 p-6 ring-1 ring-zinc-950/10 dark:ring-white/10">
        <h3 className="text-base/7 font-semibold text-zinc-900 dark:text-white">
          Client Kill Switches
        </h3>
        <p className="text-sm/6 text-zinc-500 dark:text-zinc-400">Disable individual API clients</p>
        <div className="mt-4">
          {clientsLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map(i => (
                <div key={i} className="flex items-center justify-between py-3 animate-pulse">
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
              {clientsData.data.map((client: AdminClient) => (
                <div key={client.client_id} className="flex items-center justify-between py-3">
                  <div>
                    <p className="text-sm/6 font-medium text-zinc-900 dark:text-white">
                      {client.client_name}
                    </p>
                    <p className="text-sm/6 font-mono text-zinc-500 dark:text-zinc-400">
                      {client.key_prefix}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge color={client.status === 'active' ? 'green' : 'zinc'}>
                      {client.status}
                    </Badge>
                    {activeKeys.has(`client:${client.client_id}`) && (
                      <>
                        <span className="hidden text-xs text-zinc-500 dark:text-zinc-400 sm:inline">
                          {killedInfo(`client:${client.client_id}`)}
                        </span>
                        <Badge color="red">Kill switch active</Badge>
                      </>
                    )}
                    <Button
                      color={activeKeys.has(`client:${client.client_id}`) ? 'green' : 'red'}
                      disabled={!switchStateKnown}
                      onClick={() =>
                        handleToggle(
                          `client:${client.client_id}`,
                          activeKeys.has(`client:${client.client_id}`)
                        )
                      }
                    >
                      <PowerIcon data-slot="icon" />
                      {activeKeys.has(`client:${client.client_id}`) ? 'Restore' : 'Kill'}
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
        <h3 className="text-base/7 font-semibold text-zinc-900 dark:text-white">
          MCP Kill Switches
        </h3>
        <p className="text-sm/6 text-zinc-500 dark:text-zinc-400">
          Disable MCP servers system-wide
        </p>
        <div className="mt-4">
          {mcpsLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map(i => (
                <div key={i} className="flex items-center justify-between py-3 animate-pulse">
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
              {mcpsData.data.map(mcp => (
                <div key={mcp.mcp_id} className="flex items-center justify-between py-3">
                  <div>
                    <p className="text-sm/6 font-medium text-zinc-900 dark:text-white">
                      {mcp.display_name}
                    </p>
                    <p className="text-sm/6 font-mono text-zinc-500 dark:text-zinc-400">
                      {mcp.name}
                    </p>
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
                    {activeKeys.has(`mcp:${mcp.name}`) && (
                      <>
                        <span className="hidden text-xs text-zinc-500 dark:text-zinc-400 sm:inline">
                          {killedInfo(`mcp:${mcp.name}`)}
                        </span>
                        <Badge color="red">Kill switch active</Badge>
                      </>
                    )}
                    <Button
                      color={activeKeys.has(`mcp:${mcp.name}`) ? 'green' : 'red'}
                      onClick={() =>
                        handleToggle(`mcp:${mcp.name}`, activeKeys.has(`mcp:${mcp.name}`))
                      }
                      disabled={!switchStateKnown}
                    >
                      <PowerIcon data-slot="icon" />
                      {activeKeys.has(`mcp:${mcp.name}`) ? 'Restore' : 'Kill'}
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
          {selectedTarget?.enabled ? 'Activate kill switch for' : 'Restore access for'}{' '}
          {selectedTarget?.target}?
        </AlertTitle>
        <AlertDescription>
          {selectedTarget?.enabled
            ? 'This will immediately block all requests from this entity. Active connections may be terminated.'
            : 'This will deactivate the kill switch and restore access for this entity.'}
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
          <Button color={selectedTarget?.enabled ? 'red' : 'green'} onClick={handleConfirm}>
            {selectedTarget?.enabled ? 'Activate kill switch' : 'Restore access'}
          </Button>
        </AlertActions>
      </Alert>
    </div>
  );
}
