import type { RegistryMcp } from '@/api/types';

export interface MappedRegistryFormData {
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
}

/**
 * Maps a community registry entry onto the McpWizard form data shape.
 *
 * Mapping rules:
 *  - stdio entries: config built from config.command[0] + config.command.slice(1) as args
 *  - http/sse entries: config built from config.url
 *  - credential_schema serialised to JSON string for the textarea
 *  - oauth_config fields spread into individual form fields
 *  - Fields not present in the registry schema (e.g. access_token_env_var) are
 *    carried over from the previous form state via the `prev` parameter.
 */
export function mapRegistryEntryToFormData(
  entry: RegistryMcp,
  prev: Pick<MappedRegistryFormData, 'oauth_access_token_env_var'>
): MappedRegistryFormData {
  // Build the config JSON that matches the wizard's textarea format
  let configObj: Record<string, unknown> = {};

  if (entry.transport_type === 'stdio' && entry.config.command && entry.config.command.length > 0) {
    const [cmd, ...args] = entry.config.command;
    configObj = {
      command: cmd,
      args,
      ...(entry.config.env && Object.keys(entry.config.env).length > 0
        ? { env: entry.config.env }
        : {}),
    };
  } else if (entry.transport_type === 'http' || entry.transport_type === 'stdio') {
    if (entry.config.url) {
      configObj = { url: entry.config.url };
    }
  }

  // Credential schema → JSON string
  const credentialSchemaStr =
    entry.credential_schema && Object.keys(entry.credential_schema).length > 0
      ? JSON.stringify(entry.credential_schema, null, 2)
      : '{\n  \n}';

  // OAuth config fields
  const oauthRaw = entry.oauth_config;
  const oauthAuthUrl = oauthRaw?.auth_url ?? '';
  const oauthTokenUrl = oauthRaw?.token_url ?? '';
  const oauthScopes = oauthRaw?.scopes ?? '';
  const oauthClientIdEnv = oauthRaw?.client_id_env ?? '';
  const oauthClientSecretEnv = oauthRaw?.client_secret_env ?? '';

  return {
    name: entry.name,
    display_name: entry.display_name,
    description: entry.description ?? '',
    icon_url: entry.icon_url ?? '',
    transport_type: entry.transport_type === 'stdio' ? 'stdio' : 'http',
    isolation_mode: entry.isolation_mode,
    config: JSON.stringify(configObj, null, 2),
    auth_type: entry.auth_type,
    requires_user_credentials: entry.requires_user_credentials,
    credential_schema: credentialSchemaStr,
    oauth_auth_url: oauthAuthUrl,
    oauth_token_url: oauthTokenUrl,
    oauth_scopes: oauthScopes,
    oauth_client_id_env: oauthClientIdEnv,
    oauth_client_secret_env: oauthClientSecretEnv,
    // access_token_env_var is not in registry schema — leave unchanged
    oauth_access_token_env_var: prev.oauth_access_token_env_var,
    oauth_revocation_url: '',
    oauth_extra_params: '',
  };
}
