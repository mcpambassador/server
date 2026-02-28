/**
 * Credential Vault Service
 *
 * Core encryption/decryption service for per-user MCP credentials.
 * Implements AES-256-GCM encryption with HKDF-based key derivation.
 *
 * @see ADR-P3-02: Credential Vault Encryption Scheme
 * @see M26.1: Credential Vault Service
 */

import crypto from 'crypto';

const HKDF_INFO = 'mcpambassador-credential-vault-v1';

/**
 * Credential Vault
 *
 * Encrypts and decrypts user credentials using AES-256-GCM with per-user key derivation.
 *
 * Security properties:
 * - Master key: 32 bytes (256 bits)
 * - Per-user key derivation: HKDF-SHA256(master_key, salt=user.vault_salt, info=HKDF_INFO)
 * - Encryption: AES-256-GCM with 12-byte IV and 16-byte auth tag
 * - Domain separation: Each user has unique vault_salt, ensuring distinct encryption keys
 * - Memory safety: User keys are zeroed after use
 */
export class CredentialVault {
  private masterKey: Buffer;

  constructor(masterKey: Buffer) {
    if (masterKey.length !== 32) {
      throw new Error('Master key must be 32 bytes');
    }
    this.masterKey = masterKey;
  }

  /**
   * Derive per-user key using HKDF-SHA256
   *
   * Per ADR-P3-02:
   * user_key = HKDF-SHA256(master_key, salt=user.vault_salt, info="mcpambassador-credential-vault-v1")
   *
   * @param vaultSalt User's vault_salt (64-char hex string, 32 bytes)
   * @returns Derived 32-byte key
   */
  private deriveUserKey(vaultSalt: string): Buffer {
    // SEC-M4: Validate vault_salt format
    if (!/^[0-9a-f]{64}$/i.test(vaultSalt)) {
      throw new Error('Invalid vault_salt format: must be 64 hex characters');
    }
    const salt = Buffer.from(vaultSalt, 'hex');
    return Buffer.from(crypto.hkdfSync('sha256', this.masterKey, salt, HKDF_INFO, 32));
  }

  /**
   * Encrypt credentials for a user
   *
   * @param vaultSalt User's vault_salt
   * @param plaintext Credential JSON string
   * @returns Encrypted credentials (base64) and IV (hex)
   */
  encrypt(vaultSalt: string, plaintext: string): { encryptedCredentials: string; iv: string } {
    const userKey = this.deriveUserKey(vaultSalt);
    const iv = crypto.randomBytes(12); // GCM standard: 12-byte IV
    const cipher = crypto.createCipheriv('aes-256-gcm', userKey, iv);

    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag(); // 16 bytes
    const combined = Buffer.concat([encrypted, tag]);

    // Zero user key from memory
    userKey.fill(0);

    return {
      encryptedCredentials: combined.toString('base64'),
      iv: iv.toString('hex'),
    };
  }

  /**
   * Decrypt credentials for a user
   *
   * @param vaultSalt User's vault_salt
   * @param encryptedCredentials Base64-encoded ciphertext+tag
   * @param iv Hex-encoded IV
   * @returns Decrypted plaintext
   * @throws Error if decryption fails (invalid auth tag, tampered data, etc.)
   */
  decrypt(vaultSalt: string, encryptedCredentials: string, iv: string): string {
    const userKey = this.deriveUserKey(vaultSalt);
    const ivBuf = Buffer.from(iv, 'hex');
    const combined = Buffer.from(encryptedCredentials, 'base64');

    // Split ciphertext and auth tag (last 16 bytes)
    const ciphertext = combined.subarray(0, combined.length - 16);
    const tag = combined.subarray(combined.length - 16);

    const decipher = crypto.createDecipheriv('aes-256-gcm', userKey, ivBuf);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    // Zero user key from memory
    userKey.fill(0);

    return decrypted.toString('utf8');
  }

  /**
   * Re-encrypt all credentials with a new master key
   *
   * Used during key rotation. Decrypts with current key, encrypts with new key.
   *
   * @param oldVaultSalt User's vault_salt
   * @param encryptedCredentials Current encrypted credentials
   * @param iv Current IV
   * @param newMasterKey New master key (32 bytes)
   * @returns New encrypted credentials and IV
   */
  reEncrypt(
    oldVaultSalt: string,
    encryptedCredentials: string,
    iv: string,
    newMasterKey: Buffer
  ): { encryptedCredentials: string; iv: string } {
    // Decrypt with current key
    const plaintext = this.decrypt(oldVaultSalt, encryptedCredentials, iv);

    // Create temp vault with new key
    const newVault = new CredentialVault(newMasterKey);
    const result = newVault.encrypt(oldVaultSalt, plaintext);

    // Note: JavaScript strings cannot be reliably zeroed from memory
    // (V8 may have copies in various internal buffers)
    // Best practice: minimize plaintext lifetime scope

    return result;
  }

  /**
   * Update the master key in a live vault instance
   *
   * Used after key rotation to update the vault without restarting the server.
   * SEC-H1: Prevents split-brain where new encryptions use stale key.
   *
   * @param newMasterKey New 32-byte master key
   */
  updateMasterKey(newMasterKey: Buffer): void {
    if (newMasterKey.length !== 32) {
      throw new Error('Master key must be 32 bytes');
    }
    this.masterKey = newMasterKey;
    console.log('[CredentialVault] Master key updated in live instance');
  }

  /**
   * Generate a vault salt for a user
   *
   * Returns 32 bytes (64 hex chars) of cryptographically secure random data.
   * This salt is stored in the users.vault_salt column and used to derive per-user keys.
   *
   * @returns 64-character hex string (32 bytes)
   */
  static generateVaultSalt(): string {
    return crypto.randomBytes(32).toString('hex');
  }
}
