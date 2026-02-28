/**
 * Password Policy Tests
 *
 * Unit tests for password validation and hashing functions.
 *
 * @see M21.9: Tests
 */

import { describe, it, expect } from 'vitest';
import {
  validatePassword,
  hashPassword,
  verifyPassword,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
} from '../../src/auth/password-policy.js';

describe('Password Policy', () => {
  describe('validatePassword', () => {
    it('should accept valid passwords', () => {
      const result = validatePassword('password123');
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject passwords shorter than minimum', () => {
      const result = validatePassword('short');
      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        `Password must be at least ${MIN_PASSWORD_LENGTH} characters`
      );
    });

    it('should reject empty passwords', () => {
      const result = validatePassword('');
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should reject passwords longer than maximum', () => {
      const longPassword = 'a'.repeat(MAX_PASSWORD_LENGTH + 1);
      const result = validatePassword(longPassword);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain(`Password must be at most ${MAX_PASSWORD_LENGTH} characters`);
    });

    it('should reject all-whitespace passwords', () => {
      const result = validatePassword('        ');
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Password cannot be all whitespace');
    });

    it('should accept password at minimum length', () => {
      const password = 'a'.repeat(MIN_PASSWORD_LENGTH);
      const result = validatePassword(password);
      expect(result.valid).toBe(true);
    });

    it('should accept password at maximum length', () => {
      const password = 'a'.repeat(MAX_PASSWORD_LENGTH);
      const result = validatePassword(password);
      expect(result.valid).toBe(true);
    });
  });

  describe('hashPassword and verifyPassword', () => {
    it('should hash and verify valid password', async () => {
      const password = 'mySecurePassword123';
      const hash = await hashPassword(password);

      expect(hash).toBeDefined();
      expect(hash.length).toBeGreaterThan(0);
      expect(hash).toMatch(/^\$argon2id\$/);

      const isValid = await verifyPassword(hash, password);
      expect(isValid).toBe(true);
    });

    it('should reject incorrect password', async () => {
      const password = 'mySecurePassword123';
      const wrongPassword = 'wrongPassword';
      const hash = await hashPassword(password);

      const isValid = await verifyPassword(hash, wrongPassword);
      expect(isValid).toBe(false);
    });

    it('should produce different hashes for same password', async () => {
      const password = 'mySecurePassword123';
      const hash1 = await hashPassword(password);
      const hash2 = await hashPassword(password);

      expect(hash1).not.toBe(hash2); // Salt should make them different
      expect(await verifyPassword(hash1, password)).toBe(true);
      expect(await verifyPassword(hash2, password)).toBe(true);
    });

    it('should handle invalid hash format gracefully', async () => {
      const isValid = await verifyPassword('not-a-valid-hash', 'password');
      expect(isValid).toBe(false);
    });
  });
});
