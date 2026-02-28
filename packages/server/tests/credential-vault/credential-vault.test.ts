/**
 * Credential Vault Unit Tests
 *
 * Tests for the CredentialVault encryption/decryption service.
 *
 * @see M26.10: Integration Tests
 */

import { describe, it, expect, vi } from 'vitest';
import { CredentialVault } from '../../src/services/credential-vault.js';
import crypto from 'crypto';

describe('CredentialVault', () => {
  const masterKey = crypto.randomBytes(32);
  const vaultSalt = crypto.randomBytes(32).toString('hex');

  describe('constructor', () => {
    it('should accept a 32-byte master key', () => {
      expect(() => new CredentialVault(masterKey)).not.toThrow();
    });

    it('should reject a master key that is not 32 bytes', () => {
      const wrongKey = crypto.randomBytes(16);
      expect(() => new CredentialVault(wrongKey)).toThrow('Master key must be 32 bytes');
    });
  });

  describe('encrypt / decrypt', () => {
    it('should encrypt and decrypt round-trip successfully', () => {
      const vault = new CredentialVault(masterKey);
      const plaintext = JSON.stringify({ api_key: 'secret-12345', region: 'us-west-2' });

      const { encryptedCredentials, iv } = vault.encrypt(vaultSalt, plaintext);
      const decrypted = vault.decrypt(vaultSalt, encryptedCredentials, iv);

      expect(decrypted).toBe(plaintext);
    });

    it('should produce different ciphertext for different users (different vault_salt)', () => {
      const vault = new CredentialVault(masterKey);
      const plaintext = JSON.stringify({ api_key: 'secret-12345' });

      const salt1 = crypto.randomBytes(32).toString('hex');
      const salt2 = crypto.randomBytes(32).toString('hex');

      const { encryptedCredentials: enc1 } = vault.encrypt(salt1, plaintext);
      const { encryptedCredentials: enc2 } = vault.encrypt(salt2, plaintext);

      // Different salts should produce different ciphertext
      expect(enc1).not.toBe(enc2);
    });

    it('should produce different ciphertext each time (random IV)', () => {
      const vault = new CredentialVault(masterKey);
      const plaintext = JSON.stringify({ api_key: 'secret-12345' });

      const { encryptedCredentials: enc1, iv: iv1 } = vault.encrypt(vaultSalt, plaintext);
      const { encryptedCredentials: enc2, iv: iv2 } = vault.encrypt(vaultSalt, plaintext);

      // Different IVs should produce different ciphertext
      expect(iv1).not.toBe(iv2);
      expect(enc1).not.toBe(enc2);

      // Both should decrypt to same plaintext
      const dec1 = vault.decrypt(vaultSalt, enc1, iv1);
      const dec2 = vault.decrypt(vaultSalt, enc2, iv2);
      expect(dec1).toBe(plaintext);
      expect(dec2).toBe(plaintext);
    });

    it('should fail decryption with tampered ciphertext', () => {
      const vault = new CredentialVault(masterKey);
      const plaintext = JSON.stringify({ api_key: 'secret-12345' });

      const { encryptedCredentials, iv } = vault.encrypt(vaultSalt, plaintext);

      // Tamper with ciphertext
      const tamperedBuf = Buffer.from(encryptedCredentials, 'base64');
      tamperedBuf[0] ^= 0xff; // Flip some bits
      const tamperedCiphertext = tamperedBuf.toString('base64');

      expect(() => vault.decrypt(vaultSalt, tamperedCiphertext, iv)).toThrow();
    });

    it('should fail decryption with wrong vault_salt', () => {
      const vault = new CredentialVault(masterKey);
      const plaintext = JSON.stringify({ api_key: 'secret-12345' });

      const { encryptedCredentials, iv } = vault.encrypt(vaultSalt, plaintext);

      // Try to decrypt with different salt
      const wrongSalt = crypto.randomBytes(32).toString('hex');

      expect(() => vault.decrypt(wrongSalt, encryptedCredentials, iv)).toThrow();
    });

    it('should fail decryption with wrong IV', () => {
      const vault = new CredentialVault(masterKey);
      const plaintext = JSON.stringify({ api_key: 'secret-12345' });

      const { encryptedCredentials, iv } = vault.encrypt(vaultSalt, plaintext);

      // Try to decrypt with different IV
      const wrongIv = crypto.randomBytes(12).toString('hex');

      expect(() => vault.decrypt(vaultSalt, encryptedCredentials, wrongIv)).toThrow();
    });
  });

  describe('reEncrypt', () => {
    it('should re-encrypt credentials with a new master key', () => {
      const oldVault = new CredentialVault(masterKey);
      const plaintext = JSON.stringify({ api_key: 'secret-12345' });

      const { encryptedCredentials, iv } = oldVault.encrypt(vaultSalt, plaintext);

      // Create new master key
      const newMasterKey = crypto.randomBytes(32);

      // Re-encrypt with new key
      const { encryptedCredentials: newEnc, iv: newIv } = oldVault.reEncrypt(
        vaultSalt,
        encryptedCredentials,
        iv,
        newMasterKey
      );

      // Old vault should still be able to decrypt old ciphertext
      const dec1 = oldVault.decrypt(vaultSalt, encryptedCredentials, iv);
      expect(dec1).toBe(plaintext);

      // New vault should be able to decrypt new ciphertext
      const newVault = new CredentialVault(newMasterKey);
      const dec2 = newVault.decrypt(vaultSalt, newEnc, newIv);
      expect(dec2).toBe(plaintext);

      // New ciphertext should be different from old
      expect(newEnc).not.toBe(encryptedCredentials);
    });
  });

  describe('generateVaultSalt', () => {
    it('should generate a 64-character hex string', () => {
      const salt = CredentialVault.generateVaultSalt();
      expect(salt).toHaveLength(64);
      expect(salt).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should generate different salts each time', () => {
      const salt1 = CredentialVault.generateVaultSalt();
      const salt2 = CredentialVault.generateVaultSalt();
      expect(salt1).not.toBe(salt2);
    });
  });

  describe('memory safety', () => {
    it('should zero user key from memory after encryption', () => {
      // This test verifies that the userKey.fill(0) call happens
      // We can't directly test memory wiping in JS, but we can spy on Buffer.prototype.fill
      const fillSpy = vi.spyOn(Buffer.prototype, 'fill');

      const vault = new CredentialVault(masterKey);
      const plaintext = JSON.stringify({ api_key: 'secret-12345' });

      vault.encrypt(vaultSalt, plaintext);

      // Should have called fill(0) at least once (on the derived user key)
      expect(fillSpy).toHaveBeenCalledWith(0);

      fillSpy.mockRestore();
    });

    it('should zero user key from memory after decryption', () => {
      const fillSpy = vi.spyOn(Buffer.prototype, 'fill');

      const vault = new CredentialVault(masterKey);
      const plaintext = JSON.stringify({ api_key: 'secret-12345' });

      const { encryptedCredentials, iv } = vault.encrypt(vaultSalt, plaintext);
      fillSpy.mockClear(); // Clear calls from encrypt

      vault.decrypt(vaultSalt, encryptedCredentials, iv);

      // Should have called fill(0) at least once (on the derived user key)
      expect(fillSpy).toHaveBeenCalledWith(0);

      fillSpy.mockRestore();
    });
  });
});
