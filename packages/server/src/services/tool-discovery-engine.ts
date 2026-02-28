/**
 * MCP Tool Discovery Engine
 *
 * Performs ephemeral connect → initialize → tools/list → disconnect cycles
 * against MCP servers for admin tool discovery.
 *
 * Reuses existing StdioMcpConnection / HttpMcpConnection from downstream/
 * but wraps them in a one-shot lifecycle for discovery purposes.
 *
 * @see ADR-P3-07: MCP Tool Discovery Engine
 * @see Architecture §7.3: Downstream MCP Management
 */

import type { McpCatalogEntry, OAuthConfig } from '@mcpambassador/core';
import { StdioMcpConnection } from '../downstream/stdio-connection.js';
import { HttpMcpConnection } from '../downstream/http-connection.js';
import type { DownstreamMcpConfig, ToolDescriptor } from '../downstream/types.js';
import { validateToolName, BLOCKED_ENV_VARS } from '../downstream/types.js';

/**
 * Error codes for tool discovery failures
 */
export type DiscoveryErrorCode =
  | 'credential_required' // MCP requires user credentials, can't discover as admin
  | 'validation_required' // Static validation must pass first
  | 'connection_timeout' // Failed to connect within timeout
  | 'process_crashed' // stdio process exited unexpectedly
  | 'unreachable' // HTTP endpoint unreachable (DNS, ECONNREFUSED)
  | 'tls_error' // TLS certificate validation failed
  | 'discovery_failed' // tools/list returned an error
  | 'invalid_response' // tools/list returned unparseable data
  | 'unknown_transport' // Unrecognized transport_type
  | 'internal_error'; // Unexpected server-side error

/**
 * Result of a tool discovery attempt
 */
export interface DiscoveryResult {
  /** Outcome of the discovery attempt */
  status: 'success' | 'skipped' | 'error';

  /** Discovered tools (empty array if status != 'success') */
  tools_discovered: Array<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  }>;

  /** Number of tools discovered */
  tool_count: number;

  /** Error code if status = 'error' or 'skipped' */
  error_code?: DiscoveryErrorCode;

  /** Human-readable error/skip message */
  message?: string;

  /** ISO 8601 timestamp of discovery attempt */
  discovered_at: string;

  /** Time taken for discovery in milliseconds */
  duration_ms: number;

  /** Server capabilities reported during initialize (if available) */
  server_info?: {
    name?: string;
    version?: string;
    protocolVersion?: string;
  };

  /** Warnings encountered during discovery (e.g., invalid tool names, tool count capped) */
  warnings?: string[];
}

/**
 * Configuration constants for the discovery engine
 */
export const DEFAULT_DISCOVERY_TIMEOUT = 45_000; // 45 seconds overall
export const MAX_TOOLS = 500;

/**
 * Tool Discovery Engine
 *
 * Performs ephemeral connect → initialize → tools/list → disconnect cycles
 * against MCP servers for admin tool discovery.
 *
 * All errors are caught and returned as DiscoveryResult with status='error'.
 * This function never throws.
 *
 * @param entry - MCP catalog entry
 * @param adminCredentials - Optional admin-provided credentials for credential-gated MCPs.
 *                           Keys are field names from credential_schema, values are the credential values.
 * @param adminUserId - Optional admin user ID for OAuth-based discovery (loads admin's stored OAuth token)
 */
export async function discoverTools(
  entry: McpCatalogEntry,
  adminCredentials?: Record<string, string>,
  adminUserId?: string
): Promise<DiscoveryResult> {
  const startTime = Date.now();
  const warnings: string[] = [];

  try {
    // Precondition 1: Check if MCP requires user credentials
    let credentialEnvVars: Record<string, string> | undefined;
    let credentialHeaders: Record<string, string> | undefined;

    if (entry.requires_user_credentials) {
      // Branch 1: OAuth MCP with admin user ID (use admin's stored OAuth credential)
      if (entry.auth_type === 'oauth2' && adminUserId) {
        // Load admin's OAuth credential from database
        const { getDb } = await import('../server.js');
        const { getCredential } = await import('@mcpambassador/core');
        const db = getDb();

        if (!db) {
          return {
            status: 'error',
            tools_discovered: [],
            tool_count: 0,
            error_code: 'internal_error',
            message: 'Database not initialized',
            discovered_at: new Date().toISOString(),
            duration_ms: Date.now() - startTime,
            warnings,
          };
        }

        const credential = await getCredential(db, adminUserId, entry.mcp_id);

        if (!credential || credential.credential_type !== 'oauth2') {
          return {
            status: 'skipped',
            tools_discovered: [],
            tool_count: 0,
            error_code: 'credential_required',
            message:
              'Admin must connect their OAuth credential first. Go to User Portal to authorize this MCP.',
            discovered_at: new Date().toISOString(),
            duration_ms: Date.now() - startTime,
            warnings,
          };
        }

        // Check OAuth status
        if (credential.oauth_status === 'revoked') {
          return {
            status: 'skipped',
            tools_discovered: [],
            tool_count: 0,
            error_code: 'credential_required',
            message: 'OAuth credential has been revoked. Please reconnect in User Portal.',
            discovered_at: new Date().toISOString(),
            duration_ms: Date.now() - startTime,
            warnings,
          };
        }

        // Decrypt the OAuth credential
        const { getCredentialVault } = await import('../server.js');
        const vault = getCredentialVault();

        if (!vault) {
          return {
            status: 'error',
            tools_discovered: [],
            tool_count: 0,
            error_code: 'internal_error',
            message: 'Credential vault not initialized',
            discovered_at: new Date().toISOString(),
            duration_ms: Date.now() - startTime,
            warnings,
          };
        }

        // Get user's vault_salt
        const user = await db.query.users.findFirst({
          where: (users, { eq }) => eq(users.user_id, adminUserId),
        });

        if (!user?.vault_salt) {
          return {
            status: 'error',
            tools_discovered: [],
            tool_count: 0,
            error_code: 'internal_error',
            message: 'Admin user vault_salt not found',
            discovered_at: new Date().toISOString(),
            duration_ms: Date.now() - startTime,
            warnings,
          };
        }

        // Decrypt credential blob
        let decryptedJson: string;
        try {
          decryptedJson = vault.decrypt(
            user.vault_salt,
            credential.encrypted_credentials,
            credential.encryption_iv
          );
        } catch (err) {
          console.error(
            `[DiscoveryEngine] Failed to decrypt admin credential for MCP ${entry.name}:`,
            err
          );
          return {
            status: 'error',
            tools_discovered: [],
            tool_count: 0,
            error_code: 'internal_error',
            message:
              'Failed to decrypt admin credential. The credential may need to be reconnected.',
            discovered_at: new Date().toISOString(),
            duration_ms: Date.now() - startTime,
            warnings,
          };
        }

        type OAuthCredentialBlob = {
          access_token: string;
          refresh_token: string;
          token_type: string;
          scope?: string;
          expires_at: string;
        };

        const oauthBlob = JSON.parse(decryptedJson) as OAuthCredentialBlob;

        // Check if token is expired or near expiry (5-minute buffer)
        const expiresAt = new Date(oauthBlob.expires_at);
        const now = new Date();
        const fiveMinutesFromNow = new Date(now.getTime() + 5 * 60 * 1000);

        let accessToken = oauthBlob.access_token;

        if (expiresAt <= fiveMinutesFromNow) {
          // Token expired or near expiry — refresh it
          console.log(
            `[DiscoveryEngine] OAuth token for MCP ${entry.name} expired or near expiry, refreshing...`
          );

          try {
            // Parse oauth_config
            const oauthConfig =
              typeof entry.oauth_config === 'string'
                ? (JSON.parse(entry.oauth_config) as OAuthConfig)
                : (entry.oauth_config as OAuthConfig);

            const { getOAuthTokenManager } = await import('../server.js');
            const tokenManager = getOAuthTokenManager();

            if (!tokenManager) {
              throw new Error('OAuth token manager not initialized');
            }

            // Refresh the access token
            const tokenSet = await tokenManager.refreshAccessToken(
              oauthConfig,
              oauthBlob.refresh_token
            );

            // Update the blob with new tokens
            const expiresIn = tokenSet.expires_in || 31536000; // Default 1 year
            const updatedBlob: OAuthCredentialBlob = {
              access_token: tokenSet.access_token,
              refresh_token: tokenSet.refresh_token || oauthBlob.refresh_token,
              token_type: tokenSet.token_type,
              scope: tokenSet.scope || oauthBlob.scope,
              expires_at: new Date(now.getTime() + expiresIn * 1000).toISOString(),
            };

            // Re-encrypt and update in database
            const { encryptedCredentials, iv } = vault.encrypt(
              user.vault_salt,
              JSON.stringify(updatedBlob)
            );

            const { compatUpdate, user_mcp_credentials } = await import('@mcpambassador/core');
            const { eq } = await import('drizzle-orm');

            await compatUpdate(db, user_mcp_credentials)
              .set({
                encrypted_credentials: encryptedCredentials,
                encryption_iv: iv,
                oauth_status: 'active',
                expires_at: updatedBlob.expires_at,
                updated_at: now.toISOString(),
              })
              .where(eq(user_mcp_credentials.credential_id, credential.credential_id));

            accessToken = updatedBlob.access_token;
            console.log(
              `[DiscoveryEngine] Successfully refreshed OAuth token for MCP ${entry.name}`
            );
          } catch (refreshErr) {
            console.error(
              `[DiscoveryEngine] Failed to refresh OAuth token for MCP ${entry.name}:`,
              refreshErr
            );

            // Check if token was revoked (401/invalid_grant)
            const errorMessage =
              refreshErr instanceof Error ? refreshErr.message : String(refreshErr);
            const isRevoked =
              errorMessage.includes('401') || errorMessage.includes('invalid_grant');

            if (isRevoked) {
              // Mark as revoked in database
              try {
                const { compatUpdate, user_mcp_credentials } = await import('@mcpambassador/core');
                const { eq } = await import('drizzle-orm');

                await compatUpdate(db, user_mcp_credentials)
                  .set({ oauth_status: 'revoked', updated_at: now.toISOString() })
                  .where(eq(user_mcp_credentials.credential_id, credential.credential_id));

                console.warn(`[DiscoveryEngine] OAuth token revoked for MCP ${entry.name}`);
              } catch (updateErr) {
                console.error(`[DiscoveryEngine] Failed to mark credential as revoked:`, updateErr);
              }

              return {
                status: 'skipped',
                tools_discovered: [],
                tool_count: 0,
                error_code: 'credential_required',
                message: 'OAuth credential has been revoked. Please reconnect in User Portal.',
                discovered_at: new Date().toISOString(),
                duration_ms: Date.now() - startTime,
                warnings,
              };
            }

            // For other refresh errors
            return {
              status: 'error',
              tools_discovered: [],
              tool_count: 0,
              error_code: 'internal_error',
              message: 'OAuth token refresh failed. Please reconnect your credential.',
              discovered_at: new Date().toISOString(),
              duration_ms: Date.now() - startTime,
              warnings,
            };
          }
        }

        // Inject OAuth token into transport config
        const oauthConfigInject =
          typeof entry.oauth_config === 'string'
            ? (JSON.parse(entry.oauth_config) as OAuthConfig)
            : (entry.oauth_config as OAuthConfig);

        // For stdio: inject token as env var
        if (oauthConfigInject.access_token_env_var) {
          credentialEnvVars = {
            [oauthConfigInject.access_token_env_var]: accessToken,
          };
        }

        // For HTTP/SSE: inject Authorization header
        credentialHeaders = {
          Authorization: `Bearer ${accessToken}`,
        };

        console.log(`[DiscoveryEngine] Using admin's OAuth credential for MCP ${entry.name}`);

        // Branch 2: Static credentials provided by admin for testing
      } else if (adminCredentials && Object.keys(adminCredentials).length > 0) {
        credentialEnvVars = {};

        // Parse credential_schema to get env var mappings
        let credentialSchema: Record<string, unknown> | undefined;
        if (entry.credential_schema) {
          try {
            credentialSchema = JSON.parse(entry.credential_schema) as Record<string, unknown>;
          } catch (err) {
            return {
              status: 'error',
              tools_discovered: [],
              tool_count: 0,
              error_code: 'internal_error',
              message: `Failed to parse credential_schema: ${err instanceof Error ? err.message : String(err)}`,
              discovered_at: new Date().toISOString(),
              duration_ms: Date.now() - startTime,
              warnings,
            };
          }
        }

        // Map credential fields to env vars
        const properties = credentialSchema?.properties as
          | Record<string, { env_var?: string }>
          | undefined;
        for (const [fieldName, fieldValue] of Object.entries(adminCredentials)) {
          // Look up env_var mapping in credential_schema
          const envVarName = properties?.[fieldName]?.env_var ?? fieldName;

          // Security check: block dangerous env vars
          if (BLOCKED_ENV_VARS.includes(envVarName.toUpperCase())) {
            return {
              status: 'error',
              tools_discovered: [],
              tool_count: 0,
              error_code: 'internal_error',
              message: `Credential field '${fieldName}' maps to blocked environment variable '${envVarName}'`,
              discovered_at: new Date().toISOString(),
              duration_ms: Date.now() - startTime,
              warnings,
            };
          }

          credentialEnvVars[envVarName] = fieldValue;
        }

        // Skip the validation_status check when admin provides credentials for testing
        // Admin is explicitly testing with their own credentials
        // Branch 3: No credentials available
      } else {
        // No credentials provided - return skipped result
        const message =
          entry.auth_type === 'oauth2'
            ? 'Admin must connect their OAuth credential first. Go to User Portal to authorize this MCP.'
            : 'This MCP requires user credentials. Tool discovery is skipped during admin setup. Tools will be discovered when a user provides their credentials.';

        return {
          status: 'skipped',
          tools_discovered: [],
          tool_count: 0,
          error_code: 'credential_required',
          message,
          discovered_at: new Date().toISOString(),
          duration_ms: Date.now() - startTime,
          warnings,
        };
      }
    }

    // Precondition 2: Check validation status (skip if admin provided credentials for credential-gated MCP)
    if (!credentialEnvVars && entry.validation_status !== 'valid') {
      return {
        status: 'error',
        tools_discovered: [],
        tool_count: 0,
        error_code: 'validation_required',
        message: `Run validation first. Current validation status: ${entry.validation_status}`,
        discovered_at: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
        warnings,
      };
    }

    // Parse config JSON
    let configObj: Record<string, unknown>;
    try {
      configObj = JSON.parse(entry.config) as Record<string, unknown>;
    } catch (err) {
      return {
        status: 'error',
        tools_discovered: [],
        tool_count: 0,
        error_code: 'internal_error',
        message: `Failed to parse config JSON: ${err instanceof Error ? err.message : String(err)}`,
        discovered_at: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
        warnings,
      };
    }

    // Build DownstreamMcpConfig
    const dsConfig: DownstreamMcpConfig = {
      name: entry.name,
      transport: entry.transport_type,
      command: configObj.command as string[] | undefined,
      env: configObj.env as Record<string, string> | undefined,
      cwd: undefined,
      url: configObj.url as string | undefined,
      headers: configObj.headers as Record<string, string> | undefined,
      timeout_ms: (configObj.timeout_ms as number) ?? 30_000,
    };

    // Merge admin-provided credential env vars if present
    if (credentialEnvVars) {
      dsConfig.env = { ...dsConfig.env, ...credentialEnvVars };
    }

    // Merge OAuth headers if present
    if (credentialHeaders) {
      dsConfig.headers = { ...dsConfig.headers, ...credentialHeaders };
    }

    // Create connection based on transport
    let connection: StdioMcpConnection | HttpMcpConnection;
    if (entry.transport_type === 'stdio') {
      connection = new StdioMcpConnection(dsConfig);
    } else if (entry.transport_type === 'http' || entry.transport_type === 'sse') {
      connection = new HttpMcpConnection(dsConfig);
    } else {
      return {
        status: 'error',
        tools_discovered: [],
        tool_count: 0,
        error_code: 'unknown_transport',
        message: `Unsupported transport type: ${entry.transport_type as string}`,
        discovered_at: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
        warnings,
      };
    }

    try {
      // Wrap in timeout
      const discoveryPromise = performDiscovery(connection);
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Discovery timeout')), DEFAULT_DISCOVERY_TIMEOUT);
      });

      const tools = await Promise.race([discoveryPromise, timeoutPromise]);

      // Filter invalid tool names
      const validTools: ToolDescriptor[] = [];
      for (const tool of tools) {
        if (validateToolName(tool.name)) {
          validTools.push(tool);
        } else {
          warnings.push(`Tool name '${tool.name}' is invalid and was filtered out.`);
        }
      }

      // Cap at MAX_TOOLS
      let finalTools = validTools;
      if (validTools.length > MAX_TOOLS) {
        finalTools = validTools.slice(0, MAX_TOOLS);
        warnings.push(
          `Tool count exceeded ${MAX_TOOLS}. Only the first ${MAX_TOOLS} tools were saved.`
        );
      }

      // Map to simplified shape
      const toolsDiscovered = finalTools.map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as Record<string, unknown>,
      }));

      return {
        status: 'success',
        tools_discovered: toolsDiscovered,
        tool_count: toolsDiscovered.length,
        discovered_at: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    } catch (err) {
      // Classify error
      const errorMessage = err instanceof Error ? err.message : String(err);
      let errorCode: DiscoveryErrorCode;
      let userMessage: string;

      if (errorMessage.includes('timeout') || errorMessage.includes('Discovery timeout')) {
        errorCode = 'connection_timeout';
        userMessage =
          'Could not connect to MCP server within 45 seconds. Check the URL/command and ensure the server is running.';
      } else if (errorMessage.includes('exited') || errorMessage.includes('Process')) {
        errorCode = 'process_crashed';
        userMessage = 'MCP process exited unexpectedly. Check command path and dependencies.';
      } else if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('ENOTFOUND')) {
        errorCode = 'unreachable';
        userMessage =
          'Could not reach MCP server. Verify the URL is correct and accessible from this server.';
      } else if (errorMessage.includes('TLS') || errorMessage.includes('certificate')) {
        errorCode = 'tls_error';
        userMessage =
          'TLS certificate validation failed. The MCP server may have an invalid or self-signed certificate.';
      } else if (errorMessage.includes('tools/list')) {
        errorCode = 'discovery_failed';
        userMessage = `Connected to MCP but tool listing failed: ${errorMessage}`;
      } else if (errorMessage.includes('parse') || errorMessage.includes('JSON')) {
        errorCode = 'invalid_response';
        userMessage = 'Connected to MCP but received an invalid tools/list response.';
      } else {
        errorCode = 'internal_error';
        userMessage = `Unexpected error during discovery: ${errorMessage}`;
      }

      return {
        status: 'error',
        tools_discovered: [],
        tool_count: 0,
        error_code: errorCode,
        message: userMessage,
        discovered_at: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    } finally {
      // ALWAYS clean up connection
      try {
        await connection.stop();
      } catch (cleanupErr) {
        // Ignore cleanup errors
        console.warn(`[ToolDiscoveryEngine] Cleanup error for ${entry.name}:`, cleanupErr);
      }
    }
  } catch (outerErr) {
    // Catch any unexpected errors in the outer try block
    console.error(
      `[DiscoveryEngine] Unexpected error during discovery for MCP ${entry.name}:`,
      outerErr
    );
    return {
      status: 'error',
      tools_discovered: [],
      tool_count: 0,
      error_code: 'internal_error',
      message: 'An unexpected error occurred during discovery. Check server logs for details.',
      discovered_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }
}

/**
 * Internal helper: Perform the actual discovery (start → getTools → stop)
 */
async function performDiscovery(
  connection: StdioMcpConnection | HttpMcpConnection
): Promise<ToolDescriptor[]> {
  // Start connection (initialize + tools/list)
  await connection.start();

  // Get cached tools
  const tools = connection.getTools();

  return tools;
}
