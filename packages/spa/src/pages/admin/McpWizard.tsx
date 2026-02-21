import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircleIcon, ExclamationTriangleIcon, ArrowLeftIcon, ArrowRightIcon, MagnifyingGlassIcon, ArrowPathIcon } from '@heroicons/react/20/solid';
import { toast } from 'sonner';
import { Heading } from '@/components/catalyst/heading';
import { Text } from '@/components/catalyst/text';
import { Button } from '@/components/catalyst/button';
import { Badge } from '@/components/catalyst/badge';
import { Input } from '@/components/catalyst/input';
import { Field, Label } from '@/components/catalyst/fieldset';
import { Textarea } from '@/components/catalyst/textarea';
import { Checkbox, CheckboxField } from '@/components/catalyst/checkbox';
import { Divider } from '@/components/catalyst/divider';
import { Listbox, ListboxOption, ListboxLabel } from '@/components/catalyst/listbox';
import { useCreateMcp, useValidateMcp, useDiscoverTools, usePublishMcp } from '@/api/hooks/use-admin';
import { usePageTitle } from '@/hooks/usePageTitle';

const STEPS = ['Basic Info', 'Configuration', 'Validate', 'Review'];

export function McpWizard() {
  usePageTitle('Admin - Create MCP');
  const navigate = useNavigate();
  const createMcp = useCreateMcp();
  const validateMcp = useValidateMcp();
  const discoverTools = useDiscoverTools();
  const publishMcp = usePublishMcp();

  const [currentStep, setCurrentStep] = useState(0);
  const [createdMcpId, setCreatedMcpId] = useState<string | null>(null);
  const [validationResult, setValidationResult] = useState<any>(null);
  const [discoveryResult, setDiscoveryResult] = useState<any>(null);

  const [formData, setFormData] = useState({
    name: '',
    display_name: '',
    description: '',
    icon_url: '',
    transport_type: 'stdio' as 'stdio' | 'http' | 'sse',
    isolation_mode: 'shared' as 'shared' | 'per_user',
    config: '{\n  \n}',
    requires_user_credentials: false,
    credential_schema: '{\n  \n}',
  });

  const handleNext = async () => {
    if (currentStep === 0) {
      // Basic validation
      if (!formData.name || !formData.display_name) {
        toast.error('Validation', { description: 'Name and Display Name are required' });
        return;
      }
    }

    if (currentStep === 1) {
      // Create the MCP
      try {
        let configObj: Record<string, unknown>;
        try {
          configObj = JSON.parse(formData.config);
        } catch {
          toast.error('Invalid JSON', { description: 'Invalid JSON in config field' });
          return;
        }

        let credentialSchemaObj: Record<string, unknown> | undefined;
        if (formData.requires_user_credentials) {
          try {
            credentialSchemaObj = JSON.parse(formData.credential_schema);
          } catch {
            toast.error('Invalid JSON', { description: 'Invalid JSON in credential schema field' });
            return;
          }
        }

        const result = await createMcp.mutateAsync({
          name: formData.name,
          display_name: formData.display_name,
          description: formData.description || undefined,
          icon_url: formData.icon_url || undefined,
          transport_type: formData.transport_type,
          isolation_mode: formData.isolation_mode,
          config: configObj,
          requires_user_credentials: formData.requires_user_credentials,
          credential_schema: credentialSchemaObj,
        });

        setCreatedMcpId(result.mcp_id);
      } catch (error) {
        toast.error('Create MCP failed', { description: (error as Error)?.message ?? String(error) });
        return;
      }
    }

    if (currentStep === 2) {
      // Ensure validation passed before proceeding to review
      if (!validationResult?.valid) {
        toast.error('Validation Required', { description: 'Please validate the MCP configuration before proceeding' });
        return;
      }
    }

    setCurrentStep((prev) => Math.min(prev + 1, STEPS.length - 1));
  };

  const handleBack = () => {
    setCurrentStep((prev) => Math.max(prev - 1, 0));
  };

  const handleValidateStep = async () => {
    if (!createdMcpId) return;
    try {
      const result = await validateMcp.mutateAsync(createdMcpId);
      setValidationResult(result);
      setDiscoveryResult(null);
    } catch (error) {
      toast.error('Validate MCP failed', { description: (error as Error)?.message ?? String(error) });
    }
  };

  const handleDiscoverStep = async () => {
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
    if (createdMcpId) {
      navigate(`/app/admin/mcps/${createdMcpId}`);
    }
  };

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      {/* Header */}
      <div>
        <Heading>Create New MCP</Heading>
        <Text>Multi-step wizard for MCP catalog entry</Text>
      </div>

      {/* Step Indicator */}
      <div className="flex items-center justify-between">
        {STEPS.map((step, index) => (
          <div key={step} className="flex items-center">
            <div
              className={`flex items-center justify-center w-10 h-10 rounded-full border-2 ${
                index <= currentStep
                  ? 'border-zinc-900 bg-zinc-900 text-white dark:border-white dark:bg-white dark:text-zinc-900'
                  : 'border-zinc-300 bg-white text-zinc-500 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-400'
              }`}
            >
              {index < currentStep ? <CheckCircleIcon className="size-5" /> : index + 1}
            </div>
            <div className="ml-2 text-sm">
              <p className={index <= currentStep ? 'font-medium text-zinc-900 dark:text-white' : 'text-zinc-500 dark:text-zinc-400'}>
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
          </div>
        ))}
      </div>

      {/* Step Content Panel */}
      <div className="rounded-lg bg-white dark:bg-white/5 p-6 ring-1 ring-zinc-950/5 dark:ring-white/10">
        <h3 className="text-base/7 font-semibold text-zinc-900 dark:text-white">{STEPS[currentStep]}</h3>
        <p className="text-sm/6 text-zinc-500 dark:text-zinc-400 mb-6">
          {currentStep === 0 && 'Enter basic MCP information'}
          {currentStep === 1 && 'Configure MCP runtime settings'}
          {currentStep === 2 && 'Validate MCP configuration'}
          {currentStep === 3 && 'Review and publish'}
        </p>

        <div className="space-y-4">
          {/* Step 0: Basic Info */}
          {currentStep === 0 && (
            <>
              <Field>
                <Label>Internal Name * (e.g., github, slack)</Label>
                <Input
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder="github"
                />
              </Field>
              <Field>
                <Label>Display Name *</Label>
                <Input
                  value={formData.display_name}
                  onChange={(e) => setFormData({ ...formData, display_name: e.target.value })}
                  placeholder="GitHub"
                />
              </Field>
              <Field>
                <Label>Description</Label>
                <Textarea
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  rows={3}
                  placeholder="Interact with GitHub repositories and issues"
                />
              </Field>
              <Field>
                <Label>Icon URL</Label>
                <Input
                  value={formData.icon_url}
                  onChange={(e) => setFormData({ ...formData, icon_url: e.target.value })}
                  placeholder="https://..."
                />
              </Field>
              <Field>
                <Label>Transport Type</Label>
                <Listbox
                  name="transport-type"
                  value={formData.transport_type}
                  onChange={(value: string) =>
                    setFormData({
                      ...formData,
                      transport_type: value as any,
                    })
                  }
                >
                  <ListboxOption value="stdio">
                    <ListboxLabel>stdio</ListboxLabel>
                  </ListboxOption>
                  <ListboxOption value="http">
                    <ListboxLabel>http</ListboxLabel>
                  </ListboxOption>
                  <ListboxOption value="sse">
                    <ListboxLabel>sse</ListboxLabel>
                  </ListboxOption>
                </Listbox>
              </Field>
              <Field>
                <Label>Isolation Mode</Label>
                <Listbox
                  name="isolation-mode"
                  value={formData.isolation_mode}
                  onChange={(value: string) =>
                    setFormData({
                      ...formData,
                      isolation_mode: value as any,
                    })
                  }
                >
                  <ListboxOption value="shared">
                    <ListboxLabel>shared</ListboxLabel>
                  </ListboxOption>
                  <ListboxOption value="per_user">
                    <ListboxLabel>per_user</ListboxLabel>
                  </ListboxOption>
                </Listbox>
              </Field>
            </>
          )}

          {/* Step 1: Configuration */}
          {currentStep === 1 && (
            <>
              <Field>
                <Label>Configuration (JSON) *</Label>
                <Textarea
                  value={formData.config}
                  onChange={(e) => setFormData({ ...formData, config: e.target.value })}
                  rows={12}
                  className="font-mono text-sm"
                  placeholder='{ "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] }'
                />
              </Field>
              <CheckboxField>
                <Checkbox
                  name="requires_user_credentials"
                  checked={formData.requires_user_credentials}
                  onChange={(checked) =>
                    setFormData({ ...formData, requires_user_credentials: checked })
                  }
                />
                <Label className="cursor-pointer">
                  Requires User Credentials
                </Label>
              </CheckboxField>
              {formData.requires_user_credentials && (
                <Field>
                  <Label>Credential Schema (JSON)</Label>
                  <Textarea
                    value={formData.credential_schema}
                    onChange={(e) =>
                      setFormData({ ...formData, credential_schema: e.target.value })
                    }
                    rows={8}
                    className="font-mono text-sm"
                    placeholder='{ "api_key": { "type": "string", "description": "API Key" } }'
                  />
                </Field>
              )}
            </>
          )}

          {/* Step 2: Validate & Discover */}
          {currentStep === 2 && (
            <div className="space-y-4">
              {/* Action Buttons */}
              <div className="flex gap-2">
                <Button color="zinc" onClick={handleValidateStep} disabled={validateMcp.isPending}>
                  <ArrowPathIcon data-slot="icon" />
                  {validateMcp.isPending ? 'Validating...' : 'Validate Configuration'}
                </Button>
                <Button
                  color="zinc"
                  onClick={handleDiscoverStep}
                  disabled={discoverTools.isPending || !validationResult?.valid}
                  title={!validationResult?.valid ? 'Validate first before discovering tools' : undefined}
                >
                  <MagnifyingGlassIcon data-slot="icon" />
                  {discoverTools.isPending ? 'Discovering...' : 'Discover Tools'}
                </Button>
              </div>

              {/* Validation Result */}
              {validationResult && (
                <div
                  className={`flex items-center gap-2 p-4 rounded-lg ${
                    validationResult.valid ? 'bg-green-50 dark:bg-green-950/50' : 'bg-red-50 dark:bg-red-950/50'
                  }`}
                >
                  {validationResult.valid ? (
                    <CheckCircleIcon className="size-6 text-green-600 dark:text-green-400" />
                  ) : (
                    <ExclamationTriangleIcon className="size-6 text-red-600 dark:text-red-400" />
                  )}
                  <div>
                    <p className="font-semibold text-zinc-900 dark:text-white">
                      Validation {validationResult.valid ? 'Passed' : 'Failed'}
                    </p>
                    <p className="text-sm text-zinc-500 dark:text-zinc-400">
                      {validationResult.valid
                        ? 'Configuration is valid. You can now discover tools.'
                        : `${validationResult.errors?.length || 0} error(s) found`}
                    </p>
                  </div>
                </div>
              )}

              {/* Validation Errors */}
              {validationResult?.errors?.length > 0 && (
                <div>
                  <h4 className="font-medium text-red-600 dark:text-red-400 mb-2">Errors</h4>
                  <ul className="list-disc list-inside space-y-1">
                    {validationResult.errors.map((err: string, i: number) => (
                      <li key={i} className="text-sm text-red-600 dark:text-red-400">{err}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Validation Warnings */}
              {validationResult?.warnings?.length > 0 && (
                <div>
                  <h4 className="font-medium text-amber-600 dark:text-amber-400 mb-2">Warnings</h4>
                  <ul className="list-disc list-inside space-y-1">
                    {validationResult.warnings.map((warn: string, i: number) => (
                      <li key={i} className="text-sm text-amber-600 dark:text-amber-400">{warn}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Discovery Result */}
              {discoveryResult && (
                <div
                  className={`flex items-center gap-2 p-4 rounded-lg ${
                    discoveryResult.status === 'success'
                      ? 'bg-blue-50 dark:bg-blue-950/50'
                      : discoveryResult.status === 'skipped'
                      ? 'bg-amber-50 dark:bg-amber-950/50'
                      : 'bg-red-50 dark:bg-red-950/50'
                  }`}
                >
                  {discoveryResult.status === 'success' ? (
                    <MagnifyingGlassIcon className="size-6 text-blue-600 dark:text-blue-400" />
                  ) : (
                    <ExclamationTriangleIcon className="size-6 text-amber-600 dark:text-amber-400" />
                  )}
                  <div>
                    <p className="font-semibold text-zinc-900 dark:text-white">
                      {discoveryResult.status === 'success'
                        ? `Discovered ${discoveryResult.tool_count} tools`
                        : discoveryResult.status === 'skipped'
                        ? 'Discovery Skipped'
                        : 'Discovery Failed'}
                    </p>
                    {discoveryResult.message && (
                      <p className="text-sm text-zinc-500 dark:text-zinc-400">{discoveryResult.message}</p>
                    )}
                  </div>
                </div>
              )}

              {/* Discovered Tools List */}
              {discoveryResult?.tools_discovered?.length > 0 && (
                <div>
                  <h4 className="font-medium text-zinc-900 dark:text-white mb-2">
                    Discovered Tools ({discoveryResult.tools_discovered.length})
                  </h4>
                  <div className="grid gap-2 max-h-64 overflow-y-auto">
                    {discoveryResult.tools_discovered.map((tool: any, i: number) => (
                      <div key={i} className="rounded-lg bg-zinc-50 dark:bg-zinc-800 p-3">
                        <p className="font-mono text-sm font-medium text-zinc-900 dark:text-white">{tool.name}</p>
                        {tool.description && (
                          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">{tool.description}</p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Guidance text when nothing done yet */}
              {!validationResult && !discoveryResult && (
                <div className="text-center py-8">
                  <p className="text-zinc-500 dark:text-zinc-400">
                    Click "Validate Configuration" to check the MCP setup, then "Discover Tools" to connect and find available tools.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Step 3: Review */}
          {currentStep === 3 && (
            <div className="space-y-6">
              <dl className="grid grid-cols-2 gap-x-6 gap-y-4">
                <div>
                  <dt className="text-sm/6 text-zinc-500 dark:text-zinc-400">Name</dt>
                  <dd className="text-sm/6 font-medium text-zinc-900 dark:text-white">{formData.name}</dd>
                </div>
                <div>
                  <dt className="text-sm/6 text-zinc-500 dark:text-zinc-400">Display Name</dt>
                  <dd className="text-sm/6 font-medium text-zinc-900 dark:text-white">{formData.display_name}</dd>
                </div>
                <div>
                  <dt className="text-sm/6 text-zinc-500 dark:text-zinc-400">Transport</dt>
                  <dd className="text-sm/6 font-medium text-zinc-900 dark:text-white">{formData.transport_type}</dd>
                </div>
                <div>
                  <dt className="text-sm/6 text-zinc-500 dark:text-zinc-400">Isolation</dt>
                  <dd className="text-sm/6 font-medium text-zinc-900 dark:text-white">{formData.isolation_mode}</dd>
                </div>
                <div>
                  <dt className="text-sm/6 text-zinc-500 dark:text-zinc-400">Validation Status</dt>
                  <dd>
                    <Badge
                      color={validationResult?.valid ? 'green' : 'red'}
                    >
                      {validationResult?.valid ? 'Valid' : 'Invalid'}
                    </Badge>
                  </dd>
                </div>
                <div>
                  <dt className="text-sm/6 text-zinc-500 dark:text-zinc-400">Tools Discovered</dt>
                  <dd className="text-sm/6 font-medium text-zinc-900 dark:text-white">
                    {discoveryResult?.tool_count ?? 0}
                  </dd>
                </div>
              </dl>

              <Divider />

              <div>
                <p className="text-sm/6 text-zinc-500 dark:text-zinc-400 mb-4">
                  You can now publish this MCP to make it available to users, or save it as a
                  draft for later.
                </p>
                <div className="flex gap-2">
                  {validationResult?.valid && (
                    <Button onClick={handlePublish} disabled={publishMcp.isPending}>
                      <CheckCircleIcon data-slot="icon" />
                      {publishMcp.isPending ? 'Publishing...' : 'Publish MCP'}
                    </Button>
                  )}
                  <Button color="zinc" onClick={handleSaveDraft}>
                    Save as Draft
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Navigation Buttons */}
      {currentStep < 3 && (
        <div className="flex justify-between">
          <Button
            color="zinc"
            onClick={handleBack}
            disabled={currentStep === 0}
          >
            <ArrowLeftIcon data-slot="icon" />
            Back
          </Button>
          <Button
            onClick={handleNext}
            disabled={
              (currentStep === 1 && createMcp.isPending) ||
              (currentStep === 2 && validateMcp.isPending)
            }
          >
            {(currentStep === 1 && createMcp.isPending) ||
            (currentStep === 2 && validateMcp.isPending)
              ? 'Loading...'
              : 'Next'}
            <ArrowRightIcon data-slot="icon" />
          </Button>
        </div>
      )}
    </div>
  );
}
