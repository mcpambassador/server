/**
 * Argon2id parameters used for every secret hash in the system (admin keys, client preshared keys,
 * user passwords, dev seed passwords). OWASP minimum: 19 MiB memory, 2 iterations, 1 lane.
 *
 * TD-014: one constant, so the values cannot drift apart between call sites. Changing any value is
 * a security-sensitive decision (hashes already stored keep verifying with their own embedded
 * parameters; new hashes use these), so it needs a plan and reviewer sign-off.
 */
import argon2 from 'argon2';

export const ARGON2_OPTIONS: Readonly<{
  type: typeof argon2.argon2id;
  memoryCost: number;
  timeCost: number;
  parallelism: number;
}> = Object.freeze({
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
});
