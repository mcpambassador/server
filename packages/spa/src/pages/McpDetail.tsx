import { useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Package, CheckCircle2, AlertCircle } from 'lucide-react';
import { Heading } from '@/components/catalyst/heading';
import { Text } from '@/components/catalyst/text';
import { Badge } from '@/components/catalyst/badge';
import { Button } from '@/components/catalyst/button';
import { InlineAlert, InlineAlertDescription, InlineAlertTitle } from '@/components/catalyst/inline-alert';
import { Dialog, DialogBody, DialogTitle, DialogDescription, DialogActions } from '@/components/catalyst/dialog';
import { Select } from '@/components/catalyst/select';
import { Checkbox, CheckboxField } from '@/components/catalyst/checkbox';
import { Label } from '@/components/catalyst/fieldset';
import { useMcpDetail } from '@/api/hooks/use-marketplace';
import { useClients, useSubscribe } from '@/api/hooks/use-clients';
import { useCredentialStatus } from '@/api/hooks/use-credentials';
import { usePageTitle } from '@/hooks/usePageTitle';

export function McpDetail() {
  const { mcpId } = useParams<{ mcpId: string }>();
  const navigate = useNavigate();
  const { data: mcp, isLoading } = useMcpDetail(mcpId!);
  usePageTitle(mcp?.name || 'MCP Details');
  const { data: clients } = useClients();
  const { data: credentials } = useCredentialStatus();
  const subscribe = useSubscribe();

  const [subscribeDialogOpen, setSubscribeDialogOpen] = useState(false);
  const [selectedClientId, setSelectedClientId] = useState('');
  const [selectedTools, setSelectedTools] = useState<string[]>([]);

  const activeClients = clients?.filter(c => c.status === 'active') ?? [];
  const hasCredentials = credentials?.find(c => c.mcpId === mcpId)?.hasCredentials ?? false;
  const requiresCredentials = mcp?.requiresUserCredentials ?? false;

  const handleSubscribe = async () => {
    if (!selectedClientId || !mcpId) return;

    try {
      await subscribe.mutateAsync({
        clientId: selectedClientId,
        data: {
          mcp_id: mcpId,
          selected_tools: selectedTools.length > 0 ? selectedTools : undefined,
        },
      });
      setSubscribeDialogOpen(false);
      navigate(`/app/clients/${selectedClientId}`);
    } catch (error) {
      console.error('Failed to subscribe:', error);
    }
  };

  const openSubscribeDialog = () => {
    if (mcp) {
      setSelectedTools(mcp.tools.map(t => t.name));
      setSubscribeDialogOpen(true);
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="animate-pulse h-8 w-48 rounded bg-zinc-200" />
        <div className="animate-pulse h-32 w-full rounded bg-zinc-200" />
        <div className="animate-pulse h-64 w-full rounded bg-zinc-200" />
      </div>
    );
  }

  if (!mcp) {
    return (
      <div className="rounded-lg bg-white ring-1 ring-zinc-950/5 p-8 text-center">
        <Heading level={3}>MCP Not Found</Heading>
        <Text className="mt-2">The requested MCP could not be found.</Text>
        <div className="mt-4">
          <Button href="/app/marketplace">Back to Marketplace</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button plain href="/app/marketplace">
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1">
          <Heading>{mcp.name}</Heading>
          <Text className="mt-1">{mcp.description || 'No description available'}</Text>
        </div>
      </div>

      {/* Credential Alerts */}
      {requiresCredentials && !hasCredentials && (
        <InlineAlert color="warning">
          <AlertCircle className="h-4 w-4" />
          <InlineAlertTitle>Credentials Required</InlineAlertTitle>
          <InlineAlertDescription>
            This MCP requires user credentials to function.{' '}
            <Link to="/app/credentials" className="underline font-medium">
              Set credentials first
            </Link>{' '}
            before subscribing.
          </InlineAlertDescription>
        </InlineAlert>
      )}

      {requiresCredentials && hasCredentials && (
        <InlineAlert color="success">
          <CheckCircle2 className="h-4 w-4" />
          <InlineAlertTitle>Credentials Configured</InlineAlertTitle>
          <InlineAlertDescription>
            You have already configured credentials for this MCP.
          </InlineAlertDescription>
        </InlineAlert>
      )}

      {/* MCP Details Panel */}
      <div className="rounded-lg bg-white ring-1 ring-zinc-950/5 p-6">
        <Heading level={2} className="mb-4">MCP Details</Heading>
        <dl className="grid gap-6 sm:grid-cols-2">
          <div>
            <dt className="text-sm font-medium text-zinc-500">Isolation Mode</dt>
            <dd className="mt-1 text-sm text-zinc-900">
              <Badge color="zinc">
                {mcp.isolationMode === 'per-user' ? 'Per-User' : 'Shared'}
              </Badge>
            </dd>
          </div>
          <div>
            <dt className="text-sm font-medium text-zinc-500">Credentials Required</dt>
            <dd className="mt-1 text-sm text-zinc-900">
              <Badge color="zinc">
                {requiresCredentials ? 'Yes' : 'No'}
              </Badge>
            </dd>
          </div>
          <div>
            <dt className="text-sm font-medium text-zinc-500">Tools Available</dt>
            <dd className="mt-1 text-sm text-zinc-900 font-semibold">{mcp.tools.length}</dd>
          </div>
          <div>
            <dt className="text-sm font-medium text-zinc-500">Created</dt>
            <dd className="mt-1 text-sm text-zinc-900 font-semibold">
              {new Date(mcp.createdAt).toLocaleDateString()}
            </dd>
          </div>
        </dl>
      </div>

      {/* Tools List Panel */}
      <div className="rounded-lg bg-white ring-1 ring-zinc-950/5 p-6">
        <Heading level={2} className="mb-2">Available Tools</Heading>
        <Text className="mb-4">Tools provided by this MCP</Text>
        {mcp.tools.length === 0 ? (
          <Text className="text-zinc-500">No tools available</Text>
        ) : (
          <div className="space-y-4">
            {mcp.tools.map((tool) => (
              <div key={tool.name} className="border-l-2 border-zinc-300 pl-4 py-2">
                <p className="font-medium text-zinc-900">{tool.name}</p>
                {tool.description && (
                  <p className="text-sm text-zinc-500 mt-1">{tool.description}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Subscribe Button */}
      <div className="flex justify-end">
        <Button
          onClick={openSubscribeDialog}
          disabled={activeClients.length === 0 || (requiresCredentials && !hasCredentials)}
        >
          <Package className="mr-2 h-4 w-4" />
          Subscribe to this MCP
        </Button>
      </div>

      {/* Subscribe Dialog */}
      <Dialog open={subscribeDialogOpen} onClose={setSubscribeDialogOpen}>
        <DialogBody>
          <DialogTitle>Subscribe to {mcp.name}</DialogTitle>
          <DialogDescription>
            Select a client and choose which tools to enable
          </DialogDescription>

          <div className="mt-6 space-y-4">
            <div className="space-y-2">
              <Label>Select Client</Label>
              <Select value={selectedClientId} onChange={(e) => setSelectedClientId(e.target.value)} name="client">
                <option value="">Choose a client</option>
                {activeClients.map((client) => (
                  <option key={client.id} value={client.id}>
                    {client.clientName} ({client.keyPrefix})
                  </option>
                ))}
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Select Tools (optional)</Label>
              <Text className="text-sm text-zinc-500">
                Leave all selected to enable all tools
              </Text>
              <div className="max-h-64 overflow-y-auto space-y-3 rounded-lg border border-zinc-950/10 p-4">
                {mcp.tools.map((tool) => (
                  <CheckboxField key={tool.name}>
                    <Checkbox
                      name={tool.name}
                      checked={selectedTools.includes(tool.name)}
                      onChange={(checked) => {
                        if (checked) {
                          setSelectedTools([...selectedTools, tool.name]);
                        } else {
                          setSelectedTools(selectedTools.filter(t => t !== tool.name));
                        }
                      }}
                    />
                    <div className="flex-1">
                      <Label className="font-medium cursor-pointer">
                        {tool.name}
                      </Label>
                      {tool.description && (
                        <Text className="text-sm text-zinc-500 mt-1">
                          {tool.description}
                        </Text>
                      )}
                    </div>
                  </CheckboxField>
                ))}
              </div>
            </div>
          </div>

          <DialogActions>
            <Button color="zinc" onClick={() => setSubscribeDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleSubscribe}
              disabled={!selectedClientId || selectedTools.length === 0 || subscribe.isPending}
            >
              {subscribe.isPending ? 'Subscribing...' : 'Subscribe'}
            </Button>
          </DialogActions>
        </DialogBody>
      </Dialog>
    </div>
  );
}
