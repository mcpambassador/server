import { Checkbox, CheckboxField } from '@/components/catalyst/checkbox';
import { Input } from '@/components/catalyst/input';
import { Field, Label } from '@/components/catalyst/fieldset';
import { Textarea } from '@/components/catalyst/textarea';
import { Listbox, ListboxOption, ListboxLabel } from '@/components/catalyst/listbox';

interface ConfigurationStepProps {
  formData: {
    config: string;
    auth_type: 'none' | 'static' | 'oauth2';
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
  errors: Record<string, string>;
  onChange: (patch: Partial<ConfigurationStepProps['formData']>) => void;
}

export function ConfigurationStep({ formData, errors, onChange }: ConfigurationStepProps) {
  return (
    <>
      <Field>
        <Label>Configuration (JSON) *</Label>
        <Textarea
          value={formData.config}
          onChange={(e) => onChange({ config: e.target.value })}
          rows={12}
          className="font-mono text-sm"
          placeholder='{ "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] }'
          aria-invalid={!!errors.config}
          aria-describedby={errors.config ? 'config-error' : undefined}
        />
        {errors.config && (
          <p id="config-error" className="text-xs text-red-600 dark:text-red-400 mt-1">
            {errors.config}
          </p>
        )}
      </Field>

      <Field>
        <Label>Authentication Type</Label>
        <Listbox
          name="auth-type"
          value={formData.auth_type}
          onChange={(value: string) =>
            onChange({ auth_type: value as 'none' | 'static' | 'oauth2' })
          }
        >
          <ListboxOption value="none">
            <ListboxLabel>None (no authentication)</ListboxLabel>
          </ListboxOption>
          <ListboxOption value="static">
            <ListboxLabel>Static Credentials (user provides API keys)</ListboxLabel>
          </ListboxOption>
          <ListboxOption value="oauth2">
            <ListboxLabel>OAuth 2.0 (server-managed OAuth flow)</ListboxLabel>
          </ListboxOption>
        </Listbox>
      </Field>

      {formData.auth_type === 'static' && (
        <>
          <CheckboxField>
            <Checkbox name="requires_user_credentials" checked={true} disabled={true} />
            <Label className="cursor-pointer">
              Requires User Credentials (enabled for static auth)
            </Label>
          </CheckboxField>
          <Field>
            <Label>Credential Schema (JSON)</Label>
            <Textarea
              value={formData.credential_schema}
              onChange={(e) => onChange({ credential_schema: e.target.value })}
              rows={8}
              className="font-mono text-sm"
              placeholder='{ "type": "object", "required": ["api_key"], "properties": { "api_key": { "type": "string", "description": "API Key" } } }'
              aria-invalid={!!errors.credential_schema}
              aria-describedby={errors.credential_schema ? 'credential-schema-error' : undefined}
            />
            {errors.credential_schema && (
              <p id="credential-schema-error" className="text-xs text-red-600 dark:text-red-400 mt-1">
                {errors.credential_schema}
              </p>
            )}
          </Field>
        </>
      )}

      {formData.auth_type === 'oauth2' && (
        <>
          <Field>
            <Label>Authorization URL *</Label>
            <Input
              value={formData.oauth_auth_url}
              onChange={(e) => onChange({ oauth_auth_url: e.target.value })}
              placeholder="https://accounts.google.com/o/oauth2/v2/auth"
              aria-invalid={!!errors.oauth_auth_url}
              aria-describedby={errors.oauth_auth_url ? 'oauth-auth-url-error' : undefined}
            />
            {errors.oauth_auth_url && (
              <p id="oauth-auth-url-error" className="text-xs text-red-600 dark:text-red-400 mt-1">
                {errors.oauth_auth_url}
              </p>
            )}
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
              OAuth 2.0 authorization endpoint URL
            </p>
          </Field>

          <Field>
            <Label>Token URL *</Label>
            <Input
              value={formData.oauth_token_url}
              onChange={(e) => onChange({ oauth_token_url: e.target.value })}
              placeholder="https://oauth2.googleapis.com/token"
              aria-invalid={!!errors.oauth_token_url}
              aria-describedby={errors.oauth_token_url ? 'oauth-token-url-error' : undefined}
            />
            {errors.oauth_token_url && (
              <p id="oauth-token-url-error" className="text-xs text-red-600 dark:text-red-400 mt-1">
                {errors.oauth_token_url}
              </p>
            )}
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
              OAuth 2.0 token endpoint URL
            </p>
          </Field>

          <Field>
            <Label>Scopes *</Label>
            <Input
              value={formData.oauth_scopes}
              onChange={(e) => onChange({ oauth_scopes: e.target.value })}
              placeholder="openid email profile"
              aria-invalid={!!errors.oauth_scopes}
              aria-describedby={errors.oauth_scopes ? 'oauth-scopes-error' : undefined}
            />
            {errors.oauth_scopes && (
              <p id="oauth-scopes-error" className="text-xs text-red-600 dark:text-red-400 mt-1">
                {errors.oauth_scopes}
              </p>
            )}
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
              Space-separated OAuth scopes
            </p>
          </Field>

          <Field>
            <Label>Client ID Environment Variable *</Label>
            <Input
              value={formData.oauth_client_id_env}
              onChange={(e) => onChange({ oauth_client_id_env: e.target.value })}
              placeholder="GOOGLE_OAUTH_CLIENT_ID"
              aria-invalid={!!errors.oauth_client_id_env}
              aria-describedby={errors.oauth_client_id_env ? 'oauth-client-id-error' : undefined}
            />
            {errors.oauth_client_id_env && (
              <p id="oauth-client-id-error" className="text-xs text-red-600 dark:text-red-400 mt-1">
                {errors.oauth_client_id_env}
              </p>
            )}
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
              Name of the environment variable on the server containing the OAuth client ID (not the actual client ID)
            </p>
          </Field>

          <Field>
            <Label>Client Secret Environment Variable *</Label>
            <Input
              value={formData.oauth_client_secret_env}
              onChange={(e) => onChange({ oauth_client_secret_env: e.target.value })}
              placeholder="GOOGLE_OAUTH_CLIENT_SECRET"
              aria-invalid={!!errors.oauth_client_secret_env}
              aria-describedby={errors.oauth_client_secret_env ? 'oauth-client-secret-error' : undefined}
            />
            {errors.oauth_client_secret_env && (
              <p id="oauth-client-secret-error" className="text-xs text-red-600 dark:text-red-400 mt-1">
                {errors.oauth_client_secret_env}
              </p>
            )}
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
              Name of the environment variable on the server containing the OAuth client secret
            </p>
          </Field>

          <Field>
            <Label>Access Token Environment Variable *</Label>
            <Input
              value={formData.oauth_access_token_env_var}
              onChange={(e) => onChange({ oauth_access_token_env_var: e.target.value })}
              placeholder="GOOGLE_ACCESS_TOKEN"
              aria-invalid={!!errors.oauth_access_token_env_var}
              aria-describedby={errors.oauth_access_token_env_var ? 'oauth-access-token-error' : undefined}
            />
            {errors.oauth_access_token_env_var && (
              <p id="oauth-access-token-error" className="text-xs text-red-600 dark:text-red-400 mt-1">
                {errors.oauth_access_token_env_var}
              </p>
            )}
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
              Name of the environment variable that the MCP expects for the access token
            </p>
          </Field>

          <Field>
            <Label>Revocation URL (optional)</Label>
            <Input
              value={formData.oauth_revocation_url}
              onChange={(e) => onChange({ oauth_revocation_url: e.target.value })}
              placeholder="https://oauth2.googleapis.com/revoke"
            />
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
              OAuth 2.0 token revocation endpoint (optional)
            </p>
          </Field>

          <Field>
            <Label>Extra Parameters (optional JSON)</Label>
            <Textarea
              value={formData.oauth_extra_params}
              onChange={(e) => onChange({ oauth_extra_params: e.target.value })}
              rows={4}
              className="font-mono text-sm"
              placeholder='{"access_type": "offline", "prompt": "consent"}'
              aria-invalid={!!errors.oauth_extra_params}
              aria-describedby={errors.oauth_extra_params ? 'oauth-extra-params-error' : undefined}
            />
            {errors.oauth_extra_params && (
              <p id="oauth-extra-params-error" className="text-xs text-red-600 dark:text-red-400 mt-1">
                {errors.oauth_extra_params}
              </p>
            )}
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
              Additional OAuth parameters as JSON object
            </p>
          </Field>
        </>
      )}
    </>
  );
}
