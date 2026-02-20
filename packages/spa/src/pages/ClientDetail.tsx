import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Plus, Trash2, Settings } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/catalyst/card';
import { Button } from '@/components/catalyst/button';
import { Badge } from '@/components/catalyst/badge';
import { Skeleton } from '@/components/catalyst/skeleton';
import {
  Alert,
  AlertBody,
  AlertDescription,
  AlertActions,
  AlertTitle,
} from '@/components/catalyst/alert';
import { Dialog, DialogBody, DialogDescription, DialogActions,  DialogTitle } from '@/components/catalyst/dialog';
import { Checkbox, CheckboxField } from '@/components/catalyst/checkbox';
import { Label } from '@/components/catalyst/fieldset';
import { DataTable, type ColumnDef } from '@/components/data/DataTable';
import { useClient, useClientSubscriptions, useUnsubscribe, useUpdateSubscription } from '@/api/hooks/use-clients';
import { useMarketplace } from '@/api/hooks/use-marketplace';
import type { Subscription } from '@/api/types';
import { usePageTitle } from '@/hooks/usePageTitle';

export function ClientDetail() {
  const { clientId } = useParams<{ clientId: string }>();
  const { data: client, isLoading: clientLoading } = useClient(clientId!);
  usePageTitle(client?.clientName || 'Client Details');
  const { data: subscriptions, isLoading: subsLoading } = useClientSubscriptions(clientId!);
  const { data: marketplace } = useMarketplace();
  const unsubscribe = useUnsubscribe();
  const updateSubscription = useUpdateSubscription();

  const [unsubscribeDialogOpen, setUnsubscribeDialogOpen] = useState(false);
  const [subscriptionToDelete, setSubscriptionToDelete] = useState<string | null>(null);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [subscriptionToEdit, setSubscriptionToEdit] = useState<Subscription | null>(null);
  const [selectedTools, setSelectedTools] = useState<string[]>([]);

  const handleUnsubscribe = async () => {
    if (subscriptionToDelete && clientId) {
      try {
        await unsubscribe.mutateAsync({
          clientId,
          subscriptionId: subscriptionToDelete,
        });
        setUnsubscribeDialogOpen(false);
        setSubscriptionToDelete(null);
      } catch (error) {
        console.error('Failed to unsubscribe:', error);
      }
    }
  };

  const handleEditTools = (subscription: Subscription) => {
    const mcp = marketplace?.data?.find(m => m.id === subscription.mcpId);
    setSubscriptionToEdit(subscription);
    const allToolNames = mcp?.tools ? mcp.tools.map(t => t.name) : [];
    setSelectedTools(subscription.selectedTools ?? allToolNames);
    setEditDialogOpen(true);
  };

  const handleSaveTools = async () => {
    if (subscriptionToEdit && clientId) {
      try {
        await updateSubscription.mutateAsync({
          clientId,
          subscriptionId: subscriptionToEdit.id,
          data: { selected_tools: selectedTools },
        });
        setEditDialogOpen(false);
        setSubscriptionToEdit(null);
      } catch (error) {
        console.error('Failed to update subscription:', error);
      }
    }
  };

  const columns: ColumnDef<Subscription>[] = [
    {
      header: 'MCP Name',
      accessor: 'mcpName',
      cell: (sub) => (
        <Link
          to={`/app/marketplace/${sub.mcpId}`}
          className="font-medium hover:underline"
        >
          {sub.mcpName}
        </Link>
      ),
    },
    {
      header: 'Tools',
      accessor: 'selectedTools',
      cell: (sub) => {
        const mcp = marketplace?.data?.find(m => m.id === sub.mcpId);
        const totalTools = mcp?.tools?.length ?? 0;
        const selectedCount = sub.selectedTools?.length ?? totalTools;
        return (
          <span className="text-sm text-muted-foreground">
            {selectedCount} / {totalTools}
          </span>
        );
      },
    },
    {
      header: 'Status',
      accessor: 'status',
      cell: (sub) => (
        <Badge color={sub.status === 'active' ? 'emerald' : 'zinc'}>
          {sub.status}
        </Badge>
      ),
    },
    {
      header: 'Created',
      accessor: 'createdAt',
      cell: (sub) => new Date(sub.createdAt).toLocaleDateString(),
    },
    {
      header: 'Actions',
      accessor: 'id',
      cell: (sub) => (
        <div className="flex items-center gap-2">
          <Button
                        className="p-1"
            onClick={() => handleEditTools(sub)}
          >
            <Settings className="h-4 w-4" />
          </Button>
          <Button
                        className="p-1"
            onClick={() => {
              setSubscriptionToDelete(sub.id);
              setUnsubscribeDialogOpen(true);
            }}
            disabled={unsubscribe.isPending}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ),
    },
  ];

  if (clientLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!client) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Client Not Found</CardTitle>
          <CardDescription>
            The requested client could not be found.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button href="/app/clients">Back to Clients</Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4 pb-4 border-b border-border mb-6">
        <Button plain className="p-1" href="/app/clients">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1">
          <h1 className="text-xl font-semibold">{client.clientName}</h1>
          <p className="text-sm text-muted-foreground">{client.keyPrefix}</p>
        </div>
        <Badge color={
          client.status === 'active' ? 'emerald' :
          client.status === 'suspended' ? 'zinc' : 'red'
        }>
          {client.status}
        </Badge>
      </div>

      {/* Client Info Card */}
      <Card>
        <CardHeader>
          <CardTitle>Client Details</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div>
            <p className="text-sm font-medium text-muted-foreground">Created</p>
            <p className="text-lg">{new Date(client.createdAt).toLocaleString()}</p>
          </div>
          {client.expiresAt && (
            <div>
              <p className="text-sm font-medium text-muted-foreground">Expires</p>
              <p className="text-lg">{new Date(client.expiresAt).toLocaleString()}</p>
            </div>
          )}
          {client.lastUsedAt && (
            <div>
              <p className="text-sm font-medium text-muted-foreground">Last Used</p>
              <p className="text-lg">{new Date(client.lastUsedAt).toLocaleString()}</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Subscriptions */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">Subscriptions</h2>
            <p className="text-sm text-muted-foreground">
              MCPs this client is subscribed to
            </p>
          </div>
          <Button className="h-8" href="/app/marketplace">
            <Plus className="mr-2 h-4 w-4" />
            Subscribe to MCP
          </Button>
        </div>

        <Card className="p-6">
          <DataTable
            columns={columns}
            data={subscriptions ?? []}
            isLoading={subsLoading}
            emptyMessage="No subscriptions yet. Browse the marketplace to subscribe to MCPs."
          />
        </Card>
      </div>

      {/* Unsubscribe Confirmation Dialog */}
      <Alert open={unsubscribeDialogOpen} onClose={setUnsubscribeDialogOpen}>
        
          
            <AlertTitle>Unsubscribe from MCP?</AlertTitle>
            <AlertDescription>
              This will remove access to this MCP for this client. This action cannot be undone.
            </AlertDescription>
          
          <AlertActions>
            <Button plain onClick={() => setSubscriptionToDelete(null)}>
              Cancel
            </Button>
            <Button color="red"
              onClick={handleUnsubscribe}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Unsubscribe
            </Button>
          </AlertActions>
        
      </Alert>

      {/* Edit Tools Dialog */}
      <Dialog open={editDialogOpen} onClose={setEditDialogOpen}>
        
          
            <DialogTitle>Select Tools</DialogTitle>
            <DialogDescription>
              Choose which tools this client can access from {subscriptionToEdit?.mcpName}
            </DialogDescription>
          
          <div className="max-h-96 overflow-y-auto space-y-3">
            {marketplace?.data
              ?.find(m => m.id === subscriptionToEdit?.mcpId)
              ?.tools?.map((tool) => (
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
          <DialogActions>
            <Button color="zinc" className="h-8" onClick={() => setEditDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              className="h-8"
              onClick={handleSaveTools}
              disabled={selectedTools.length === 0 || updateSubscription.isPending}
            >
              {updateSubscription.isPending ? 'Saving...' : 'Save'}
            </Button>
          </DialogActions>
        
      </Dialog>
    </div>
  );
}
