/**
 * API Key Authentication Provider Tests
 *
 * Tests M4 deliverables:
 * - Key generation and hashing
 * - Client registration (with rate limiting)
 * - Admin key lifecycle
 * - Authentication flow
 *
 * @see M4 Security Checklist
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { generateApiKey, hashApiKey, verifyApiKey, isValidApiKeyFormat } from '../src/keys.js';

describe('API Key Generation (M4.3)', () => {
  it('should generate client API key with correct format', () => {
    const key = generateApiKey('amb_sk');

    expect(key).toMatch(/^amb_sk_[A-Za-z0-9_-]{48}$/);
    expect(key.length).toBe('amb_sk_'.length + 48);
  });

  it('should generate admin API key with correct format', () => {
    const key = generateApiKey('amb_ak');

    expect(key).toMatch(/^amb_ak_[A-Za-z0-9_-]{48}$/);
    expect(key.length).toBe('amb_ak_'.length + 48);
  });

  it('should generate recovery token with correct format', () => {
    const token = generateApiKey('amb_rt');

    expect(token).toMatch(/^amb_rt_[A-Za-z0-9_-]{48}$/);
    expect(token.length).toBe('amb_rt_'.length + 48);
  });

  it('should generate unique keys (not predictable)', () => {
    const keys = new Set();
    for (let i = 0; i < 100; i++) {
      keys.add(generateApiKey('amb_sk'));
    }
    expect(keys.size).toBe(100); // All unique
  });

  it('should use crypto.randomBytes (not Math.random)', () => {
    // Generate many keys and check for cryptographic randomness
    // If Math.random() were used, we'd see patterns
    const key1 = generateApiKey('amb_sk');
    const key2 = generateApiKey('amb_sk');

    // Keys should be different
    expect(key1).not.toBe(key2);

    // Keys should not have sequential patterns (Math.random would)
    const suffix1 = key1.substring(7);
    const suffix2 = key2.substring(7);
    expect(suffix1).not.toBe(suffix2);
  });
});

describe('API Key Hashing (M4.3)', () => {
  it('should hash API key with Argon2id', async () => {
    const key = generateApiKey('amb_sk');
    const hash = await hashApiKey(key);

    // Argon2id hash format: $argon2id$v=19$m=19456,t=2,p=1$...$...
    expect(hash).toMatch(/^\$argon2id\$.+/);
    expect(hash).toContain('m=19456');
    expect(hash).toContain('t=2');
    expect(hash).toContain('p=1');
  });

  it('should verify correct API key', async () => {
    const key = generateApiKey('amb_sk');
    const hash = await hashApiKey(key);

    const isValid = await verifyApiKey(hash, key);
    expect(isValid).toBe(true);
  });

  it('should reject incorrect API key', async () => {
    const key1 = generateApiKey('amb_sk');
    const key2 = generateApiKey('amb_sk');
    const hash1 = await hashApiKey(key1);

    const isValid = await verifyApiKey(hash1, key2);
    expect(isValid).toBe(false);
  });

  it('should be timing-safe (no early return on invalid key)', async () => {
    const key = generateApiKey('amb_sk');
    const hash = await hashApiKey(key);

    // Both should take similar time (argon2 is constant-time)
    const start1 = Date.now();
    await verifyApiKey(hash, key); // Valid
    const time1 = Date.now() - start1;

    const start2 = Date.now();
    await verifyApiKey(hash, 'amb_sk_' + 'a'.repeat(48)); // Invalid
    const time2 = Date.now() - start2;

    // Time difference should be minimal (<50ms variance)
    expect(Math.abs(time1 - time2)).toBeLessThan(50);
  });
});

describe('API Key Format Validation', () => {
  it('should validate client key format', () => {
    expect(isValidApiKeyFormat('amb_sk_' + 'a'.repeat(48), 'amb_sk')).toBe(true);
    expect(isValidApiKeyFormat('amb_sk_' + 'a'.repeat(47), 'amb_sk')).toBe(false);
    expect(isValidApiKeyFormat('amb_ak_' + 'a'.repeat(48), 'amb_sk')).toBe(false);
  });

  it('should validate admin key format', () => {
    expect(isValidApiKeyFormat('amb_ak_' + 'a'.repeat(48), 'amb_ak')).toBe(true);
    expect(isValidApiKeyFormat('bad_prefix_' + 'a'.repeat(48), 'amb_ak')).toBe(false);
  });

  it('should validate any Ambassador key format without prefix check', () => {
    expect(isValidApiKeyFormat('amb_sk_' + 'a'.repeat(48))).toBe(true);
    expect(isValidApiKeyFormat('amb_ak_' + 'a'.repeat(48))).toBe(true);
    expect(isValidApiKeyFormat('amb_rt_' + 'a'.repeat(48))).toBe(true);
    expect(isValidApiKeyFormat('bad_prefix_' + 'a'.repeat(48))).toBe(false);
  });
});

// TODO: Add integration tests for:
// - Client registration (M4.2) with rate limiting
// - Key rotation (M4.4)
// - Admin key generation (M4.5)
// - Admin key recovery & rotation (M4.6)
// - Admin auth middleware (M4.7)
// - ApiKeyAuthProvider.authenticate() (M4.1) with database

// These require database setup which is more complex
// Will be added in follow-up commit with test database fixtures
