/**
 * Password Policy Module
 *
 * Centralized password validation and hashing using Argon2id.
 * Uses same security parameters as preshared key hashing.
 *
 * @see M21.1: Password Policy Module
 * @see dev-plan-v0.9.1.md A.4 Password Policy Strengthening
 */

import argon2 from 'argon2';

/**
 * Password length constraints
 */
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;

/**
 * Minimum number of distinct character classes required in a password.
 * Classes: uppercase, lowercase, digits, special characters.
 */
export const MIN_CHARACTER_CLASSES = 2;

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
 * Determine which of the 4 character classes are present in a password.
 *
 * The 4 classes are:
 *   1. Uppercase letters  (A-Z)
 *   2. Lowercase letters  (a-z)
 *   3. Digits             (0-9)
 *   4. Special characters (anything outside the above 3)
 *
 * @param password - Plain text password to inspect
 * @returns Object with a boolean per class and the total count of present classes
 */
export function detectCharacterClasses(password: string): {
  hasUppercase: boolean;
  hasLowercase: boolean;
  hasDigit: boolean;
  hasSpecial: boolean;
  classCount: number;
} {
  const hasUppercase = /[A-Z]/.test(password);
  const hasLowercase = /[a-z]/.test(password);
  const hasDigit = /[0-9]/.test(password);
  const hasSpecial = /[^A-Za-z0-9]/.test(password);

  const classCount = [hasUppercase, hasLowercase, hasDigit, hasSpecial].filter(Boolean).length;

  return { hasUppercase, hasLowercase, hasDigit, hasSpecial, classCount };
}

/**
 * Validate password against policy requirements.
 *
 * Requirements:
 * - Minimum 8 characters
 * - Maximum 128 characters
 * - Cannot be all whitespace
 * - Must contain characters from at least 2 of 4 classes:
 *     uppercase letters, lowercase letters, digits, special characters
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

  // Character class diversity check — only meaningful when the password has content
  if (password && password.trim().length > 0) {
    const { hasUppercase, hasLowercase, hasDigit, hasSpecial, classCount } =
      detectCharacterClasses(password);

    if (classCount < MIN_CHARACTER_CLASSES) {
      const present: string[] = [];
      const missing: string[] = [];

      (
        [
          [hasUppercase, 'uppercase'],
          [hasLowercase, 'lowercase'],
          [hasDigit, 'digits'],
          [hasSpecial, 'special characters'],
        ] as [boolean, string][]
      ).forEach(([has, label]) => {
        if (has) {
          present.push(label);
        } else {
          missing.push(label);
        }
      });

      const presentStr = present.length > 0 ? ` (present: ${present.join(', ')})` : '';
      const missingStr = missing.length > 0 ? `, missing: ${missing.join(', ')}` : '';

      errors.push(
        `Password must contain characters from at least ${MIN_CHARACTER_CLASSES} of: ` +
          `uppercase, lowercase, digits, special characters` +
          `${presentStr}${missingStr}`
      );
    }
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
