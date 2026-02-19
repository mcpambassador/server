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
        return reply.status(400).send({
          error: 'Invalid parameters',
          details: paramsResult.error.issues,
        });
      }

      const { mcpId } = paramsResult.data;

      // Validate body
      const bodyResult = setCredentialBodySchema.safeParse(request.body);
      if (!bodyResult.success) {
        return reply.status(400).send({
          error: 'Invalid request body',
          details: bodyResult.error.issues,
        });
      }

      const { credentials } = bodyResult.data;

      // Check if MCP exists and requires credentials
      const mcpEntry = await getMcpEntryById(db, mcpId);
      if (!mcpEntry) {
        return reply.status(404).send({
          error: 'Not found',
          message: 'MCP not found in catalog',
        });
      }

      if (!mcpEntry.requires_user_credentials) {
        return reply.status(400).send({
          error: 'Bad request',
          message: 'This MCP does not require user credentials',
        });
      }

      // Basic credential schema validation (if schema is defined)
      if (mcpEntry.credential_schema) {
        try {
          const schema = JSON.parse(mcpEntry.credential_schema) as Record<string, unknown>;
          const requiredFields = (schema.required as string[]) || [];

          for (const field of requiredFields) {
            if (!(field in credentials)) {
              return reply.status(400).send({
                error: 'Validation failed',
                message: `Missing required credential field: ${field}`,
              });
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
        return reply.status(404).send({
          error: 'Not found',
          message: 'User not found',
        });
      }

      // Ensure user has a vault_salt (generate if missing)
      let vaultSalt = user.vault_salt;
      if (!vaultSalt) {
        vaultSalt = (await import('../services/credential-vault.js')).CredentialVault.generateVaultSalt();
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

      return reply.status(200).send({
        mcp_id: mcpId,
        has_credentials: true,
        updated_at: updatedAt,
      });
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

      // Get all MCPs that require credentials
      const allMcps = await db.query.mcp_catalog.findMany({
        where: (mcp_catalog, { eq }) => eq(mcp_catalog.requires_user_credentials, true),
      });

      // Build response array
      const result = allMcps.map(mcp => {
        const credInfo = credMap.get(mcp.mcp_id);
        return {
          mcp_id: mcp.mcp_id,
          mcp_name: mcp.name,
          has_credentials: credInfo ? credInfo.has_credentials : false,
          updated_at: credInfo ? credInfo.updated_at : null,
        };
      });

      return reply.status(200).send(result);
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
        return reply.status(400).send({
          error: 'Invalid parameters',
          details: paramsResult.error.issues,
        });
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

      return reply.status(204).send();
    }
  );
}
