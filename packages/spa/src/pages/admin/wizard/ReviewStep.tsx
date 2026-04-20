import { CheckCircleIcon } from '@heroicons/react/20/solid';
import { Badge } from '@/components/catalyst/badge';
import { Button } from '@/components/catalyst/button';
import { Divider } from '@/components/catalyst/divider';
import type { ValidationResult, DiscoveryResult } from '@/api/types';

interface ReviewStepProps {
  formData: {
    name: string;
    display_name: string;
    transport_type: string;
    isolation_mode: string;
    auth_type: 'none' | 'static' | 'oauth2';
    oauth_client_id_env: string;
  };
  validationResult: ValidationResult | null;
  discoveryResult: DiscoveryResult | null;
  isPublishing: boolean;
  onPublish: () => void;
  onSaveDraft: () => void;
}

export function ReviewStep({
  formData,
  validationResult,
  discoveryResult,
  isPublishing,
  onPublish,
  onSaveDraft,
}: ReviewStepProps) {
  return (
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
          <dt className="text-sm/6 text-zinc-500 dark:text-zinc-400">Authentication Type</dt>
          <dd className="text-sm/6 font-medium text-zinc-900 dark:text-white">
            {formData.auth_type === 'none'
              ? 'None'
              : formData.auth_type === 'static'
              ? 'Static Credentials'
              : 'OAuth 2.0'}
          </dd>
        </div>
        {formData.auth_type === 'oauth2' && (
          <div>
            <dt className="text-sm/6 text-zinc-500 dark:text-zinc-400">OAuth Client ID Env</dt>
            <dd className="text-sm/6 font-medium text-zinc-900 dark:text-white font-mono">
              {formData.oauth_client_id_env}
            </dd>
          </div>
        )}
        <div>
          <dt className="text-sm/6 text-zinc-500 dark:text-zinc-400">Validation Status</dt>
          <dd>
            <Badge color={validationResult?.valid ? 'green' : 'red'}>
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
          You can now publish this MCP to make it available to users, or save it as a draft for later.
        </p>
        <div className="flex gap-2">
          {validationResult?.valid && (
            <Button onClick={onPublish} disabled={isPublishing}>
              <CheckCircleIcon data-slot="icon" />
              {isPublishing ? 'Publishing...' : 'Publish MCP'}
            </Button>
          )}
          <Button color="zinc" onClick={onSaveDraft}>
            Save as Draft
          </Button>
        </div>
      </div>
    </div>
  );
}
