/**
 * Password Policy Module
 *
 * Centralized password validation and hashing using Argon2id.
 * Uses same security parameters as preshared key hashing.
 *
 * @see M21.1: Password Policy Module
 */

import argon2 from 'argon2';

/**
 * Password length constraints
 */
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;

/**
 * Argon2id parameters (OWASP minimum)
 * Same parameters as used for preshared key hashing
 */
export const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456, // 19MB
  timeCost: 2,
  parallelism: 1,
};

/**
 * Password validation result
 */
export interface PasswordValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate password against policy requirements
 *
 * Requirements:
 * - Minimum 8 characters
 * - Maximum 128 characters
 * - Cannot be all whitespace
 *
 * @param password - Plain text password to validate
 * @returns Validation result with errors list
 */
export function validatePassword(password: string): PasswordValidationResult {
  const errors: string[] = [];

  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    errors.push(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }

  if (password && password.length > MAX_PASSWORD_LENGTH) {
    errors.push(`Password must be at most ${MAX_PASSWORD_LENGTH} characters`);
  }

  if (password && password.trim().length === 0) {
    errors.push('Password cannot be all whitespace');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Hash password using Argon2id
 *
 * @param password - Plain text password
 * @returns Argon2id hash string
 */
export async function hashPassword(password: string): Promise<string> {
  return await argon2.hash(password, ARGON2_OPTIONS);
}

/**
 * Verify password against Argon2id hash
 *
 * @param hash - Argon2id hash string
 * @param password - Plain text password to verify
 * @returns True if password matches hash
 */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    // Invalid hash format or other error
    return false;
  }
}
