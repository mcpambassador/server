import { useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Package, CheckCircle2, AlertCircle } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/catalyst/card';
import { Button } from '@/components/catalyst/button';
import { Badge } from '@/components/catalyst/badge';
import { Skeleton } from '@/components/catalyst/skeleton';
import { InlineAlert, InlineAlertDescription, InlineAlertTitle } from '@/components/catalyst/inline-alert';
import { Dialog, DialogBody, DialogDescription, DialogActions,  DialogTitle } from '@/components/catalyst/dialog';
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
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!mcp) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>MCP Not Found</CardTitle>
          <CardDescription>
            The requested MCP could not be found.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button href="/app/marketplace">Back to Marketplace</Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4 pb-4 border-b border-border mb-6">
        <Button plain className="p-1" href="/app/marketplace">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1">
          <h1 className="text-xl font-semibold">{mcp.name}</h1>
          <p className="text-sm text-muted-foreground">{mcp.description || 'No description available'}</p>
        </div>
      </div>

      {/* Credential Warning */}
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

      {/* MCP Info Card */}
      <Card>
        <CardHeader>
          <CardTitle>MCP Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="text-sm font-medium text-muted-foreground">Isolation Mode</p>
              <Badge color="zinc" className="mt-1">
                {mcp.isolationMode === 'per-user' ? 'Per-User' : 'Shared'}
              </Badge>
            </div>
            <div>
              <p className="text-sm font-medium text-muted-foreground">Credentials Required</p>
              <Badge color={requiresCredentials ? 'zinc' : 'zinc'} className="mt-1">
                {requiresCredentials ? 'Yes' : 'No'}
              </Badge>
            </div>
            <div>
              <p className="text-sm font-medium text-muted-foreground">Tools Available</p>
              <p className="text-lg font-medium mt-1">{mcp.tools.length}</p>
            </div>
            <div>
              <p className="text-sm font-medium text-muted-foreground">Created</p>
              <p className="text-lg font-medium mt-1">
                {new Date(mcp.createdAt).toLocaleDateString()}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Tools List */}
      <Card>
        <CardHeader>
          <CardTitle>Available Tools</CardTitle>
          <CardDescription>
            Tools provided by this MCP
          </CardDescription>
        </CardHeader>
        <CardContent>
          {mcp.tools.length === 0 ? (
            <p className="text-sm text-muted-foreground">No tools available</p>
          ) : (
            <div className="space-y-3">
              {mcp.tools.map((tool) => (
                <div key={tool.name} className="border-l-2 border-primary pl-4 py-2">
                  <p className="font-medium">{tool.name}</p>
                  {tool.description && (
                    <p className="text-sm text-muted-foreground mt-1">
                      {tool.description}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Subscribe Button */}
      <div className="flex justify-end">
        <Button
          className="h-8"
          onClick={openSubscribeDialog}
          disabled={activeClients.length === 0 || (requiresCredentials && !hasCredentials)}
        >
          <Package className="mr-2 h-4 w-4" />
          Subscribe to this MCP
        </Button>
      </div>

      {/* Subscribe Dialog */}
      <Dialog open={subscribeDialogOpen} onClose={setSubscribeDialogOpen}>
        
          
            <DialogTitle>Subscribe to {mcp.name}</DialogTitle>
            <DialogDescription>
              Select a client and choose which tools to enable
            </DialogDescription>
          

          <div className="space-y-4">
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
              <p className="text-sm text-muted-foreground">
                Leave all selected to enable all tools
              </p>
              <div className="max-h-64 overflow-y-auto space-y-3 border rounded-md p-4">
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
                        <p className="text-sm text-muted-foreground mt-1">
                          {tool.description}
                        </p>
                      )}
                    </div>
                  </CheckboxField>
                ))}
              </div>
            </div>
          </div>

          <DialogActions>
            <Button color="zinc" className="h-8" onClick={() => setSubscribeDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              className="h-8"
              onClick={handleSubscribe}
              disabled={!selectedClientId || selectedTools.length === 0 || subscribe.isPending}
            >
              {subscribe.isPending ? 'Subscribing...' : 'Subscribe'}
            </Button>
          </DialogActions>
        
      </Dialog>
    </div>
  );
}
