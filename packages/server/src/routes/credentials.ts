/**
 * Credential Routes
 *
 * User self-service credential management endpoints.
 * All routes require user session authentication.
 *
 * @see M26.3: Credential Routes
 */

import type { FastifyInstance } from 'fastify';
import type { DatabaseClient } from '@mcpambassador/core';
import { requireUserSession } from '../auth/user-session.js';
import {
  getMcpEntryById,
  getCredential,
  storeCredential,
  updateCredential,
  deleteCredentialsForMcp,
  listCredentialsForUser,
  users,
  compatUpdate,
} from '@mcpambassador/core';
import { eq } from 'drizzle-orm';
import type { CredentialVault } from '../services/credential-vault.js';
import type { UserMcpPool } from '../downstream/user-mcp-pool.js';
import { credentialParamsSchema, setCredentialBodySchema } from './schemas.js'; // CR-L2: Import from schemas.ts
import { wrapSuccess, wrapError, ErrorCodes } from '../admin/reply-envelope.js';

/**
 * Credential routes config
 */
export interface CredentialRoutesConfig {
  db: DatabaseClient;
  vault: CredentialVault;
  userPool: UserMcpPool | null;
}

/**
 * Register credential routes
 */
export async function registerCredentialRoutes(
  fastify: FastifyInstance,
  config: CredentialRoutesConfig
): Promise<void> {
  const { db, vault, userPool } = config;

  // ==========================================================================
  // PUT /v1/users/me/credentials/:mcpId - Set or update credentials
  // ==========================================================================
  fastify.put(
    '/v1/users/me/credentials/:mcpId',
    {
      preHandler: requireUserSession,
    },
    async (request, reply) => {
      const userId = request.session.userId!;

      // Validate params
      const paramsResult = credentialParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return reply
          .status(400)
          .send(
            wrapError(ErrorCodes.VALIDATION_ERROR, 'Invalid parameters', paramsResult.error.issues)
          );
      }

      const { mcpId } = paramsResult.data;

      // Validate body
      const bodyResult = setCredentialBodySchema.safeParse(request.body);
      if (!bodyResult.success) {
        return reply
          .status(400)
          .send(
            wrapError(ErrorCodes.VALIDATION_ERROR, 'Invalid request body', bodyResult.error.issues)
          );
      }

      const { credentials } = bodyResult.data;

      // Check if MCP exists and requires credentials
      const mcpEntry = await getMcpEntryById(db, mcpId);
      if (!mcpEntry) {
        return reply.status(404).send(wrapError(ErrorCodes.NOT_FOUND, 'MCP not found in catalog'));
      }

      if (!mcpEntry.requires_user_credentials) {
        return reply
          .status(400)
          .send(wrapError(ErrorCodes.BAD_REQUEST, 'This MCP does not require user credentials'));
      }

      // Basic credential schema validation (if schema is defined)
      if (mcpEntry.credential_schema) {
        try {
          const schema = JSON.parse(mcpEntry.credential_schema) as Record<string, unknown>;
          const requiredFields = (schema.required as string[]) || [];

          for (const field of requiredFields) {
            if (!(field in credentials)) {
              return reply
                .status(400)
                .send(
                  wrapError(
                    ErrorCodes.VALIDATION_ERROR,
                    `Missing required credential field: ${field}`
                  )
                );
            }
          }
        } catch (err) {
          console.error('[Credentials] Failed to parse credential schema:', err);
          // Continue even if schema parsing fails
        }
      }

      // Get user record
      const user = await db.query.users.findFirst({
        where: (users, { eq }) => eq(users.user_id, userId),
      });

      if (!user) {
        return reply.status(404).send(wrapError(ErrorCodes.NOT_FOUND, 'User not found'));
      }

      // Ensure user has a vault_salt (generate if missing)
      let vaultSalt = user.vault_salt;
      if (!vaultSalt) {
        vaultSalt = (
          await import('../services/credential-vault.js')
        ).CredentialVault.generateVaultSalt();
        await compatUpdate(db, users)
          .set({ vault_salt: vaultSalt, updated_at: new Date().toISOString() })
          .where(eq(users.user_id, userId));

        console.log(`[Credentials] Generated vault_salt for user ${userId}`);
      }

      // Encrypt credentials
      const plaintext = JSON.stringify(credentials);
      const { encryptedCredentials, iv } = vault.encrypt(vaultSalt, plaintext);

      // Store or update credential
      const existingCred = await getCredential(db, userId, mcpId);
      let updatedAt: string;

      if (existingCred) {
        await updateCredential(db, existingCred.credential_id, {
          encrypted_credentials: encryptedCredentials,
          encryption_iv: iv,
        });
        updatedAt = new Date().toISOString();
        console.log(`[Credentials] Updated credentials for user ${userId}, MCP ${mcpId}`);
      } else {
        const newCred = await storeCredential(db, {
          user_id: userId,
          mcp_id: mcpId,
          encrypted_credentials: encryptedCredentials,
          encryption_iv: iv,
        });
        updatedAt = newCred.created_at;
        console.log(`[Credentials] Stored new credentials for user ${userId}, MCP ${mcpId}`);
      }

      return reply.status(200).send(
        wrapSuccess({
          mcpId: mcpId,
          hasCredentials: true,
          updatedAt: updatedAt,
        })
      );
    }
  );

  // ==========================================================================
  // GET /v1/users/me/credentials - List credential status
  // ==========================================================================
  fastify.get(
    '/v1/users/me/credentials',
    {
      preHandler: requireUserSession,
    },
    async (request, reply) => {
      const userId = request.session.userId!;

      // Get all credentials for user
      const credentials = await listCredentialsForUser(db, userId);

      // Build map of mcp_id -> has_credentials
      const credMap = new Map<string, { has_credentials: boolean; updated_at: string }>();
      for (const cred of credentials) {
        credMap.set(cred.mcp_id, {
          has_credentials: true,
          updated_at: cred.updated_at,
        });
      }

      // Get user's client IDs
      const userClients = await db.query.clients.findMany({
        where: (clients, { eq }) => eq(clients.user_id, userId),
        columns: { client_id: true },
      });

      const userClientIds = userClients.map((c: { client_id: string }) => c.client_id);

      // Get subscribed MCP IDs (only if user has clients)
      const subscribedMcpIds = new Set<string>();
      if (userClientIds.length > 0) {
        const subscriptions = await db.query.client_mcp_subscriptions.findMany({
          where: (sub, { and, eq, inArray }) =>
            and(inArray(sub.client_id, userClientIds), eq(sub.status, 'active')),
          columns: { mcp_id: true },
        });

        for (const sub of subscriptions) {
          subscribedMcpIds.add(sub.mcp_id);
        }
      }

      // Combine subscribed MCPs with MCPs that have credentials
      const allowedMcpIds = new Set<string>([...subscribedMcpIds, ...credMap.keys()]);

      // Get all MCPs that require credentials
      const allMcps = await db.query.mcp_catalog.findMany({
        where: (mcp_catalog, { eq }) => eq(mcp_catalog.requires_user_credentials, true),
      });

      // Filter to only MCPs user is subscribed to or has credentials for
      const filteredMcps = allMcps.filter(mcp => allowedMcpIds.has(mcp.mcp_id));

      // Build response array - transform to camelCase
      const result = filteredMcps.map(mcp => {
        const credInfo = credMap.get(mcp.mcp_id);
        return {
          mcpId: mcp.mcp_id,
          mcpName: mcp.name,
          hasCredentials: credInfo ? credInfo.has_credentials : false,
          requiresCredentials: mcp.requires_user_credentials || false,
          authType: mcp.auth_type || 'none',
          credentialSchema: mcp.credential_schema
            ? typeof mcp.credential_schema === 'string'
              ? JSON.parse(mcp.credential_schema)
              : mcp.credential_schema
            : undefined,
          updatedAt: credInfo ? credInfo.updated_at : undefined,
        };
      });

      return reply.status(200).send(wrapSuccess(result));
    }
  );

  // ==========================================================================
  // DELETE /v1/users/me/credentials/:mcpId - Delete credentials
  // ==========================================================================
  fastify.delete(
    '/v1/users/me/credentials/:mcpId',
    {
      preHandler: requireUserSession,
    },
    async (request, reply) => {
      const userId = request.session.userId!;

      // Validate params
      const paramsResult = credentialParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return reply
          .status(400)
          .send(
            wrapError(ErrorCodes.VALIDATION_ERROR, 'Invalid parameters', paramsResult.error.issues)
          );
      }

      const { mcpId } = paramsResult.data;

      // Delete credentials
      await deleteCredentialsForMcp(db, userId, mcpId);

      // Terminate any active per-user MCP instance for this user
      // (credentials are now invalid)
      if (userPool) {
        await userPool.terminateForUser(userId);
        console.log(`[Credentials] Terminated user ${userId} MCP pool after credential deletion`);
      }

      return reply.status(200).send(
        wrapSuccess({
          mcpId,
          deleted: true,
        })
      );
    }
  );
}
