/**
 * Admin Security Routes
 *
 * Fastify plugin for security-critical endpoints:
 * - Kill switch management
 * - HMAC secret rotation
 * - Credential vault key rotation
 *
 * All routes require admin authentication (applied globally by parent plugin).
 *
 * @see M8.8: Kill Switch
 * @see M19.2a: HMAC Secret Rotation
 * @see M26.7: Credential Vault Key Rotation
 * @see Architecture §16.4 Admin API Design Principles
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import type { FastifyInstance, FastifyPluginCallback } from 'fastify';
import type { DatabaseClient, AuditProvider } from '@mcpambassador/core';
import type { KillSwitchManager } from './kill-switch-manager.js';
import { killSwitchSchema, killSwitchParamsSchema } from './schemas.js';
import { wrapSuccess, wrapError, ErrorCodes } from './reply-envelope.js';

/**
 * Admin security routes plugin configuration
 */
export interface AdminSecurityRoutesConfig {
  db: DatabaseClient;
  audit: AuditProvider;
  dataDir: string;
  killSwitchManager: KillSwitchManager;
  rotateHmacSecret: () => Promise<number>;
}

/**
 * Admin security routes plugin
 */
export const registerAdminSecurityRoutes: FastifyPluginCallback<AdminSecurityRoutesConfig> = (
  fastify: FastifyInstance,
  opts: AdminSecurityRoutesConfig,
  done
) => {
  const { db, audit, dataDir, killSwitchManager, rotateHmacSecret } = opts;

  // ==========================================================================
  // M8.8: POST /v1/admin/kill-switch/:target
  // CR-M10-001: Use shared kill switch manager
  // ==========================================================================
  fastify.post('/v1/admin/kill-switch/:target', async (request, reply) => {
    const { target } = killSwitchParamsSchema.parse(request.params);
    const body = killSwitchSchema.parse(request.body);

    // Store kill switch state using shared manager
    killSwitchManager.set(target, body.enabled);

    // Emit audit event
    await audit.emit({
      event_id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      event_type: 'admin_action',
      severity: 'warn',
      client_id: undefined,
      user_id: undefined,
      source_ip: '127.0.0.1',
      action: body.enabled ? 'kill_switch_activate' : 'kill_switch_deactivate',
      metadata: {
        target,
        enabled: body.enabled,
      },
    });

    return reply.send(wrapSuccess({
      target,
      enabled: body.enabled,
      timestamp: new Date().toISOString(),
    }));
  });

  // ==========================================================================
  // M19.2a: POST /v1/admin/rotate-hmac-secret
  // ==========================================================================
  fastify.post('/v1/admin/rotate-hmac-secret', async (request, reply) => {
    const sourceIp = request.ip || '127.0.0.1';
    const nowIso = new Date().toISOString();

    try {
      // Call the rotation method (returns count of invalidated sessions)
      const sessionsInvalidated = await rotateHmacSecret();

      // Emit audit event
      await audit.emit({
        event_id: crypto.randomUUID(),
        timestamp: nowIso,
        event_type: 'admin_action',
        severity: 'critical',
        client_id: undefined,
        user_id: undefined,
        source_ip: sourceIp,
        action: 'hmac_secret_rotated',
        metadata: {
          sessions_invalidated: sessionsInvalidated,
          actor: 'admin',
        },
      });

      return reply.send(wrapSuccess({
        sessionsInvalidated,
        message: 'HMAC secret rotated. All sessions invalidated.',
      }));
    } catch (err) {
      // Emit audit event for failure
      await audit.emit({
        event_id: crypto.randomUUID(),
        timestamp: nowIso,
        event_type: 'admin_action',
        severity: 'error',
        client_id: undefined,
        user_id: undefined,
        source_ip: sourceIp,
        action: 'hmac_secret_rotation_failed',
        metadata: {
          error: err instanceof Error ? err.message : 'Unknown error',
          actor: 'admin',
        },
      });

      // Log the real error for debugging (do not expose internal details to clients)
      // eslint-disable-next-line no-console
      console.error('[Admin] HMAC rotation failed:', err instanceof Error ? err.message : err);

      return reply.status(500).send(
        wrapError(ErrorCodes.INTERNAL_ERROR, 'Failed to rotate HMAC secret')
      );
    }
  });

  // ==========================================================================
  // M26.7: POST /v1/admin/rotate-credential-key - Rotate credential vault master key
  // ==========================================================================
  fastify.post('/v1/admin/rotate-credential-key', async (request, reply) => {
    const bodySchema = z
      .object({
        new_key: z.string().length(64).regex(/^[0-9a-fA-F]+$/),
      })
      .strict();

    const bodyResult = bodySchema.safeParse(request.body);
    if (!bodyResult.success) {
      return reply.status(400).send(
        wrapError(ErrorCodes.VALIDATION_ERROR, 'Invalid request', bodyResult.error.issues)
      );
    }

    const { new_key } = bodyResult.data;
    const newMasterKey = Buffer.from(new_key, 'hex');
    let currentMasterKey: Buffer | null = null;
    let tmpKeyPath: string | null = null;

    try {
      // Import vault and key manager
      const { CredentialVault } = await import('../services/credential-vault.js');
      const { MasterKeyManager } = await import('../services/master-key-manager.js');

      // Load current master key
      const keyManager = new MasterKeyManager(dataDir);
      currentMasterKey = await keyManager.loadMasterKey();
      const currentVault = new CredentialVault(currentMasterKey);

      // Get all credentials from database
      const {
        updateCredential,
        user_mcp_credentials,
        compatSelect,
        compatTransaction,
      } = await import('@mcpambassador/core');

      const allCredentials = await compatSelect(db).from(user_mcp_credentials);

      console.log(`[Admin] Starting credential re-encryption for ${allCredentials.length} credentials...`);

      // SEC-M2: Write key file FIRST (to temp), then DB transaction, then rename
      const keyPath = path.join(dataDir, 'credential_master_key');
      tmpKeyPath = keyPath + '.tmp';
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(tmpKeyPath, newMasterKey.toString('hex'), { mode: 0o600 });

      // Re-encrypt all credentials in a transaction
      await compatTransaction(db, async () => {
        for (const cred of allCredentials) {
          // Get user's vault_salt
          const user = await db.query.users.findFirst({
            where: (users: any, { eq }: any) => eq(users.user_id, cred.user_id),
          });

          if (!user || !user.vault_salt) {
            console.warn(`[Admin] User ${cred.user_id} has no vault_salt, skipping credential ${cred.credential_id}`);
            continue;
          }

          // Re-encrypt with new key
          const { encryptedCredentials, iv } = currentVault.reEncrypt(
            user.vault_salt,
            cred.encrypted_credentials,
            cred.encryption_iv,
            newMasterKey
          );

          // Update in database
          await updateCredential(db, cred.credential_id, {
            encrypted_credentials: encryptedCredentials,
            encryption_iv: iv,
          });
        }
      });

      // Atomic rename: tmpKeyPath -> keyPath
      fs.renameSync(tmpKeyPath, keyPath);
      tmpKeyPath = null; // Mark as committed

      // SEC-H1: Update the live vault instance with new master key
      const serverInstance = request.server as any;
      if (serverInstance.credentialVault) {
        serverInstance.credentialVault.updateMasterKey(newMasterKey);
      }

      const completedAt = new Date().toISOString();

      console.log(`[Admin] Credential master key rotation complete: ${allCredentials.length} credentials re-encrypted`);

      return reply.status(200).send(wrapSuccess({
        rotated_count: allCredentials.length,
        completed_at: completedAt,
      }));
    } catch (err) {
      console.error('[Admin] Credential key rotation failed:', err);
      // If transaction failed and temp file exists, delete it
      if (tmpKeyPath) {
        try {
          fs.unlinkSync(tmpKeyPath);
        } catch (unlinkErr) {
          // Ignore cleanup errors
        }
      }
      return reply.status(500).send(
        wrapError(ErrorCodes.INTERNAL_ERROR, 'Failed to rotate credential master key')
      );
    } finally {
      // SEC-H2: Zero master key buffers from heap
      if (currentMasterKey) {
        currentMasterKey.fill(0);
      }
      newMasterKey.fill(0);
    }
  });

  done();
};
