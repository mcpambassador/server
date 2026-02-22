import { useState, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeftIcon, CheckCircleIcon, ArchiveBoxIcon, ArrowPathIcon, ExclamationTriangleIcon, MagnifyingGlassIcon, TrashIcon } from '@heroicons/react/20/solid';
import { toast } from 'sonner';
import { Heading } from '@/components/catalyst/heading';
import { Text } from '@/components/catalyst/text';
import { Button } from '@/components/catalyst/button';
import { Badge } from '@/components/catalyst/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger, TabsPanels } from '@/components/catalyst/tabs';
import { Dialog, DialogBody, DialogTitle, DialogDescription, DialogActions } from '@/components/catalyst/dialog';
import { Alert, AlertTitle, AlertDescription, AlertActions } from '@/components/catalyst/alert';
import { Input } from '@/components/catalyst/input';
import { Field, Label } from '@/components/catalyst/fieldset';
import { Textarea } from '@/components/catalyst/textarea';
import { Listbox, ListboxOption, ListboxLabel } from '@/components/catalyst/listbox';
import { Breadcrumb } from '@/components/shared/Breadcrumb';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import {
  useAdminMcp,
  useAdminMcpInstances,
  useRestartMcp,
  useUpdateMcp,
  useValidateMcp,
  useDiscoverTools,
  usePublishMcp,
  useArchiveMcp,
  useDeleteMcp,
  useAdminMcpLogs,
  useClearMcpLogs,
  useRestartUserMcp,
} from '@/api/hooks/use-admin';
import { usePageTitle } from '@/hooks/usePageTitle';

export function McpDetail() {
  const { mcpId } = useParams<{ mcpId: string }>();
  const { data: mcp, isLoading } = useAdminMcp(mcpId!);
  usePageTitle(mcp ? `Admin - ${mcp.name}` : 'Admin - MCP Details');
  const updateMcp = useUpdateMcp();
  const validateMcp = useValidateMcp();
  const discoverTools = useDiscoverTools();
  const publishMcp = usePublishMcp();
  const archiveMcp = useArchiveMcp();
  const deleteMcp = useDeleteMcp();
  const navigate = useNavigate();
  const { data: instanceData, isLoading: healthLoading } = useAdminMcpInstances(mcp?.name ?? '');
  const restartMcp = useRestartMcp();
  const { data: logsData } = useAdminMcpLogs(mcp?.name ?? '');
  const clearMcpLogs = useClearMcpLogs();
  const restartUserMcp = useRestartUserMcp();

  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [credentialDialogOpen, setCredentialDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);
  const [credentialValues, setCredentialValues] = useState<Record<string, string>>({});
  const [validationResult, setValidationResult] = useState<any>(null);
  const [discoveryResult, setDiscoveryResult] = useState<any>(null);

  const [editFormData, setEditFormData] = useState({
    display_name: '',
    description: '',
    icon_url: '',
    config: '',
    transport_type: 'stdio' as 'stdio' | 'http' | 'sse',
    isolation_mode: 'shared' as 'shared' | 'per_user',
    auth_type: 'none' as 'none' | 'static' | 'oauth2',
    requires_user_credentials: false,
    credential_schema: '',
    // OAuth fields
    oauth_auth_url: '',
    oauth_token_url: '',
    oauth_scopes: '',
    oauth_client_id_env: '',
    oauth_client_secret_env: '',
    oauth_access_token_env_var: '',
    oauth_revocation_url: '',
    oauth_extra_params: '',
  });

  // Parse tool_catalog from JSON string (admin API returns raw DB row)
  const parsedTools = useMemo(() => {
    if (!mcp?.tool_catalog) return [];
    try {
      const catalog = typeof mcp.tool_catalog === 'string'
        ? JSON.parse(mcp.tool_catalog)
        : mcp.tool_catalog;
      return Array.isArray(catalog) ? catalog : [];
    } catch {
      return [];
    }
  }, [mcp?.tool_catalog]);

  // Parse credential schema for credential-gated MCPs
  const credentialFields = useMemo(() => {
    if (!mcp?.credential_schema) return [];
    try {
      const schema = typeof mcp.credential_schema === 'string'
        ? JSON.parse(mcp.credential_schema)
        : mcp.credential_schema;
      const props = schema?.properties || {};
      const required = schema?.required || [];
      return Object.entries(props).map(([key, value]: [string, any]) => ({
        key,
        label: value?.description || key.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()),
        required: required.includes(key),
        sensitive: /key|secret|token|password/i.test(key),
      }));
    } catch {
      return [];
    }
  }, [mcp?.credential_schema]);

  // Format uptime from milliseconds to human readable
  const formatUptime = (ms: number): string => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  };

  const handleEdit = async () => {
    if (!mcp) return;
    try {
      let configObj: Record<string, unknown>;
      if (editFormData.config) {
        try {
          configObj = JSON.parse(editFormData.config);
        } catch {
          toast.error('Invalid JSON', { description: 'Invalid JSON in config field' });
          return;
        }
      } else {
        configObj = typeof mcp.config === 'string' ? JSON.parse(mcp.config) : mcp.config;
      }

      // Parse credential schema if provided (for static auth)
      let credSchemaObj: Record<string, unknown> | undefined;
      if (editFormData.auth_type === 'static' && editFormData.credential_schema.trim()) {
        try {
          credSchemaObj = JSON.parse(editFormData.credential_schema);
        } catch {
          toast.error('Invalid JSON', { description: 'Invalid JSON in credential schema field' });
          return;
        }
      }

      // Build OAuth config if auth_type is oauth2
      let oauthConfigObj: Record<string, unknown> | undefined;
      if (editFormData.auth_type === 'oauth2') {
        if (!editFormData.oauth_auth_url.trim() || !editFormData.oauth_token_url.trim() ||
            !editFormData.oauth_scopes.trim() || !editFormData.oauth_client_id_env.trim() ||
            !editFormData.oauth_client_secret_env.trim() || !editFormData.oauth_access_token_env_var.trim()) {
          toast.error('OAuth Configuration', { description: 'Please fill all required OAuth fields' });
          return;
        }

        oauthConfigObj = {
          auth_url: editFormData.oauth_auth_url.trim(),
          token_url: editFormData.oauth_token_url.trim(),
          scopes: editFormData.oauth_scopes.trim(),
          client_id_env: editFormData.oauth_client_id_env.trim(),
          client_secret_env: editFormData.oauth_client_secret_env.trim(),
          access_token_env_var: editFormData.oauth_access_token_env_var.trim(),
        };

        if (editFormData.oauth_revocation_url.trim()) {
          oauthConfigObj.revocation_url = editFormData.oauth_revocation_url.trim();
        }

        if (editFormData.oauth_extra_params.trim()) {
          try {
            oauthConfigObj.extra_params = JSON.parse(editFormData.oauth_extra_params);
          } catch {
            toast.error('Invalid JSON', { description: 'Extra parameters must be valid JSON' });
            return;
          }
        }
      }

      // Build update payload — only include non-structural fields for published MCPs
      const updateData: Record<string, unknown> = {
        display_name: editFormData.display_name || undefined,
        description: editFormData.description || undefined,
        icon_url: editFormData.icon_url || undefined,
        config: configObj,
      };

      // Structural fields (blocked for published MCPs by backend)
      if (mcp.status !== 'published') {
        updateData.transport_type = editFormData.transport_type;
        updateData.isolation_mode = editFormData.isolation_mode;
        updateData.auth_type = editFormData.auth_type;
        updateData.requires_user_credentials = editFormData.auth_type !== 'none';
        if (credSchemaObj) {
          updateData.credential_schema = credSchemaObj;
        }
        if (oauthConfigObj) {
          updateData.oauth_config = oauthConfigObj;
        }
      }

      await updateMcp.mutateAsync({
        mcpId: mcp.mcp_id,
        data: updateData as any,
      });
      setEditDialogOpen(false);
    } catch (error) {
      toast.error('Update MCP failed', { description: (error as Error)?.message ?? String(error) });
    }
  };

  const openEditDialog = () => {
    if (!mcp) return;

    // Parse OAuth config if present
    let oauthConfig: any = {};
    if (mcp.oauth_config) {
      try {
        oauthConfig = typeof mcp.oauth_config === 'string' ? JSON.parse(mcp.oauth_config) : mcp.oauth_config;
      } catch {
        // Ignore parse errors
      }
    }

    setEditFormData({
      display_name: mcp.display_name,
      description: mcp.description || '',
      icon_url: mcp.icon_url || '',
      config:
        typeof mcp.config === 'string'
          ? JSON.stringify(JSON.parse(mcp.config), null, 2)
          : JSON.stringify(mcp.config, null, 2),
      transport_type: mcp.transport_type || 'stdio',
      isolation_mode: mcp.isolation_mode || 'shared',
      auth_type: mcp.auth_type || 'none',
      requires_user_credentials: mcp.requires_user_credentials || false,
      credential_schema: mcp.credential_schema
        ? (typeof mcp.credential_schema === 'string'
          ? JSON.stringify(JSON.parse(mcp.credential_schema), null, 2)
          : JSON.stringify(mcp.credential_schema, null, 2))
        : '',
      oauth_auth_url: oauthConfig.auth_url || '',
      oauth_token_url: oauthConfig.token_url || '',
      oauth_scopes: oauthConfig.scopes || '',
      oauth_client_id_env: oauthConfig.client_id_env || '',
      oauth_client_secret_env: oauthConfig.client_secret_env || '',
      oauth_access_token_env_var: oauthConfig.access_token_env_var || '',
      oauth_revocation_url: oauthConfig.revocation_url || '',
      oauth_extra_params: oauthConfig.extra_params ? JSON.stringify(oauthConfig.extra_params, null, 2) : '',
    });
    setEditDialogOpen(true);
  };

  const handleValidate = async () => {
    if (!mcp) return;
    try {
      const result = await validateMcp.mutateAsync(mcp.mcp_id);
      setValidationResult(result);
    } catch (error) {
      toast.error('Validate MCP failed', { description: (error as Error)?.message ?? String(error) });
    }
  };

  const handleDiscover = async () => {
    if (!mcp) return;
    try {
      const result = await discoverTools.mutateAsync({ mcpId: mcp.mcp_id });
      setDiscoveryResult(result);
      if (result.status === 'success') {
        toast.success('Tool Discovery', { description: `Discovered ${result.tool_count} tools` });
      } else if (result.status === 'skipped') {
        toast.info('Tool Discovery', { description: result.message || 'Discovery skipped' });
      } else {
        toast.error('Tool Discovery', { description: result.message || 'Discovery failed' });
      }
    } catch (error) {
      toast.error('Discover Tools failed', { description: (error as Error)?.message ?? String(error) });
    }
  };

  const handleCredentialDiscover = async () => {
    if (!mcp) return;
    try {
      const result = await discoverTools.mutateAsync({ mcpId: mcp.mcp_id, credentials: credentialValues });
      setDiscoveryResult(result);
      setCredentialDialogOpen(false);
      setCredentialValues({});
      if (result.status === 'success') {
        toast.success('Tool Discovery', { description: `Discovered ${result.tool_count} tools` });
      } else if (result.status === 'skipped') {
        toast.info('Tool Discovery', { description: result.message || 'Discovery skipped' });
      } else {
        toast.error('Tool Discovery', { description: result.message || 'Discovery failed' });
      }
    } catch (error) {
      toast.error('Discover Tools failed', { description: (error as Error)?.message ?? String(error) });
    }
  };

  const handlePublish = async () => {
    if (!mcp) return;
    try {
      await publishMcp.mutateAsync(mcp.mcp_id);
    } catch (error) {
      toast.error('Publish MCP failed', { description: (error as Error)?.message ?? String(error) });
    }
  };

  const handleArchive = async () => {
    if (!mcp) return;
    try {
      await archiveMcp.mutateAsync(mcp.mcp_id);
      setArchiveDialogOpen(false);
    } catch (error) {
      toast.error('Archive MCP failed', { description: (error as Error)?.message ?? String(error) });
    }
  };

  const handleDelete = async () => {
    if (!mcp) return;
    try {
      await deleteMcp.mutateAsync(mcp.mcp_id);
      setDeleteDialogOpen(false);
      toast.success('MCP deleted');
      navigate('/app/admin/mcps');
    } catch (error) {
      toast.error('Delete MCP failed', { description: (error as Error)?.message ?? String(error) });
    }
  };

  const handleRestart = async () => {
    if (!mcp) return;
    try {
      const result = await restartMcp.mutateAsync(mcp.name);
      if (result.connected) {
        toast.success('MCP Restarted', { description: `${mcp.name} is now online with ${result.tool_count} tools` });
      } else {
        toast.warning('MCP Restarted', { description: `${mcp.name} restarted but is not connected` });
      }
    } catch (error) {
      toast.error('Restart failed', { description: (error as Error)?.message ?? String(error) });
    }
  };

  const copyLogs = () => {
    if (logsData?.entries) {
      const text = logsData.entries.map(e => `[${e.timestamp}] ${e.level}: ${e.message}`).join('\n');
      navigator.clipboard.writeText(text);
      toast.success('Logs copied to clipboard');
    }
  };

  const clearLogs = () => {
    if (mcp) {
      clearMcpLogs.mutate(mcp.name);
      toast.success('Error log cleared');
    }
  };

  const handleRestartUserInstance = async (userId: string) => {
    if (!mcp) return;
    try {
      await restartUserMcp.mutateAsync({ userId, mcpName: mcp.name });
      toast.success('User instance restarted', { description: `Restarted ${mcp.name} for user ${userId}` });
    } catch (error) {
      toast.error('Restart failed', { description: (error as Error)?.message ?? String(error) });
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="animate-pulse h-8 w-64 rounded bg-zinc-200 dark:bg-zinc-700" />
        <div className="animate-pulse h-48 w-full rounded bg-zinc-200 dark:bg-zinc-700" />
      </div>
    );
  }

  if (!mcp) {
    return (
      <div className="space-y-6">
        <Button plain href="/app/admin/mcps">
          <ArrowLeftIcon data-slot="icon" />
          Back to MCPs
        </Button>
        <div className="rounded-lg bg-white dark:bg-white/5 p-6 ring-1 ring-zinc-950/10 dark:ring-white/10">
          <p className="text-sm/6 text-zinc-900 dark:text-white">MCP Not Found</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Breadcrumb */}
      <Breadcrumb
        items={[
          { label: 'MCPs', href: '/app/admin/mcps' },
          { label: mcp.display_name },
        ]}
      />

      {/* Header Row */}
      <div className="flex items-start justify-between">
        <div>
          <Heading>{mcp.display_name}</Heading>
          <Text className="font-mono">{mcp.name}</Text>
        </div>
        <div className="flex items-center gap-2">
          <Badge color={mcp.status === 'draft' ? 'zinc' : mcp.status === 'published' ? 'green' : 'zinc'}>
            {mcp.status}
          </Badge>
          {mcp.validation_status && (
            <Badge
              color={
                mcp.validation_status === 'valid'
                  ? 'green'
                  : mcp.validation_status === 'invalid'
                  ? 'red'
                  : 'zinc'
              }
            >
              {mcp.validation_status}
            </Badge>
          )}
        </div>
      </div>

      {/* Action Buttons */}
      <div className="flex gap-2">
        <Button color="zinc" onClick={openEditDialog}>
          Edit MCP
        </Button>
        <Button color="zinc" onClick={handleValidate} disabled={validateMcp.isPending}>
          <ArrowPathIcon data-slot="icon" />
          Validate
        </Button>
        <Button 
          color="zinc" 
          onClick={
            // OAuth MCPs: use admin's stored credential directly
            mcp.auth_type === 'oauth2' ? handleDiscover :
            // Static credential MCPs: open credential dialog
            mcp.requires_user_credentials ? () => setCredentialDialogOpen(true) :
            // No credentials needed: discover directly
            handleDiscover
          } 
          disabled={discoverTools.isPending || (!mcp.requires_user_credentials && mcp.validation_status !== 'valid')}
        >
          <MagnifyingGlassIcon data-slot="icon" />
          {discoverTools.isPending ? 'Discovering...' : 'Discover Tools'}
        </Button>
        {mcp.status === 'draft' && mcp.validation_status === 'valid' && (
          <Button onClick={handlePublish} disabled={publishMcp.isPending}>
            <CheckCircleIcon data-slot="icon" />
            {publishMcp.isPending ? 'Publishing...' : 'Publish'}
          </Button>
        )}
        {mcp.status === 'published' && (
          <Button color="zinc" onClick={() => setArchiveDialogOpen(true)} disabled={archiveMcp.isPending}>
            <ArchiveBoxIcon data-slot="icon" />
            Archive
          </Button>
        )}
        {(mcp.status === 'draft' || mcp.status === 'archived') && (
          <Button color="red" onClick={() => setDeleteDialogOpen(true)} disabled={deleteMcp.isPending}>
            <TrashIcon data-slot="icon" />
            Delete
          </Button>
        )}
      </div>

      {/* Validation Results */}
      {validationResult && (
        <div className="rounded-lg bg-white dark:bg-white/5 p-6 ring-1 ring-zinc-950/10 dark:ring-white/10 space-y-4">
          <div className="flex items-center gap-2">
            {validationResult.valid ? (
              <CheckCircleIcon className="size-5 text-green-600 dark:text-green-400" />
            ) : (
              <ExclamationTriangleIcon className="size-5 text-red-600 dark:text-red-400" />
            )}
            <h3 className="text-base/7 font-semibold text-zinc-900 dark:text-white">
              Validation {validationResult.valid ? 'Passed' : 'Failed'}
            </h3>
          </div>
          {validationResult.errors?.length > 0 && (
            <div>
              <h4 className="font-medium text-red-600 dark:text-red-400 mb-2">Errors</h4>
              <ul className="list-disc list-inside space-y-1">
                {validationResult.errors.map((err: string, i: number) => (
                  <li key={i} className="text-sm text-red-600 dark:text-red-400">
                    {err}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {validationResult.warnings?.length > 0 && (
            <div>
              <h4 className="font-medium text-amber-600 dark:text-amber-400 mb-2">Warnings</h4>
              <ul className="list-disc list-inside space-y-1">
                {validationResult.warnings.map((warn: string, i: number) => (
                  <li key={i} className="text-sm text-amber-600 dark:text-amber-400">
                    {warn}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {validationResult.tools_discovered?.length > 0 && (
            <div>
              <h4 className="font-medium text-zinc-900 dark:text-white mb-2">
                Discovered Tools ({validationResult.tools_discovered.length})
              </h4>
              <div className="grid gap-2">
                {validationResult.tools_discovered.map((tool: any, i: number) => (
                  <div key={i} className="rounded-lg bg-zinc-50 dark:bg-zinc-800 p-3">
                    <p className="font-mono text-sm font-medium text-zinc-900 dark:text-white">{tool.name}</p>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">{tool.description}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Discovery Results */}
      {discoveryResult && (
        <div className="rounded-lg bg-white dark:bg-white/5 p-6 ring-1 ring-zinc-950/10 dark:ring-white/10 space-y-4">
          <div className="flex items-center gap-2">
            {discoveryResult.status === 'success' ? (
              <CheckCircleIcon className="size-5 text-green-600 dark:text-green-400" />
            ) : (
              <ExclamationTriangleIcon className="size-5 text-red-600 dark:text-red-400" />
            )}
            <h3 className="text-base/7 font-semibold text-zinc-900 dark:text-white">
              Tool Discovery — {discoveryResult.status === 'success' ? `${discoveryResult.tool_count} tools found` : discoveryResult.status === 'skipped' ? 'Skipped' : 'Failed'}
            </h3>
          </div>
          {discoveryResult.message && (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">{discoveryResult.message}</p>
          )}
          {discoveryResult.tools_discovered?.length > 0 && (
            <div className="grid gap-2">
              {discoveryResult.tools_discovered.map((tool: any, i: number) => (
                <div key={i} className="rounded-lg bg-zinc-50 dark:bg-zinc-800 p-3">
                  <p className="font-mono text-sm font-medium text-zinc-900 dark:text-white">{tool.name}</p>
                  {tool.description && (
                    <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">{tool.description}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* MCP Details */}
      <Tabs defaultIndex={0} className="w-full">
        <TabsList>
          <TabsTrigger>Information</TabsTrigger>
          <TabsTrigger>Configuration</TabsTrigger>
          <TabsTrigger>Health</TabsTrigger>
        </TabsList>
        <TabsPanels>
          <TabsContent>
            <div className="rounded-lg bg-white dark:bg-white/5 p-6 ring-1 ring-zinc-950/10 dark:ring-white/10">
              <h3 className="text-base/7 font-semibold text-zinc-900 dark:text-white">MCP Information</h3>
              <dl className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
                <div>
                  <dt className="text-sm/6 font-medium text-zinc-500 dark:text-zinc-400">MCP ID</dt>
                  <dd className="text-sm/6 text-zinc-900 dark:text-white font-mono">{mcp.mcp_id}</dd>
                </div>
                <div>
                  <dt className="text-sm/6 font-medium text-zinc-500 dark:text-zinc-400">Internal Name</dt>
                  <dd className="text-sm/6 text-zinc-900 dark:text-white font-mono">{mcp.name}</dd>
                </div>
                <div>
                  <dt className="text-sm/6 font-medium text-zinc-500 dark:text-zinc-400">Display Name</dt>
                  <dd className="text-sm/6 text-zinc-900 dark:text-white">{mcp.display_name}</dd>
                </div>
                <div>
                  <dt className="text-sm/6 font-medium text-zinc-500 dark:text-zinc-400">Transport Type</dt>
                  <dd className="text-sm/6 text-zinc-900 dark:text-white">{mcp.transport_type}</dd>
                </div>
                <div>
                  <dt className="text-sm/6 font-medium text-zinc-500 dark:text-zinc-400">Isolation Mode</dt>
                  <dd className="text-sm/6 text-zinc-900 dark:text-white">{mcp.isolation_mode}</dd>
                </div>
                <div>
                  <dt className="text-sm/6 font-medium text-zinc-500 dark:text-zinc-400">Auth Type</dt>
                  <dd className="text-sm/6 text-zinc-900 dark:text-white">
                    {mcp.auth_type === 'oauth2' ? 'OAuth 2.0' : mcp.auth_type === 'static' ? 'Static Credentials' : 'None'}
                  </dd>
                </div>
                <div>
                  <dt className="text-sm/6 font-medium text-zinc-500 dark:text-zinc-400">Requires Credentials</dt>
                  <dd className="text-sm/6 text-zinc-900 dark:text-white">{mcp.requires_user_credentials ? 'Yes' : 'No'}</dd>
                </div>
                <div>
                  <dt className="text-sm/6 font-medium text-zinc-500 dark:text-zinc-400">Created</dt>
                  <dd className="text-sm/6 text-zinc-900 dark:text-white">{new Date(mcp.created_at).toLocaleString()}</dd>
                </div>
                <div>
                  <dt className="text-sm/6 font-medium text-zinc-500 dark:text-zinc-400">Updated</dt>
                  <dd className="text-sm/6 text-zinc-900 dark:text-white">{new Date(mcp.updated_at).toLocaleString()}</dd>
                </div>
              </dl>
              {mcp.description && (
                <div className="mt-4">
                  <dt className="text-sm/6 font-medium text-zinc-500 dark:text-zinc-400">Description</dt>
                  <dd className="text-sm/6 text-zinc-900 dark:text-white mt-1">{mcp.description}</dd>
                </div>
              )}
            </div>

            {/* Tools Section */}
            <div className="mt-6 rounded-lg bg-white dark:bg-white/5 p-6 ring-1 ring-zinc-950/10 dark:ring-white/10">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-base/7 font-semibold text-zinc-900 dark:text-white">
                    Discovered Tools {mcp.tool_count != null ? `(${mcp.tool_count})` : ''}
                  </h3>
                  <p className="text-sm/6 text-zinc-500 dark:text-zinc-400">
                    Tools available from this MCP server
                  </p>
                </div>
                {(!parsedTools.length) && (mcp.requires_user_credentials || mcp.validation_status === 'valid') && (
                  <Button 
                    color="zinc" 
                    onClick={
                      // OAuth MCPs: use admin's stored credential
                      mcp.auth_type === 'oauth2' ? handleDiscover :
                      // Static credential MCPs: open credential dialog
                      mcp.requires_user_credentials ? () => setCredentialDialogOpen(true) :
                      // No credentials needed: discover directly
                      handleDiscover
                    } 
                    disabled={discoverTools.isPending}
                  >
                    <MagnifyingGlassIcon data-slot="icon" />
                    {discoverTools.isPending ? 'Discovering...' : 'Discover Tools'}
                  </Button>
                )}
              </div>
              {parsedTools.length > 0 ? (
                <div className="grid gap-2">
                  {parsedTools.map((tool: any, i: number) => (
                    <div key={i} className="rounded-lg bg-zinc-50 dark:bg-zinc-800 p-3">
                      <p className="font-mono text-sm font-medium text-zinc-900 dark:text-white">{tool.name}</p>
                      {tool.description && (
                        <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">{tool.description}</p>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-zinc-500 dark:text-zinc-400">
                  {mcp.validation_status === 'valid'
                    ? 'No tools discovered yet. Click "Discover Tools" to connect to the MCP server and find available tools.'
                    : 'Validate the MCP configuration first, then discover tools.'}
                </p>
              )}
            </div>
          </TabsContent>
          <TabsContent>
            <div className="space-y-4">
              <div className="rounded-lg bg-white dark:bg-white/5 p-6 ring-1 ring-zinc-950/10 dark:ring-white/10">
                <h3 className="text-base/7 font-semibold text-zinc-900 dark:text-white">Configuration</h3>
                <p className="text-sm/6 text-zinc-500 dark:text-zinc-400 mt-1">MCP runtime configuration (JSON)</p>
                <pre className="mt-4 rounded-lg bg-zinc-50 dark:bg-zinc-800 p-4 overflow-x-auto text-sm font-mono text-zinc-900 dark:text-white">
                  {typeof mcp.config === 'string' ? JSON.stringify(JSON.parse(mcp.config), null, 2) : JSON.stringify(mcp.config, null, 2)}
                </pre>
              </div>
              {mcp.auth_type === 'oauth2' && mcp.oauth_config && (() => {
                let oauthConfig: any = {};
                try {
                  oauthConfig = typeof mcp.oauth_config === 'string' ? JSON.parse(mcp.oauth_config) : mcp.oauth_config;
                } catch {
                  return null;
                }
                return (
                  <div className="rounded-lg bg-white dark:bg-white/5 p-6 ring-1 ring-zinc-950/10 dark:ring-white/10">
                    <h3 className="text-base/7 font-semibold text-zinc-900 dark:text-white">OAuth 2.0 Configuration</h3>
                    <p className="text-sm/6 text-zinc-500 dark:text-zinc-400 mt-1">Server-managed OAuth settings</p>
                    <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-4">
                      <div>
                        <dt className="text-sm/6 font-medium text-zinc-500 dark:text-zinc-400">Authorization URL</dt>
                        <dd className="text-sm/6 text-zinc-900 dark:text-white font-mono break-all">{oauthConfig.auth_url}</dd>
                      </div>
                      <div>
                        <dt className="text-sm/6 font-medium text-zinc-500 dark:text-zinc-400">Token URL</dt>
                        <dd className="text-sm/6 text-zinc-900 dark:text-white font-mono break-all">{oauthConfig.token_url}</dd>
                      </div>
                      <div>
                        <dt className="text-sm/6 font-medium text-zinc-500 dark:text-zinc-400">Scopes</dt>
                        <dd className="text-sm/6 text-zinc-900 dark:text-white font-mono">{oauthConfig.scopes}</dd>
                      </div>
                      <div>
                        <dt className="text-sm/6 font-medium text-zinc-500 dark:text-zinc-400">Client ID Environment Variable</dt>
                        <dd className="text-sm/6 text-zinc-900 dark:text-white font-mono">{oauthConfig.client_id_env}</dd>
                      </div>
                      <div>
                        <dt className="text-sm/6 font-medium text-zinc-500 dark:text-zinc-400">Client Secret Environment Variable</dt>
                        <dd className="text-sm/6 text-zinc-900 dark:text-white font-mono">{oauthConfig.client_secret_env}</dd>
                      </div>
                      <div>
                        <dt className="text-sm/6 font-medium text-zinc-500 dark:text-zinc-400">Access Token Environment Variable</dt>
                        <dd className="text-sm/6 text-zinc-900 dark:text-white font-mono">{oauthConfig.access_token_env_var}</dd>
                      </div>
                      {oauthConfig.revocation_url && (
                        <div>
                          <dt className="text-sm/6 font-medium text-zinc-500 dark:text-zinc-400">Revocation URL</dt>
                          <dd className="text-sm/6 text-zinc-900 dark:text-white font-mono break-all">{oauthConfig.revocation_url}</dd>
                        </div>
                      )}
                      {oauthConfig.extra_params && (
                        <div>
                          <dt className="text-sm/6 font-medium text-zinc-500 dark:text-zinc-400">Extra Parameters</dt>
                          <dd className="text-sm/6 text-zinc-900 dark:text-white">
                            <pre className="mt-1 rounded-lg bg-zinc-50 dark:bg-zinc-800 p-3 overflow-x-auto text-xs font-mono">
                              {JSON.stringify(oauthConfig.extra_params, null, 2)}
                            </pre>
                          </dd>
                        </div>
                      )}
                    </dl>
                  </div>
                );
              })()}
              {mcp.credential_schema && (
                <div className="rounded-lg bg-white dark:bg-white/5 p-6 ring-1 ring-zinc-950/10 dark:ring-white/10">
                  <h3 className="text-base/7 font-semibold text-zinc-900 dark:text-white">Credential Schema</h3>
                  <p className="text-sm/6 text-zinc-500 dark:text-zinc-400 mt-1">Required user credentials schema</p>
                  <pre className="mt-4 rounded-lg bg-zinc-50 dark:bg-zinc-800 p-4 overflow-x-auto text-sm font-mono text-zinc-900 dark:text-white">
                    {typeof mcp.credential_schema === 'string' ? JSON.stringify(JSON.parse(mcp.credential_schema), null, 2) : JSON.stringify(mcp.credential_schema, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          </TabsContent>
          <TabsContent>
            <div className="space-y-6">
              {/* Shared Connection Health */}
              <div className="rounded-lg bg-white dark:bg-white/5 p-6 ring-1 ring-zinc-950/10 dark:ring-white/10">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h3 className="text-base/7 font-semibold text-zinc-900 dark:text-white">Runtime Health</h3>
                    <p className="text-sm/6 text-zinc-500 dark:text-zinc-400">
                      Live connection status for this MCP server
                    </p>
                  </div>
                  <Button
                    color="zinc"
                    onClick={handleRestart}
                    disabled={restartMcp.isPending}
                  >
                    <ArrowPathIcon data-slot="icon" />
                    {restartMcp.isPending ? 'Restarting...' : 'Restart'}
                  </Button>
                </div>

                {healthLoading ? (
                  <div className="animate-pulse h-24 rounded bg-zinc-200 dark:bg-zinc-700" />
                ) : instanceData ? (
                  <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-4">
                    <div>
                      <dt className="text-sm/6 font-medium text-zinc-500 dark:text-zinc-400">Status</dt>
                      <dd className="mt-1 flex items-center gap-2">
                        <span className={`inline-block size-2.5 rounded-full ${
                          instanceData.shared.health.status === 'healthy'
                            ? 'bg-green-500'
                            : instanceData.shared.health.status === 'degraded'
                            ? 'bg-amber-500'
                            : 'bg-red-500'
                        }`} />
                        <span className={`text-sm font-medium ${
                          instanceData.shared.health.status === 'healthy'
                            ? 'text-green-700 dark:text-green-400'
                            : instanceData.shared.health.status === 'degraded'
                            ? 'text-amber-700 dark:text-amber-400'
                            : 'text-red-700 dark:text-red-400'
                        }`}>
                          {instanceData.shared.health.status.charAt(0).toUpperCase() + instanceData.shared.health.status.slice(1)}
                        </span>
                      </dd>
                    </div>
                    <div>
                      <dt className="text-sm/6 font-medium text-zinc-500 dark:text-zinc-400">Transport</dt>
                      <dd className="text-sm/6 text-zinc-900 dark:text-white mt-1">{instanceData.transport}</dd>
                    </div>
                    <div>
                      <dt className="text-sm/6 font-medium text-zinc-500 dark:text-zinc-400">Tools Loaded</dt>
                      <dd className="text-sm/6 text-zinc-900 dark:text-white mt-1">
                        {instanceData.shared.health.tool_count ?? instanceData.shared.detail.toolCount ?? '—'}
                      </dd>
                    </div>
                    {instanceData.shared.detail.uptime_ms != null && (
                      <div>
                        <dt className="text-sm/6 font-medium text-zinc-500 dark:text-zinc-400">Uptime</dt>
                        <dd className="text-sm/6 text-zinc-900 dark:text-white mt-1">
                          {formatUptime(instanceData.shared.detail.uptime_ms)}
                        </dd>
                      </div>
                    )}
                    {instanceData.shared.detail.pid != null && (
                      <div>
                        <dt className="text-sm/6 font-medium text-zinc-500 dark:text-zinc-400">Process ID</dt>
                        <dd className="text-sm/6 text-zinc-900 dark:text-white font-mono mt-1">{instanceData.shared.detail.pid}</dd>
                      </div>
                    )}
                    {instanceData.shared.detail.pendingRequests != null && (
                      <div>
                        <dt className="text-sm/6 font-medium text-zinc-500 dark:text-zinc-400">Pending Requests</dt>
                        <dd className="text-sm/6 text-zinc-900 dark:text-white mt-1">{instanceData.shared.detail.pendingRequests}</dd>
                      </div>
                    )}
                    {instanceData.shared.detail.consecutiveFailures != null && (
                      <div>
                        <dt className="text-sm/6 font-medium text-zinc-500 dark:text-zinc-400">Consecutive Failures</dt>
                        <dd className="text-sm/6 text-zinc-900 dark:text-white mt-1">
                          {instanceData.shared.detail.consecutiveFailures} / {instanceData.shared.detail.maxFailures}
                        </dd>
                      </div>
                    )}
                    {instanceData.shared.health.last_check && (
                      <div>
                        <dt className="text-sm/6 font-medium text-zinc-500 dark:text-zinc-400">Last Health Check</dt>
                        <dd className="text-sm/6 text-zinc-900 dark:text-white mt-1">
                          {new Date(instanceData.shared.health.last_check).toLocaleTimeString()}
                        </dd>
                      </div>
                    )}
                    {instanceData.shared.health.error && (
                      <div className="sm:col-span-2 lg:col-span-3">
                        <dt className="text-sm/6 font-medium text-red-500 dark:text-red-400">Error</dt>
                        <dd className="text-sm/6 text-red-700 dark:text-red-400 font-mono mt-1 bg-red-50 dark:bg-red-500/10 p-2 rounded">
                          {instanceData.shared.health.error}
                        </dd>
                      </div>
                    )}
                  </dl>
                ) : (
                  <p className="text-sm text-zinc-500 dark:text-zinc-400">
                    No runtime health data available. This MCP may not be published or connected.
                  </p>
                )}
              </div>

              {/* Recent Errors */}
              <div className="rounded-lg bg-white dark:bg-white/5 p-6 ring-1 ring-zinc-950/10 dark:ring-white/10">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h3 className="text-base/7 font-semibold text-zinc-900 dark:text-white">Recent Errors</h3>
                    <p className="text-sm/6 text-zinc-500 dark:text-zinc-400">
                      Last {logsData?.total_count ?? 0} error and stderr entries
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button color="zinc" onClick={copyLogs}>
                      Copy
                    </Button>
                    <Button color="zinc" onClick={clearLogs}>
                      Clear
                    </Button>
                  </div>
                </div>
                {logsData && logsData.entries.length > 0 ? (
                  <div className="rounded-lg bg-zinc-900 text-zinc-100 font-mono text-sm p-4 overflow-auto max-h-64 space-y-0.5">
                    {logsData.entries.map((entry, idx) => (
                      <div key={idx} className={`${
                        entry.level === 'error' ? 'text-red-400' :
                        entry.level === 'warn' ? 'text-amber-400' : 'text-zinc-400'
                      }`}>
                        <span className="text-zinc-500">[{new Date(entry.timestamp).toLocaleTimeString()}]</span>{' '}
                        {entry.message}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-lg bg-zinc-50 dark:bg-zinc-800 p-8 text-center">
                    <CheckCircleIcon className="size-8 mx-auto text-green-500 mb-2" />
                    <p className="text-sm text-zinc-500 dark:text-zinc-400">No recent errors</p>
                  </div>
                )}
              </div>

              {/* Per-User Instances */}
              {instanceData && instanceData.user_instances.length > 0 && (
                <div className="rounded-lg bg-white dark:bg-white/5 p-6 ring-1 ring-zinc-950/10 dark:ring-white/10">
                  <h3 className="text-base/7 font-semibold text-zinc-900 dark:text-white mb-4">
                    Per-User Instances ({instanceData.user_instances.length})
                  </h3>
                  <div className="grid gap-3">
                    {instanceData.user_instances.map((instance, i) => (
                      <div
                        key={i}
                        className={`rounded-lg p-3 ${
                          instance.error_count > 0
                            ? 'bg-red-50 dark:bg-red-950/20 ring-1 ring-red-200 dark:ring-red-900/50'
                            : 'bg-zinc-50 dark:bg-zinc-800'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex-1 space-y-2">
                            <div className="flex items-center gap-3">
                              <span className={`inline-block size-2 rounded-full ${
                                instance.connected ? 'bg-green-500' : 'bg-red-500'
                              }`} />
                              <span className="text-sm font-mono font-medium text-zinc-900 dark:text-white">{instance.userId}</span>
                              <Badge color={instance.status === 'ready' ? 'green' : instance.status === 'spawning' ? 'amber' : 'zinc'}>
                                {instance.status}
                              </Badge>
                              {instance.error_count > 0 && (
                                <Badge color="red">{instance.error_count} errors</Badge>
                              )}
                            </div>
                            <div className="flex items-center gap-4 text-sm text-zinc-500 dark:text-zinc-400">
                              <span>{instance.toolCount} tools</span>
                              <span>Spawned {new Date(instance.spawnedAt).toLocaleTimeString()}</span>
                            </div>
                            {instance.last_error && (
                              <div className="text-sm text-red-600 dark:text-red-400 font-mono bg-red-50 dark:bg-red-950/30 p-2 rounded" title={instance.last_error}>
                                {instance.last_error.length > 120 ? `${instance.last_error.slice(0, 120)}...` : instance.last_error}
                              </div>
                            )}
                          </div>
                          <Button
                            color="zinc"
                            onClick={() => handleRestartUserInstance(instance.userId)}
                            disabled={restartUserMcp.isPending}
                          >
                            <ArrowPathIcon data-slot="icon" />
                            Restart
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </TabsContent>
        </TabsPanels>
      </Tabs>

      {/* Edit Dialog */}
      <Dialog open={editDialogOpen} onClose={setEditDialogOpen}>
        <DialogBody>
          <DialogTitle>Edit MCP</DialogTitle>
          <DialogDescription>Update MCP configuration</DialogDescription>
          <div className="space-y-4 mt-4">
            <Field>
              <Label>Display Name</Label>
              <Input
                value={editFormData.display_name}
                onChange={(e) =>
                  setEditFormData({ ...editFormData, display_name: e.target.value })
                }
              />
            </Field>
            <Field>
              <Label>Description</Label>
              <Textarea
                value={editFormData.description}
                onChange={(e) =>
                  setEditFormData({ ...editFormData, description: e.target.value })
                }
                rows={3}
              />
            </Field>
            <Field>
              <Label>Icon URL</Label>
              <Input
                value={editFormData.icon_url}
                onChange={(e) =>
                  setEditFormData({ ...editFormData, icon_url: e.target.value })
                }
              />
            </Field>
            <Field>
              <Label>Configuration (JSON)</Label>
              <Textarea
                value={editFormData.config}
                onChange={(e) =>
                  setEditFormData({ ...editFormData, config: e.target.value })
                }
                rows={10}
                className="font-mono"
              />
            </Field>
            {mcp.status === 'published' && (
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Transport type, isolation mode, and credential settings cannot be changed for published MCPs. Archive and recreate if changes are needed.
              </p>
            )}

            {/* Structural fields editable only for non-published (draft/archived) MCPs */}
            {mcp.status !== 'published' && (
              <>
                <Field>
                  <Label>Transport Type</Label>
                  <Listbox
                    name="transport-type"
                    value={editFormData.transport_type}
                    onChange={(value: string) =>
                      setEditFormData({ ...editFormData, transport_type: value as any })
                    }
                  >
                    <ListboxOption value="stdio"><ListboxLabel>stdio</ListboxLabel></ListboxOption>
                    <ListboxOption value="http"><ListboxLabel>http</ListboxLabel></ListboxOption>
                    <ListboxOption value="sse"><ListboxLabel>sse</ListboxLabel></ListboxOption>
                  </Listbox>
                </Field>
                <Field>
                  <Label>Isolation Mode</Label>
                  <Listbox
                    name="isolation-mode"
                    value={editFormData.isolation_mode}
                    onChange={(value: string) =>
                      setEditFormData({ ...editFormData, isolation_mode: value as any })
                    }
                  >
                    <ListboxOption value="shared"><ListboxLabel>shared</ListboxLabel></ListboxOption>
                    <ListboxOption value="per_user"><ListboxLabel>per_user</ListboxLabel></ListboxOption>
                  </Listbox>
                </Field>

                <Field>
                  <Label>Authentication Type</Label>
                  <Listbox
                    name="auth-type"
                    value={editFormData.auth_type}
                    onChange={(value: string) =>
                      setEditFormData({ ...editFormData, auth_type: value as 'none' | 'static' | 'oauth2' })
                    }
                  >
                    <ListboxOption value="none"><ListboxLabel>None</ListboxLabel></ListboxOption>
                    <ListboxOption value="static"><ListboxLabel>Static Credentials</ListboxLabel></ListboxOption>
                    <ListboxOption value="oauth2"><ListboxLabel>OAuth 2.0</ListboxLabel></ListboxOption>
                  </Listbox>
                </Field>

                {/* Static auth: show credential schema */}
                {editFormData.auth_type === 'static' && (
                  <Field>
                    <Label>Credential Schema (JSON)</Label>
                    <Textarea
                      value={editFormData.credential_schema}
                      onChange={(e) =>
                        setEditFormData({ ...editFormData, credential_schema: e.target.value })
                      }
                      rows={8}
                      className="font-mono"
                      placeholder='{\n  "type": "object",\n  "required": ["api_key"],\n  "properties": {\n    "api_key": {\n      "type": "string",\n      "description": "API Key"\n    }\n  }\n}'
                    />
                  </Field>
                )}

                {/* OAuth2 auth: show OAuth config fields */}
                {editFormData.auth_type === 'oauth2' && (
                  <>
                    <Field>
                      <Label>Authorization URL *</Label>
                      <Input
                        value={editFormData.oauth_auth_url}
                        onChange={(e) => setEditFormData({ ...editFormData, oauth_auth_url: e.target.value })}
                        placeholder="https://accounts.google.com/o/oauth2/v2/auth"
                      />
                    </Field>
                    <Field>
                      <Label>Token URL *</Label>
                      <Input
                        value={editFormData.oauth_token_url}
                        onChange={(e) => setEditFormData({ ...editFormData, oauth_token_url: e.target.value })}
                        placeholder="https://oauth2.googleapis.com/token"
                      />
                    </Field>
                    <Field>
                      <Label>Scopes *</Label>
                      <Input
                        value={editFormData.oauth_scopes}
                        onChange={(e) => setEditFormData({ ...editFormData, oauth_scopes: e.target.value })}
                        placeholder="openid email profile"
                      />
                    </Field>
                    <Field>
                      <Label>Client ID Env Var *</Label>
                      <Input
                        value={editFormData.oauth_client_id_env}
                        onChange={(e) => setEditFormData({ ...editFormData, oauth_client_id_env: e.target.value })}
                        placeholder="GOOGLE_OAUTH_CLIENT_ID"
                      />
                    </Field>
                    <Field>
                      <Label>Client Secret Env Var *</Label>
                      <Input
                        value={editFormData.oauth_client_secret_env}
                        onChange={(e) => setEditFormData({ ...editFormData, oauth_client_secret_env: e.target.value })}
                        placeholder="GOOGLE_OAUTH_CLIENT_SECRET"
                      />
                    </Field>
                    <Field>
                      <Label>Access Token Env Var *</Label>
                      <Input
                        value={editFormData.oauth_access_token_env_var}
                        onChange={(e) => setEditFormData({ ...editFormData, oauth_access_token_env_var: e.target.value })}
                        placeholder="GOOGLE_ACCESS_TOKEN"
                      />
                    </Field>
                    <Field>
                      <Label>Revocation URL</Label>
                      <Input
                        value={editFormData.oauth_revocation_url}
                        onChange={(e) => setEditFormData({ ...editFormData, oauth_revocation_url: e.target.value })}
                        placeholder="https://oauth2.googleapis.com/revoke"
                      />
                    </Field>
                    <Field>
                      <Label>Extra Parameters (JSON)</Label>
                      <Textarea
                        value={editFormData.oauth_extra_params}
                        onChange={(e) => setEditFormData({ ...editFormData, oauth_extra_params: e.target.value })}
                        rows={4}
                        className="font-mono text-sm"
                        placeholder='{"access_type": "offline"}'
                      />
                    </Field>
                  </>
                )}
              </>
            )}
          </div>
          <DialogActions>
            <Button color="zinc" onClick={() => setEditDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleEdit} disabled={updateMcp.isPending}>
              {updateMcp.isPending ? 'Saving...' : 'Save Changes'}
            </Button>
          </DialogActions>
        </DialogBody>
      </Dialog>

      {/* Credential Dialog for Tool Discovery (Static Auth Only) */}
      {mcp?.auth_type !== 'oauth2' && (
        <Dialog open={credentialDialogOpen} onClose={() => { setCredentialDialogOpen(false); setCredentialValues({}); }}>
          <DialogBody>
            <DialogTitle>Provide Credentials for Discovery</DialogTitle>
            <DialogDescription>
              This MCP requires credentials to connect. Enter temporary credentials below — they will NOT be stored and are used only for this discovery attempt.
            </DialogDescription>
            <div className="space-y-4 mt-4">
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
            <Button color="zinc" onClick={() => { setCredentialDialogOpen(false); setCredentialValues({}); }}>
              Cancel
            </Button>
            <Button
              onClick={handleCredentialDiscover}
              disabled={discoverTools.isPending || credentialFields.some(f => f.required && !credentialValues[f.key]?.trim())}
            >
              <MagnifyingGlassIcon data-slot="icon" />
              {discoverTools.isPending ? 'Discovering...' : 'Discover Tools'}
            </Button>
          </DialogActions>
        </DialogBody>
      </Dialog>
      )}

      {/* Delete confirmation dialog */}
      <Alert open={deleteDialogOpen} onClose={setDeleteDialogOpen}>
        <AlertTitle>Delete MCP?</AlertTitle>
        <AlertDescription>
          This will permanently delete &ldquo;{mcp?.display_name}&rdquo;. This action cannot be undone.
        </AlertDescription>
        <AlertActions>
          <Button plain onClick={() => setDeleteDialogOpen(false)}>Cancel</Button>
          <Button color="red" onClick={handleDelete} disabled={deleteMcp.isPending}>
            {deleteMcp.isPending ? 'Deleting...' : 'Delete'}
          </Button>
        </AlertActions>
      </Alert>

      {/* Archive confirmation dialog */}
      <ConfirmDialog
        open={archiveDialogOpen}
        onClose={setArchiveDialogOpen}
        title="Archive MCP?"
        description={`This will archive "${mcp?.display_name}" and make it unavailable to users. You can re-publish it later.`}
        confirmLabel="Archive"
        confirmColor="amber"
        onConfirm={handleArchive}
        isLoading={archiveMcp.isPending}
      />
    </div>
  );
}
