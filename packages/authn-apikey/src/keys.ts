/**
 * API Key Generation and Management
 *
 * Utilities for generating, hashing, and validating API keys.
 *
 * Key format: amb_sk_{48_base64url} or amb_ak_{48_base64url}
 * Entropy: 288 bits (36 bytes → 48 base64url chars)
 * Hash: Argon2id (m=19456, t=2, p=1)
 *
 * @see Architecture §9.2 API Key Format
 * @see Security Review checklist M4
 */

import * as argon2 from 'argon2';
import { randomBytes } from 'crypto';

/**
 * Argon2id parameters (OWASP minimum per security review)
 */
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456, // 19MB
  timeCost: 2,
  parallelism: 1,
};

/**
 * Generate API key with specified prefix
 *
 * @param prefix 'amb_sk' (client key) or 'amb_ak' (admin key) or 'amb_rt' (recovery token)
 * @returns API key string (prefix + '_' + 48 base64url chars)
 */
export function generateApiKey(prefix: 'amb_sk' | 'amb_ak' | 'amb_rt'): string {
  // Generate 36 random bytes → 48 base64url characters (288 bits entropy)
  const randomBuffer = randomBytes(36);
  const base64url = randomBuffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

  return `${prefix}_${base64url}`;
}

/**
 * Hash API key with Argon2id
 *
 * @param apiKey Plain API key string
 * @returns Argon2id hash
 */
export async function hashApiKey(apiKey: string): Promise<string> {
  return await argon2.hash(apiKey, ARGON2_OPTIONS);
}

/**
 * Verify API key against hash
 *
 * @param hash Argon2id hash from database
 * @param apiKey Plain API key from request
 * @returns true if valid, false otherwise
 */
export async function verifyApiKey(hash: string, apiKey: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, apiKey);
  } catch {
    return false;
  }
}

/**
 * Validate API key format
 *
 * @param apiKey API key string to validate
 * @param expectedPrefix Expected prefix ('amb_sk', 'amb_ak', 'amb_rt')
 * @returns true if format is valid
 */
export function isValidApiKeyFormat(
  apiKey: string,
  expectedPrefix?: 'amb_sk' | 'amb_ak' | 'amb_rt'
): boolean {
  if (expectedPrefix) {
    return (
      apiKey.startsWith(`${expectedPrefix}_`) && apiKey.length === expectedPrefix.length + 1 + 48
    );
  }

  // Check any valid Ambassador key format
  const prefixes = ['amb_sk_', 'amb_ak_', 'amb_rt_'];
  return prefixes.some(prefix => apiKey.startsWith(prefix) && apiKey.length === prefix.length + 48);
}
