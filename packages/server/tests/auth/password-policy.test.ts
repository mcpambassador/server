/**
 * Password Policy Tests
 *
 * Unit tests for password validation and hashing functions.
 *
 * @see M21.9: Tests
 * @see dev-plan-v0.9.1.md A.4 Password Policy Strengthening
 */

import { describe, it, expect } from 'vitest';
import {
  validatePassword,
  detectCharacterClasses,
  hashPassword,
  verifyPassword,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
  MIN_CHARACTER_CLASSES,
} from '../../src/auth/password-policy.js';

describe('Password Policy', () => {
  describe('validatePassword', () => {
    it('should accept valid passwords with 2+ character classes', () => {
      // lowercase + digit
      expect(validatePassword('password1').valid).toBe(true);
      // uppercase + lowercase
      expect(validatePassword('Password').valid).toBe(true);
      // lowercase + special
      expect(validatePassword('password!').valid).toBe(true);
      // digit + special
      expect(validatePassword('12345678!').valid).toBe(true);
    });

    it('should accept password with all 4 character classes', () => {
      const result = validatePassword('Password1!');
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

    it('should reject passwords with only one character class (all lowercase)', () => {
      // 'aaaaaaaa' is 8 chars, only lowercase — fails diversity check
      const result = validatePassword('aaaaaaaa');
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('at least'))).toBe(true);
      expect(result.errors.some(e => e.includes('uppercase'))).toBe(true);
    });

    it('should reject passwords with only one character class (all uppercase)', () => {
      const result = validatePassword('AAAAAAAA');
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('at least'))).toBe(true);
    });

    it('should reject passwords with only one character class (all digits)', () => {
      const result = validatePassword('12345678');
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('at least'))).toBe(true);
    });

    it('should reject passwords with only one character class (all special)', () => {
      const result = validatePassword('!@#$%^&*');
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('at least'))).toBe(true);
    });

    it('error message lists present and missing classes', () => {
      // Only lowercase — missing uppercase, digits, special characters
      const result = validatePassword('aaaaaaaa');
      expect(result.valid).toBe(false);
      const msg = result.errors.find(e => e.includes('at least'));
      expect(msg).toBeDefined();
      expect(msg).toContain('present: lowercase');
      expect(msg).toContain('missing:');
    });

    it('should not apply class check to all-whitespace passwords (whitespace error takes precedence)', () => {
      const result = validatePassword('        ');
      // Must include the whitespace error
      expect(result.errors).toContain('Password cannot be all whitespace');
      // Class diversity error must NOT appear for all-whitespace input
      expect(result.errors.every(e => !e.includes('at least'))).toBe(true);
    });

    it(`should accept password at minimum length with ${MIN_CHARACTER_CLASSES} classes`, () => {
      // 'aA' repeated 4 times = 8 chars, lowercase + uppercase
      const password = 'aA'.repeat(MIN_PASSWORD_LENGTH / 2);
      const result = validatePassword(password);
      expect(result.valid).toBe(true);
    });

    it('should accept password at maximum length', () => {
      // Build a password with both lowercase and digit to satisfy diversity
      const password = ('a1').repeat(MAX_PASSWORD_LENGTH / 2);
      const result = validatePassword(password);
      expect(result.valid).toBe(true);
    });
  });

  describe('detectCharacterClasses', () => {
    it('detects all 4 classes', () => {
      const r = detectCharacterClasses('Abc1!');
      expect(r.hasUppercase).toBe(true);
      expect(r.hasLowercase).toBe(true);
      expect(r.hasDigit).toBe(true);
      expect(r.hasSpecial).toBe(true);
      expect(r.classCount).toBe(4);
    });

    it('detects only lowercase', () => {
      const r = detectCharacterClasses('abcdef');
      expect(r.hasUppercase).toBe(false);
      expect(r.hasLowercase).toBe(true);
      expect(r.hasDigit).toBe(false);
      expect(r.hasSpecial).toBe(false);
      expect(r.classCount).toBe(1);
    });

    it('detects uppercase + digit', () => {
      const r = detectCharacterClasses('ABC123');
      expect(r.hasUppercase).toBe(true);
      expect(r.hasLowercase).toBe(false);
      expect(r.hasDigit).toBe(true);
      expect(r.hasSpecial).toBe(false);
      expect(r.classCount).toBe(2);
    });

    it('treats non-alphanumeric characters as special', () => {
      const r = detectCharacterClasses('abc!@#');
      expect(r.hasSpecial).toBe(true);
    });

    it('returns classCount 0 for empty string', () => {
      const r = detectCharacterClasses('');
      expect(r.classCount).toBe(0);
    });
  });

  describe('MIN_CHARACTER_CLASSES constant', () => {
    it('is 2', () => {
      expect(MIN_CHARACTER_CLASSES).toBe(2);
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
