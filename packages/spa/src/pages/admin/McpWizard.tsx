import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle, AlertTriangle, ArrowLeft, ArrowRight } from 'lucide-react';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/catalyst/button';
import { Badge } from '@/components/catalyst/badge';
import { Input } from '@/components/catalyst/input';
import { Label } from '@/components/catalyst/fieldset';
import { Textarea } from '@/components/catalyst/textarea';
import { Checkbox, CheckboxField } from '@/components/catalyst/checkbox';
import { useCreateMcp, useValidateMcp, usePublishMcp } from '@/api/hooks/use-admin';
import { usePageTitle } from '@/hooks/usePageTitle';

const STEPS = ['Basic Info', 'Configuration', 'Validate', 'Review'];

export function McpWizard() {
  usePageTitle('Admin - Create MCP');
  const navigate = useNavigate();
  const createMcp = useCreateMcp();
  const validateMcp = useValidateMcp();
  const publishMcp = usePublishMcp();
  const { addToast } = useToast();

  const [currentStep, setCurrentStep] = useState(0);
  const [createdMcpId, setCreatedMcpId] = useState<string | null>(null);
  const [validationResult, setValidationResult] = useState<any>(null);

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
        addToast({ title: 'Validation', description: 'Name and Display Name are required', variant: 'red' });
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
          addToast({ title: 'Invalid JSON', description: 'Invalid JSON in config field', variant: 'red' });
          return;
        }

        let credentialSchemaObj: Record<string, unknown> | undefined;
        if (formData.requires_user_credentials) {
          try {
            credentialSchemaObj = JSON.parse(formData.credential_schema);
          } catch {
            addToast({ title: 'Invalid JSON', description: 'Invalid JSON in credential schema field', variant: 'red' });
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
        addToast({ title: 'Create MCP failed', description: (error as Error)?.message ?? String(error), variant: 'red' });
        return;
      }
    }

    if (currentStep === 2) {
      // Validate the MCP
      if (!createdMcpId) return;
      try {
        const result = await validateMcp.mutateAsync(createdMcpId);
        setValidationResult(result);
      } catch (error) {
        addToast({ title: 'Validate MCP failed', description: (error as Error)?.message ?? String(error), variant: 'red' });
        return;
      }
    }

    setCurrentStep((prev) => Math.min(prev + 1, STEPS.length - 1));
  };

  const handleBack = () => {
    setCurrentStep((prev) => Math.max(prev - 1, 0));
  };

  const handlePublish = async () => {
    if (!createdMcpId) return;
    try {
      await publishMcp.mutateAsync(createdMcpId);
      navigate(`/app/admin/mcps/${createdMcpId}`);
    } catch (error) {
      addToast({ title: 'Publish MCP failed', description: (error as Error)?.message ?? String(error), variant: 'red' });
    }
  };

  const handleSaveDraft = () => {
    if (createdMcpId) {
      navigate(`/app/admin/mcps/${createdMcpId}`);
    }
  };

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div className="pb-4 border-b border-border mb-6">
        <h1 className="text-xl font-semibold">Create New MCP</h1>
        <p className="text-sm text-muted-foreground">Multi-step wizard for MCP catalog entry</p>
      </div>

      {/* Step Indicator */}
      <div className="flex items-center justify-between">
        {STEPS.map((step, index) => (
          <div key={step} className="flex items-center">
            <div
              className={`flex items-center justify-center w-10 h-10 rounded-full border-2 ${
                index <= currentStep
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-muted bg-background'
              }`}
            >
              {index < currentStep ? <CheckCircle className="h-5 w-5" /> : index + 1}
            </div>
            <div className="ml-2 text-sm">
              <p className={index <= currentStep ? 'font-medium' : 'text-muted-foreground'}>
                {step}
              </p>
            </div>
            {index < STEPS.length - 1 && (
              <div
                className={`h-0.5 w-16 mx-4 ${
                  index < currentStep ? 'bg-primary' : 'bg-muted'
                }`}
              />
            )}
          </div>
        ))}
      </div>

      {/* Step Content */}
      <Card>
        <CardHeader>
          <CardTitle>{STEPS[currentStep]}</CardTitle>
          <CardDescription>
            {currentStep === 0 && 'Enter basic MCP information'}
            {currentStep === 1 && 'Configure MCP runtime settings'}
            {currentStep === 2 && 'Validate MCP configuration'}
            {currentStep === 3 && 'Review and publish'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Step 0: Basic Info */}
          {currentStep === 0 && (
            <>
              <div className="space-y-2">
                <Label htmlFor="name">Internal Name * (e.g., github, slack)</Label>
                <Input
                  id="name"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder="github"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="display_name">Display Name *</Label>
                <Input
                  id="display_name"
                  value={formData.display_name}
                  onChange={(e) => setFormData({ ...formData, display_name: e.target.value })}
                  placeholder="GitHub"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="description">Description</Label>
                <Textarea
                  id="description"
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  rows={3}
                  placeholder="Interact with GitHub repositories and issues"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="icon_url">Icon URL</Label>
                <Input
                  id="icon_url"
                  value={formData.icon_url}
                  onChange={(e) => setFormData({ ...formData, icon_url: e.target.value })}
                  placeholder="https://..."
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="transport_type">Transport Type</Label>
                <select
                  id="transport_type"
                  value={formData.transport_type}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      transport_type: e.target.value as any,
                    })
                  }
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value="stdio">stdio</option>
                  <option value="http">http</option>
                  <option value="sse">sse</option>
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="isolation_mode">Isolation Mode</Label>
                <select
                  id="isolation_mode"
                  value={formData.isolation_mode}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      isolation_mode: e.target.value as any,
                    })
                  }
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value="shared">shared</option>
                  <option value="per_user">per_user</option>
                </select>
              </div>
            </>
          )}

          {/* Step 1: Configuration */}
          {currentStep === 1 && (
            <>
              <div className="space-y-2">
                <Label htmlFor="config">Configuration (JSON) *</Label>
                <Textarea
                  id="config"
                  value={formData.config}
                  onChange={(e) => setFormData({ ...formData, config: e.target.value })}
                  rows={12}
                  className="font-mono text-sm"
                  placeholder='{ "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] }'
                />
              </div>
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
                <div className="space-y-2">
                  <Label htmlFor="credential_schema">Credential Schema (JSON)</Label>
                  <Textarea
                    id="credential_schema"
                    value={formData.credential_schema}
                    onChange={(e) =>
                      setFormData({ ...formData, credential_schema: e.target.value })
                    }
                    rows={8}
                    className="font-mono text-sm"
                    placeholder='{ "api_key": { "type": "string", "description": "API Key" } }'
                  />
                </div>
              )}
            </>
          )}

          {/* Step 2: Validate */}
          {currentStep === 2 && (
            <div className="space-y-4">
              {!validationResult ? (
                <div className="text-center py-8">
                  <p className="text-muted-foreground">
                    Click "Next" to validate the MCP configuration
                  </p>
                </div>
              ) : (
                <>
                  <div
                    className={`flex items-center gap-2 p-4 rounded-lg ${
                      validationResult.valid ? 'bg-green-50 dark:bg-green-950' : 'bg-red-50 dark:bg-red-950'
                    }`}
                  >
                    {validationResult.valid ? (
                      <CheckCircle className="h-6 w-6 text-green-600" />
                    ) : (
                      <AlertTriangle className="h-6 w-6 text-destructive" />
                    )}
                    <div>
                      <p className="font-semibold">
                        Validation {validationResult.valid ? 'Passed' : 'Failed'}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {validationResult.valid
                          ? `Discovered ${validationResult.tools_discovered.length} tools`
                          : `${validationResult.errors.length} error(s) found`}
                      </p>
                    </div>
                  </div>

                  {validationResult.errors.length > 0 && (
                    <div>
                      <h4 className="font-medium text-destructive mb-2">Errors</h4>
                      <ul className="list-disc list-inside space-y-1">
                        {validationResult.errors.map((err: string, i: number) => (
                          <li key={i} className="text-sm text-destructive">
                            {err}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {validationResult.warnings.length > 0 && (
                    <div>
                      <h4 className="font-medium text-yellow-600 mb-2">Warnings</h4>
                      <ul className="list-disc list-inside space-y-1">
                        {validationResult.warnings.map((warn: string, i: number) => (
                          <li key={i} className="text-sm text-yellow-600">
                            {warn}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {validationResult.tools_discovered.length > 0 && (
                    <div>
                      <h4 className="font-medium mb-2">
                        Discovered Tools ({validationResult.tools_discovered.length})
                      </h4>
                      <div className="grid gap-2">
                        {validationResult.tools_discovered.map((tool: any, i: number) => (
                          <div key={i} className="border rounded p-2">
                            <p className="font-mono text-sm font-medium">{tool.name}</p>
                            <p className="text-xs text-muted-foreground">{tool.description}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* Step 3: Review */}
          {currentStep === 3 && (
            <div className="space-y-4">
              <div>
                <h4 className="font-medium mb-2">Summary</h4>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <p className="text-muted-foreground">Name</p>
                    <p className="font-medium">{formData.name}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Display Name</p>
                    <p className="font-medium">{formData.display_name}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Transport</p>
                    <p className="font-medium">{formData.transport_type}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Isolation</p>
                    <p className="font-medium">{formData.isolation_mode}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Validation Status</p>
                    <Badge
                      color={validationResult?.valid ? 'emerald' : 'red'}
                    >
                      {validationResult?.valid ? 'Valid' : 'Invalid'}
                    </Badge>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Tools Discovered</p>
                    <p className="font-medium">
                      {validationResult?.tools_discovered.length || 0}
                    </p>
                  </div>
                </div>
              </div>

              <div className="border-t pt-4">
                <p className="text-sm text-muted-foreground mb-4">
                  You can now publish this MCP to make it available to users, or save it as a
                  draft for later.
                </p>
                <div className="flex gap-2">
                  {validationResult?.valid && (
                    <Button className="h-8" onClick={handlePublish} disabled={publishMcp.isPending}>
                      <CheckCircle className="mr-2 h-4 w-4" />
                      {publishMcp.isPending ? 'Publishing...' : 'Publish MCP'}
                    </Button>
                  )}
                  <Button color="zinc" className="h-8" onClick={handleSaveDraft}>
                    Save as Draft
                  </Button>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Navigation Buttons */}
      {currentStep < 3 && (
        <div className="flex justify-between">
          <Button
            color="zinc"
            className="h-8"
            onClick={handleBack}
            disabled={currentStep === 0}
          >
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back
          </Button>
          <Button
            className="h-8"
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
            <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
