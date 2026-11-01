/**
 * ADR-020 token/code primitives. Raw secrets are returned to the caller exactly once and only
 * their SHA-256 hash is persisted. Never log a raw value; use `logPrefix`.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { TOKEN_LOG_PREFIX_LENGTH } from '@mcpambassador/contracts';

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** `<prefix><43 chars base64url>` (256 bits of entropy) */
export function generateToken(prefix: string): string {
  return prefix + randomBytes(32).toString('base64url');
}

/** Safe-to-log identifier derived from the HASH, not the raw token */
export function logPrefix(raw: string): string {
  return hashToken(raw).slice(0, TOKEN_LOG_PREFIX_LENGTH);
}

/** RFC 7636 S256: BASE64URL(SHA256(verifier)) === challenge, constant time */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  const computed = Buffer.from(createHash('sha256').update(verifier).digest('base64url'));
  const expected = Buffer.from(challenge);
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}
