/**
 * Master Key Manager Tests
 *
 * Tests for master key loading and generation.
 *
 * @see M26.10: Integration Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MasterKeyManager } from '../../src/services/master-key-manager.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

describe('MasterKeyManager', () => {
  let tempDir: string;

  beforeEach(() => {
    // Create a temporary directory for tests
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpambassador-test-'));
  });

  afterEach(() => {
    // Clean up temp directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }

    // Clean up environment variable
    delete process.env.CREDENTIAL_MASTER_KEY;
  });

  describe('loadMasterKey', () => {
    it('should auto-generate key when file does not exist', async () => {
      const manager = new MasterKeyManager(tempDir);
      const key = await manager.loadMasterKey();

      expect(key).toBeInstanceOf(Buffer);
      expect(key.length).toBe(32);

      // Key file should have been created
      const keyPath = path.join(tempDir, 'credential_master_key');
      expect(fs.existsSync(keyPath)).toBe(true);

      // Verify file permissions (0o600 = owner read/write only)
      const stats = fs.statSync(keyPath);
      expect(stats.mode & 0o777).toBe(0o600);
    });

    it('should load key from file if it exists', async () => {
      const manager = new MasterKeyManager(tempDir);

      // First call generates the key
      const key1 = await manager.loadMasterKey();

      // Second call should load the same key from file
      const manager2 = new MasterKeyManager(tempDir);
      const key2 = await manager2.loadMasterKey();

      expect(key2.toString('hex')).toBe(key1.toString('hex'));
    });

    it('should load key from environment variable if set', async () => {
      const envKey = crypto.randomBytes(32).toString('hex');
      process.env.CREDENTIAL_MASTER_KEY = envKey;

      const manager = new MasterKeyManager(tempDir);
      const key = await manager.loadMasterKey();

      expect(key.toString('hex')).toBe(envKey);

      // File should NOT be created when loading from env
      const keyPath = path.join(tempDir, 'credential_master_key');
      expect(fs.existsSync(keyPath)).toBe(false);
    });

    it('should prioritize environment variable over file', async () => {
      // Create a key file first
      const manager1 = new MasterKeyManager(tempDir);
      await manager1.loadMasterKey();

      // Set environment variable with different key
      const envKey = crypto.randomBytes(32).toString('hex');
      process.env.CREDENTIAL_MASTER_KEY = envKey;

      // Should load from env, not file
      const manager2 = new MasterKeyManager(tempDir);
      const key = await manager2.loadMasterKey();

      expect(key.toString('hex')).toBe(envKey);
    });

    it('should throw error if environment key is invalid length', async () => {
      process.env.CREDENTIAL_MASTER_KEY = 'invalid'; // Not 64 hex chars

      const manager = new MasterKeyManager(tempDir);

      await expect(manager.loadMasterKey()).rejects.toThrow(
        'CREDENTIAL_MASTER_KEY must be 64 hex characters (32 bytes)'
      );
    });

    it('should throw error if environment key is not 64 chars', async () => {
      process.env.CREDENTIAL_MASTER_KEY = crypto.randomBytes(16).toString('hex'); // Only 32 chars

      const manager = new MasterKeyManager(tempDir);

      await expect(manager.loadMasterKey()).rejects.toThrow(
        'CREDENTIAL_MASTER_KEY must be 64 hex characters (32 bytes)'
      );
    });
  });

  describe('saveMasterKey', () => {
    it('should save a new master key to file', async () => {
      const manager = new MasterKeyManager(tempDir);
      const newKey = crypto.randomBytes(32);

      await manager.saveMasterKey(newKey);

      // Verify file was created
      const keyPath = path.join(tempDir, 'credential_master_key');
      expect(fs.existsSync(keyPath)).toBe(true);

      // Verify file content
      const savedKey = fs.readFileSync(keyPath, 'utf8').trim();
      expect(savedKey).toBe(newKey.toString('hex'));

      // Verify file permissions
      const stats = fs.statSync(keyPath);
      expect(stats.mode & 0o777).toBe(0o600);
    });

    it('should overwrite existing key file', async () => {
      const manager = new MasterKeyManager(tempDir);

      // Create initial key
      const key1 = crypto.randomBytes(32);
      await manager.saveMasterKey(key1);

      // Overwrite with new key
      const key2 = crypto.randomBytes(32);
      await manager.saveMasterKey(key2);

      // Verify new key was saved
      const keyPath = path.join(tempDir, 'credential_master_key');
      const savedKey = fs.readFileSync(keyPath, 'utf8').trim();
      expect(savedKey).toBe(key2.toString('hex'));
    });

    it('should throw error if key is not 32 bytes', async () => {
      const manager = new MasterKeyManager(tempDir);
      const wrongKey = crypto.randomBytes(16);

      await expect(manager.saveMasterKey(wrongKey)).rejects.toThrow(
        'Master key must be 32 bytes'
      );
    });
  });
});
