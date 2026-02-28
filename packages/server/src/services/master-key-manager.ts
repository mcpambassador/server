/**
 * Master Key Manager
 *
 * Manages the credential vault master key lifecycle.
 * Loads from environment variable, file, or auto-generates on first boot.
 *
 * @see ADR-P3-02: Credential Vault Encryption Scheme
 * @see M26.2: Master Key Manager
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/**
 * Master Key Manager
 *
 * Priority order for master key loading:
 * 1. Environment variable: CREDENTIAL_MASTER_KEY (64 hex chars)
 * 2. File: {dataDir}/credential_master_key
 * 3. Auto-generate: Create new key and save to file
 *
 * Security properties:
 * - Key file permissions: 0o600 (owner read/write only)
 * - Key format: 64-character hex string (32 bytes raw)
 */
export class MasterKeyManager {
  private dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  /**
   * Load or generate master key
   *
   * Priority: ENV var > file > auto-generate
   *
   * @returns 32-byte master key
   * @throws Error if environment key is invalid format
   */
  async loadMasterKey(): Promise<Buffer> {
    // 1. Check environment variable
    const envKey = process.env.CREDENTIAL_MASTER_KEY;
    if (envKey) {
      // SEC-M3: Validate hex format before parsing
      if (!/^[0-9a-f]{64}$/i.test(envKey)) {
        throw new Error('CREDENTIAL_MASTER_KEY must be 64 hex characters (32 bytes)');
      }
      console.log('[MasterKey] Loaded from environment variable');
      return Buffer.from(envKey, 'hex');
    }

    // 2. Check file
    const keyPath = path.join(this.dataDir, 'credential_master_key');
    if (fs.existsSync(keyPath)) {
      const keyHex = fs.readFileSync(keyPath, 'utf8').trim();
      console.log('[MasterKey] Loaded from file');
      return Buffer.from(keyHex, 'hex');
    }

    // 3. Auto-generate
    const newKey = crypto.randomBytes(32);
    fs.mkdirSync(this.dataDir, { recursive: true });
    // SEC-M1: Atomic write (temp + rename)
    const tmpPath = keyPath + '.tmp';
    fs.writeFileSync(tmpPath, newKey.toString('hex'), { mode: 0o600 });
    fs.renameSync(tmpPath, keyPath);
    console.log('[MasterKey] Generated new master key and saved to file');
    return newKey;
  }

  /**
   * Save a new master key to file
   *
   * Used during key rotation. Updates the key file atomically.
   *
   * @param newKey New 32-byte master key
   */
  async saveMasterKey(newKey: Buffer): Promise<void> {
    if (newKey.length !== 32) {
      throw new Error('Master key must be 32 bytes');
    }

    const keyPath = path.join(this.dataDir, 'credential_master_key');
    fs.mkdirSync(this.dataDir, { recursive: true });
    // SEC-M1: Atomic write (temp + rename)
    const tmpPath = keyPath + '.tmp';
    fs.writeFileSync(tmpPath, newKey.toString('hex'), { mode: 0o600 });
    fs.renameSync(tmpPath, keyPath);
    console.log('[MasterKey] Updated master key file');
  }
}
