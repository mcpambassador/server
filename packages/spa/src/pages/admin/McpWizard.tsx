import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircleIcon, ArrowLeftIcon, ArrowRightIcon } from '@heroicons/react/20/solid';
import { toast } from 'sonner';
import { Heading } from '@/components/catalyst/heading';
import { Text } from '@/components/catalyst/text';
import { Button } from '@/components/catalyst/button';
import { useCreateMcp, useUpdateMcp, useValidateMcp, useDiscoverTools, usePublishMcp } from '@/api/hooks/use-admin';
import { usePageTitle } from '@/hooks/usePageTitle';
import type { ValidationResult, DiscoveryResult, RegistryMcp } from '@/api/types';
import { Breadcrumb } from '@/components/shared/Breadcrumb';
import { RegistryImportModal } from '@/components/admin/RegistryImportModal';
import { mapRegistryEntryToFormData } from '@/lib/registryMapper';
import { BasicInfoStep } from './wizard/BasicInfoStep';
import { ConfigurationStep } from './wizard/ConfigurationStep';
import { ValidateStep } from './wizard/ValidateStep';
import { ReviewStep } from './wizard/ReviewStep';

const STEPS = ['Basic Info', 'Configuration', 'Validate', 'Review'];

type FormData = {
  name: string;
  display_name: string;
  description: string;
  icon_url: string;
  transport_type: 'stdio' | 'http' | 'sse';
  isolation_mode: 'shared' | 'per_user';
  config: string;
  auth_type: 'none' | 'static' | 'oauth2';
  requires_user_credentials: boolean;
  credential_schema: string;
  oauth_auth_url: string;
  oauth_token_url: string;
  oauth_scopes: string;
  oauth_client_id_env: string;
  oauth_client_secret_env: string;
  oauth_access_token_env_var: string;
  oauth_revocation_url: string;
  oauth_extra_params: string;
};

export function McpWizard() {
  usePageTitle('Admin - Create MCP');
  const navigate = useNavigate();
  const createMcp = useCreateMcp();
  const updateMcp = useUpdateMcp();
  const validateMcp = useValidateMcp();
  const discoverTools = useDiscoverTools();
  const publishMcp = usePublishMcp();

  const [currentStep, setCurrentStep] = useState(0);
  const [createdMcpId, setCreatedMcpId] = useState<string | null>(null);
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null);
  const [discoveryResult, setDiscoveryResult] = useState<DiscoveryResult | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [registryModalOpen, setRegistryModalOpen] = useState(false);
  const [importedFromRegistry, setImportedFromRegistry] = useState<string | null>(null);

  const [formData, setFormData] = useState<FormData>({
    name: '',
    display_name: '',
    description: '',
    icon_url: '',
    transport_type: 'stdio',
    isolation_mode: 'shared',
    config: '{\n  \n}',
    auth_type: 'none',
    requires_user_credentials: false,
    credential_schema: '{\n  \n}',
    oauth_auth_url: '',
    oauth_token_url: '',
    oauth_scopes: '',
    oauth_client_id_env: '',
    oauth_client_secret_env: '',
    oauth_access_token_env_var: '',
    oauth_revocation_url: '',
    oauth_extra_params: '',
  });

  const patchFormData = (patch: Partial<FormData>) =>
    setFormData((prev) => ({ ...prev, ...patch }));

  const handleRegistrySelect = (entry: RegistryMcp) => {
    const mapped = mapRegistryEntryToFormData(entry, {
      oauth_access_token_env_var: formData.oauth_access_token_env_var,
    });
    setFormData((prev) => ({ ...prev, ...mapped }));
    setImportedFromRegistry(entry.display_name);
    toast.success('Registry Import', {
      description: `Pre-filled wizard from "${entry.display_name}". Review and edit as needed.`,
    });
  };

  const handleNext = async () => {
    if (currentStep === 0) {
      const nextErrors: Record<string, string> = {};
      if (!formData.display_name) nextErrors.display_name = 'Display name is required';
      if (!formData.name) nextErrors.name = 'Internal name is required';
      else if (!/^[a-z0-9_]+$/.test(formData.name))
        nextErrors.name =
          'Internal name must be lowercase, no spaces, letters, numbers, and underscores only';

      if (Object.keys(nextErrors).length > 0) {
        setErrors(nextErrors);
        toast.error('Validation', { description: 'Please fix the highlighted fields' });
        return;
      }
      setErrors({});
    }

    if (currentStep === 1) {
      try {
        let configObj: Record<string, unknown>;
        try {
          configObj = JSON.parse(formData.config);
        } catch {
          setErrors({ config: 'Invalid JSON in config field' });
          toast.error('Invalid JSON', { description: 'Invalid JSON in config field' });
          return;
        }

        const configErrors: Record<string, string> = {};
        if (formData.transport_type === 'stdio') {
          const cfg = configObj as Record<string, unknown>;
          const cmd = cfg['command'];
          const args = cfg['args'];
          if (!cmd || typeof cmd !== 'string' || cmd.trim() === '') {
            configErrors.config = 'Stdio config must include a non-empty "command" string';
          }
          if (
            !Array.isArray(args) ||
            args.length === 0 ||
            (args as unknown[]).some((a: unknown) => typeof a !== 'string' || (a as string).trim() === '')
          ) {
            configErrors.config =
              (configErrors.config ? configErrors.config + '. ' : '') +
              'Stdio config must include non-empty "args" array';
          }
        }
        if (formData.transport_type === 'http' || formData.transport_type === 'sse') {
          const cfg = configObj as Record<string, unknown>;
          const url =
            (cfg['url'] as string) ||
            (cfg['template_url'] as string) ||
            (cfg['endpoint'] as string) ||
            '';
          if (!url || typeof url !== 'string') {
            configErrors.config =
              'HTTP/SSE config must include a URL string (e.g. "url" or "template_url")';
          } else {
            try {
              new URL(url);
            } catch {
              configErrors.config = 'Provided URL in config is not a valid URL';
            }
          }
        }

        if (Object.keys(configErrors).length > 0) {
          setErrors(configErrors);
          toast.error('Configuration Validation', {
            description: 'Please fix the configuration errors',
          });
          return;
        }
        setErrors({});

        let credentialSchemaObj: Record<string, unknown> | undefined;
        let oauthConfigObj: Record<string, unknown> | undefined;
        let requiresUserCredentials = false;
        const authType = formData.auth_type;

        if (authType === 'static') {
          requiresUserCredentials = true;
          if (formData.credential_schema.trim()) {
            try {
              credentialSchemaObj = JSON.parse(formData.credential_schema);
            } catch {
              setErrors({ credential_schema: 'Invalid JSON in credential schema field' });
              toast.error('Invalid JSON', { description: 'Invalid JSON in credential schema field' });
              return;
            }
          }
        } else if (authType === 'oauth2') {
          requiresUserCredentials = true;
          const oauthErrors: Record<string, string> = {};
          if (!formData.oauth_auth_url.trim()) oauthErrors.oauth_auth_url = 'Authorization URL is required';
          if (!formData.oauth_token_url.trim()) oauthErrors.oauth_token_url = 'Token URL is required';
          if (!formData.oauth_scopes.trim()) oauthErrors.oauth_scopes = 'Scopes are required';
          if (!formData.oauth_client_id_env.trim()) oauthErrors.oauth_client_id_env = 'Client ID env var is required';
          if (!formData.oauth_client_secret_env.trim()) oauthErrors.oauth_client_secret_env = 'Client secret env var is required';
          if (!formData.oauth_access_token_env_var.trim()) oauthErrors.oauth_access_token_env_var = 'Access token env var is required';

          if (Object.keys(oauthErrors).length > 0) {
            setErrors(oauthErrors);
            toast.error('OAuth Configuration', { description: 'Please fill all required OAuth fields' });
            return;
          }

          oauthConfigObj = {
            auth_url: formData.oauth_auth_url.trim(),
            token_url: formData.oauth_token_url.trim(),
            scopes: formData.oauth_scopes.trim(),
            client_id_env: formData.oauth_client_id_env.trim(),
            client_secret_env: formData.oauth_client_secret_env.trim(),
            access_token_env_var: formData.oauth_access_token_env_var.trim(),
          };

          if (formData.oauth_revocation_url.trim()) {
            oauthConfigObj.revocation_url = formData.oauth_revocation_url.trim();
          }

          if (formData.oauth_extra_params.trim()) {
            try {
              oauthConfigObj.extra_params = JSON.parse(formData.oauth_extra_params);
            } catch {
              setErrors({ oauth_extra_params: 'Invalid JSON in extra parameters' });
              toast.error('Invalid JSON', { description: 'Extra parameters must be valid JSON' });
              return;
            }
          }
        }

        if (createdMcpId) {
          await updateMcp.mutateAsync({
            mcpId: createdMcpId,
            data: {
              display_name: formData.display_name,
              description: formData.description || undefined,
              icon_url: formData.icon_url || undefined,
              transport_type: formData.transport_type,
              isolation_mode: formData.isolation_mode,
              config: configObj,
              auth_type: authType,
              requires_user_credentials: requiresUserCredentials,
              credential_schema: credentialSchemaObj,
              oauth_config: oauthConfigObj,
            },
          });
        } else {
          const result = await createMcp.mutateAsync({
            name: formData.name,
            display_name: formData.display_name,
            description: formData.description || undefined,
            icon_url: formData.icon_url || undefined,
            transport_type: formData.transport_type,
            isolation_mode: formData.isolation_mode,
            config: configObj,
            auth_type: authType,
            requires_user_credentials: requiresUserCredentials,
            credential_schema: credentialSchemaObj,
            oauth_config: oauthConfigObj,
          });
          setCreatedMcpId(result.mcp_id);
        }
      } catch (error) {
        toast.error(createdMcpId ? 'Update MCP failed' : 'Create MCP failed', {
          description: (error as Error)?.message ?? String(error),
        });
        return;
      }
    }

    if (currentStep === 2) {
      if (!validationResult?.valid) {
        toast.error('Validation Required', {
          description: 'Please validate the MCP configuration before proceeding',
        });
        return;
      }
    }

    setCurrentStep((prev) => Math.min(prev + 1, STEPS.length - 1));
  };

  const handleBack = () => {
    if (currentStep === 2) {
      setValidationResult(null);
      setDiscoveryResult(null);
    }
    setCurrentStep((prev) => Math.max(prev - 1, 0));
  };

  const handleValidate = async () => {
    if (!createdMcpId) return;
    try {
      const result = await validateMcp.mutateAsync(createdMcpId);
      setValidationResult(result);
      setDiscoveryResult(null);
    } catch (error) {
      toast.error('Validate MCP failed', { description: (error as Error)?.message ?? String(error) });
    }
  };

  const handleDiscover = async () => {
    if (!createdMcpId) return;
    try {
      const result = await discoverTools.mutateAsync({ mcpId: createdMcpId });
      setDiscoveryResult(result);
      if (result.status === 'success') {
        toast.success('Tool Discovery', { description: `Discovered ${result.tool_count} tools` });
      } else if (result.status === 'skipped') {
        toast.info('Tool Discovery', { description: result.message || 'Discovery skipped for credential-gated MCP' });
      } else {
        toast.error('Tool Discovery', { description: result.message || 'Discovery failed' });
      }
    } catch (error) {
      toast.error('Discover Tools failed', { description: (error as Error)?.message ?? String(error) });
    }
  };

  const handlePublish = async () => {
    if (!createdMcpId) return;
    try {
      await publishMcp.mutateAsync(createdMcpId);
      navigate(`/app/admin/mcps/${createdMcpId}`);
    } catch (error) {
      toast.error('Publish MCP failed', { description: (error as Error)?.message ?? String(error) });
    }
  };

  const handleSaveDraft = () => {
    if (createdMcpId) navigate(`/app/admin/mcps/${createdMcpId}`);
  };

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <Breadcrumb
        items={[
          { label: 'MCPs', href: '/app/admin/mcps' },
          { label: 'Create New' },
        ]}
      />

      <div>
        <Heading>Create New MCP</Heading>
        <Text>Multi-step wizard for MCP catalog entry</Text>
      </div>

      {/* Step Indicator */}
      <ol role="list" className="flex items-center justify-between">
        {STEPS.map((step, index) => (
          <li key={step} className="flex items-center">
            <div
              className={`flex items-center justify-center w-10 h-10 rounded-full border-2 ${
                index <= currentStep
                  ? 'border-zinc-900 bg-zinc-900 text-white dark:border-white dark:bg-white dark:text-zinc-900'
                  : 'border-zinc-300 bg-white text-zinc-500 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-400'
              }`}
              aria-current={index === currentStep ? 'step' : undefined}
            >
              {index < currentStep ? <CheckCircleIcon className="size-5" /> : index + 1}
            </div>
            <div className="ml-2 text-sm">
              <p
                className={
                  index <= currentStep
                    ? 'font-medium text-zinc-900 dark:text-white'
                    : 'text-zinc-500 dark:text-zinc-400'
                }
              >
                {step}
              </p>
            </div>
            {index < STEPS.length - 1 && (
              <div
                className={`h-0.5 w-16 mx-4 ${
                  index < currentStep ? 'bg-zinc-900 dark:bg-white' : 'bg-zinc-200 dark:bg-zinc-700'
                }`}
              />
            )}
          </li>
        ))}
      </ol>

      {/* Step Content Panel */}
      <div className="rounded-lg bg-white dark:bg-white/5 p-6 ring-1 ring-zinc-950/10 dark:ring-white/10">
        <h3 className="text-base/7 font-semibold text-zinc-900 dark:text-white">
          {STEPS[currentStep]}
        </h3>
        <p className="text-sm/6 text-zinc-500 dark:text-zinc-400 mb-6">
          {currentStep === 0 && 'Enter basic MCP information'}
          {currentStep === 1 && 'Configure MCP runtime settings'}
          {currentStep === 2 && 'Validate MCP configuration'}
          {currentStep === 3 && 'Review and publish'}
        </p>

        <div className="space-y-4">
          {currentStep === 0 && (
            <BasicInfoStep
              formData={formData}
              errors={errors}
              createdMcpId={createdMcpId}
              importedFromRegistry={importedFromRegistry}
              onChange={patchFormData}
              onOpenRegistryModal={() => setRegistryModalOpen(true)}
            />
          )}
          {currentStep === 1 && (
            <ConfigurationStep
              formData={formData}
              errors={errors}
              onChange={patchFormData}
            />
          )}
          {currentStep === 2 && (
            <ValidateStep
              validationResult={validationResult}
              discoveryResult={discoveryResult}
              isValidating={validateMcp.isPending}
              isDiscovering={discoverTools.isPending}
              onValidate={handleValidate}
              onDiscover={handleDiscover}
            />
          )}
          {currentStep === 3 && (
            <ReviewStep
              formData={formData}
              validationResult={validationResult}
              discoveryResult={discoveryResult}
              isPublishing={publishMcp.isPending}
              onPublish={handlePublish}
              onSaveDraft={handleSaveDraft}
            />
          )}
        </div>
      </div>

      {/* Navigation Buttons */}
      {currentStep < 3 && (
        <div className="flex justify-between">
          <Button color="zinc" onClick={handleBack} disabled={currentStep === 0}>
            <ArrowLeftIcon data-slot="icon" />
            Back
          </Button>
          <Button
            onClick={handleNext}
            disabled={
              (currentStep === 1 && (createMcp.isPending || updateMcp.isPending)) ||
              (currentStep === 2 && validateMcp.isPending)
            }
          >
            {(currentStep === 1 && (createMcp.isPending || updateMcp.isPending)) ||
            (currentStep === 2 && validateMcp.isPending)
              ? 'Loading...'
              : 'Next'}
            <ArrowRightIcon data-slot="icon" />
          </Button>
        </div>
      )}

      <RegistryImportModal
        open={registryModalOpen}
        onClose={() => setRegistryModalOpen(false)}
        onSelect={handleRegistrySelect}
      />
    </div>
  );
}
