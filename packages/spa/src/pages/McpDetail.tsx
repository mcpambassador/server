import { useState, useMemo } from 'react';
import { toast } from 'sonner';
import { useParams, useNavigate } from 'react-router-dom';
import {
  CubeIcon,
  CheckCircleIcon,
  ExclamationCircleIcon,
} from '@heroicons/react/20/solid';
import { Breadcrumb } from '@/components/shared/Breadcrumb';
import { Heading } from '@/components/catalyst/heading';
import { Text } from '@/components/catalyst/text';
import { Badge } from '@/components/catalyst/badge';
import { Button } from '@/components/catalyst/button';
import { InlineAlert, InlineAlertDescription, InlineAlertTitle } from '@/components/catalyst/inline-alert';
import { Dialog, DialogBody, DialogTitle, DialogDescription, DialogActions } from '@/components/catalyst/dialog';
import { Listbox, ListboxOption, ListboxLabel } from '@/components/catalyst/listbox';
import { Checkbox, CheckboxField } from '@/components/catalyst/checkbox';
import { Field, Label } from '@/components/catalyst/fieldset';
import { Input } from '@/components/catalyst/input';
import { useMcpDetail } from '@/api/hooks/use-marketplace';
import { useClients, useSubscribe } from '@/api/hooks/use-clients';
import { useCredentialStatus, useSetCredentials } from '@/api/hooks/use-credentials';
import { usePageTitle } from '@/hooks/usePageTitle';

export function McpDetail() {
  const { mcpId } = useParams<{ mcpId: string }>();
  const navigate = useNavigate();
  const { data: mcp, isLoading } = useMcpDetail(mcpId!);
  usePageTitle(mcp?.name || 'MCP Details');
  const { data: clients } = useClients();
  const { data: credentials } = useCredentialStatus();
  const subscribe = useSubscribe();
  const setCredentials = useSetCredentials();

  const [subscribeDialogOpen, setSubscribeDialogOpen] = useState(false);
  const [selectedClientId, setSelectedClientId] = useState('');
  const [selectedTools, setSelectedTools] = useState<string[]>([]);
  const [credentialValues, setCredentialValues] = useState<Record<string, string>>({});
  const [credentialStep, setCredentialStep] = useState(true);

  const activeClients = clients?.filter(c => c.status === 'active') ?? [];
  const hasCredentials = credentials?.find(c => c.mcpId === mcpId)?.hasCredentials ?? false;
  const requiresCredentials = mcp?.requiresUserCredentials ?? false;
  const isOAuthMcp = mcp?.authType === 'oauth2';

  const credentialFields = useMemo(() => {
    if (!mcp?.credentialSchema) return [];
    try {
      const schema = typeof mcp.credentialSchema === 'string'
        ? JSON.parse(mcp.credentialSchema as string)
        : mcp.credentialSchema;
      const props = schema?.properties || {};
      const required = schema?.required || [];
      return Object.entries(props).map(([key, value]: [string, unknown]) => {
        const v = value as Record<string, unknown> | undefined;
        const desc = typeof v?.description === 'string' ? v!.description : undefined;
        return {
          key,
          label: desc || key.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()),
          required: required.includes(key),
          sensitive: /key|secret|token|password/i.test(key),
        };
      });
    } catch {
      return [];
    }
  }, [mcp]);

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
      toast.error('Failed to subscribe', { description: (error as Error)?.message ?? String(error) });
    }
  };

  const handleSaveCredentials = async () => {
    if (!mcpId) return;
    try {
      await setCredentials.mutateAsync({
        mcpId,
        data: { credentials: credentialValues },
      });
      setCredentialStep(false);
    } catch (error) {
      toast.error('Failed to save credentials', { description: (error as Error)?.message ?? String(error) });
    }
  };

  const openSubscribeDialog = () => {
    if (mcp) {
      setSelectedTools(mcp.tools.map(t => t.name));
      setCredentialValues({});
      // Skip credential step for OAuth MCPs or if credentials already configured
      setCredentialStep(requiresCredentials && !hasCredentials && !isOAuthMcp);
      setSubscribeDialogOpen(true);
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="animate-pulse h-8 w-48 rounded bg-zinc-200 dark:bg-zinc-700" />
        <div className="animate-pulse h-32 w-full rounded bg-zinc-200 dark:bg-zinc-700" />
        <div className="animate-pulse h-64 w-full rounded bg-zinc-200 dark:bg-zinc-700" />
      </div>
    );
  }

  if (!mcp) {
    return (
      <div className="rounded-lg bg-white dark:bg-white/5 ring-1 ring-zinc-950/10 dark:ring-white/10 p-8 text-center">
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
      <div className="space-y-2">
        <Breadcrumb items={[
          { label: 'Marketplace', href: '/app/marketplace' },
          { label: mcp.name },
        ]} />
        <div>
          <Heading>{mcp.name}</Heading>
          <Text className="mt-1">{mcp.description || 'No description available'}</Text>
        </div>
      </div>

      {/* Credential Alerts */}
      {requiresCredentials && !hasCredentials && (
        <InlineAlert color="warning">
          <ExclamationCircleIcon className="size-4" />
          <InlineAlertTitle>
            {isOAuthMcp ? 'OAuth Connection Required' : 'Credentials Required'}
          </InlineAlertTitle>
          <InlineAlertDescription>
            {isOAuthMcp
              ? 'This MCP uses OAuth 2.0 authentication. After subscribing, connect your account from the Credentials page.'
              : "This MCP requires credentials. You'll be prompted to enter them when you subscribe."}
          </InlineAlertDescription>
        </InlineAlert>
      )}

      {requiresCredentials && hasCredentials && !isOAuthMcp && (
        <InlineAlert color="success">
          <CheckCircleIcon className="size-4" />
          <InlineAlertTitle>Credentials Configured</InlineAlertTitle>
          <InlineAlertDescription>
            You have already configured credentials for this MCP.
          </InlineAlertDescription>
        </InlineAlert>
      )}

      {/* MCP Details Panel */}
      <div className="rounded-lg bg-white dark:bg-white/5 ring-1 ring-zinc-950/10 dark:ring-white/10 p-6">
        <Heading level={2} className="mb-4">MCP Details</Heading>
        <dl className="grid gap-6 sm:grid-cols-2">
          <div>
            <dt className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Isolation Mode</dt>
            <dd className="mt-1 text-sm text-zinc-900 dark:text-white">
              <Badge color="zinc">
                {mcp.isolationMode === 'per-user' ? 'Per-User' : 'Shared'}
              </Badge>
            </dd>
          </div>
          <div>
            <dt className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Credentials Required</dt>
            <dd className="mt-1 text-sm text-zinc-900 dark:text-white">
              <Badge color="zinc">
                {requiresCredentials ? 'Yes' : 'No'}
              </Badge>
            </dd>
          </div>
          <div>
            <dt className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Tools Available</dt>
            <dd className="mt-1 text-sm text-zinc-900 dark:text-white font-semibold">{mcp.tools.length}</dd>
          </div>
          <div>
            <dt className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Created</dt>
            <dd className="mt-1 text-sm text-zinc-900 dark:text-white font-semibold">
              {new Date(mcp.createdAt).toLocaleDateString()}
            </dd>
          </div>
        </dl>
      </div>

      {/* Tools List Panel */}
      <div className="rounded-lg bg-white dark:bg-white/5 ring-1 ring-zinc-950/10 dark:ring-white/10 p-6">
        <Heading level={2} className="mb-2">Available Tools</Heading>
        <Text className="mb-4">Tools provided by this MCP</Text>
        {mcp.tools.length === 0 ? (
          <Text className="text-zinc-500 dark:text-zinc-400">No tools available</Text>
        ) : (
          <div className="space-y-4">
            {mcp.tools.map((tool) => (
              <div key={tool.name} className="border-l-2 border-zinc-300 dark:border-zinc-600 pl-4 py-2">
                <p className="font-medium text-zinc-900 dark:text-white">{tool.name}</p>
                {tool.description && (
                  <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">{tool.description}</p>
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
          disabled={activeClients.length === 0}
        >
          <CubeIcon data-slot="icon" />
          Subscribe to this MCP
        </Button>
      </div>

      {/* Subscribe Dialog */}
      <Dialog open={subscribeDialogOpen} onClose={setSubscribeDialogOpen}>
        <DialogBody>
          {credentialStep ? (
            <>
              {/* Step 1: Credential Entry */}
              <DialogTitle>Credentials Required for {mcp.name}</DialogTitle>
              <DialogDescription>
                Enter your credentials to connect to this MCP server.
              </DialogDescription>
              <div className="mt-6 space-y-4">
                {credentialFields.map((field) => (
                  <Field key={field.key}>
                    <Label>
                      {field.label}{field.required && <span className="text-red-500 ml-0.5">*</span>}
                    </Label>
                    <Input
                      type={field.sensitive ? 'password' : 'text'}
                      value={credentialValues[field.key] || ''}
                      onChange={(e) => setCredentialValues(prev => ({ ...prev, [field.key]: e.target.value }))}
                      placeholder={field.sensitive ? '••••••••' : `Enter ${field.label.toLowerCase()}`}
                    />
                  </Field>
                ))}
              </div>
              <DialogActions>
                <Button color="zinc" onClick={() => setSubscribeDialogOpen(false)}>
                  Cancel
                </Button>
                <Button
                  onClick={handleSaveCredentials}
                  disabled={setCredentials.isPending || credentialFields.some(f => f.required && !credentialValues[f.key]?.trim())}
                >
                  {setCredentials.isPending ? 'Saving...' : 'Continue'}
                </Button>
              </DialogActions>
            </>
          ) : (
            <>
              {/* Step 2: Client + Tool Selection */}
              <DialogTitle>Subscribe to {mcp.name}</DialogTitle>
              <DialogDescription>
                Select a client and choose which tools to enable
              </DialogDescription>

              <div className="mt-6 space-y-4">
                <Field>
                  <Label>Select Client</Label>
                  <Listbox placeholder="Choose a client" value={selectedClientId} onChange={(value: string) => setSelectedClientId(value)} name="client">
                    {activeClients.map((client) => (
                      <ListboxOption key={client.id} value={client.id}>
                        <ListboxLabel>{client.clientName} ({client.keyPrefix})</ListboxLabel>
                      </ListboxOption>
                    ))}
                  </Listbox>
                </Field>

                <Field>
                  <Label>Select Tools (optional)</Label>
                  <Text className="text-sm text-zinc-500 dark:text-zinc-400">
                    Leave all selected to enable all tools
                  </Text>
                  {mcp.tools.length > 0 ? (
                    <div className="max-h-64 overflow-y-auto space-y-2 rounded-lg border border-zinc-950/10 dark:border-white/10 p-4">
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
                          <Label className="font-medium cursor-pointer">
                            {tool.name}
                          </Label>
                        </CheckboxField>
                      ))}
                    </div>
                  ) : isOAuthMcp ? (
                    <Text className="text-sm text-zinc-500 dark:text-zinc-400">
                      Tools will be discovered after you connect your OAuth account on the Credentials page.
                    </Text>
                  ) : null}
                </Field>
              </div>

              <DialogActions>
                <Button color="zinc" onClick={() => setSubscribeDialogOpen(false)}>
                  Cancel
                </Button>
                <Button
                  onClick={handleSubscribe}
                  disabled={!selectedClientId || (!isOAuthMcp && selectedTools.length === 0) || subscribe.isPending}
                >
                  {subscribe.isPending ? 'Subscribing...' : 'Subscribe'}
                </Button>
              </DialogActions>
            </>
          )}
        </DialogBody>
      </Dialog>
    </div>
  );
}
