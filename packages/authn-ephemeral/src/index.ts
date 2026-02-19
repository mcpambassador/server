/**
 * @mcpambassador/authn-ephemeral
 *
 * Ephemeral Session Authentication Provider (Phase 3)
 *
 * Authenticates clients using preshared keys (amb_pk_*) to establish sessions,
 * then HMAC-based session tokens (amb_st_*) for subsequent requests.
 *
 * @see Architecture §5.1 AuthenticationProvider
 * @see ADR-011 Ephemeral Sessions, User Identity Model & Instance Lifecycle
 */

export { EphemeralAuthProvider } from './provider.js';
export { getOrCreateHmacSecret, persistHmacSecret } from './hmac-secret.js';
export { registerSession, cleanupRateLimitState, type SessionRegConfig } from './registration.js';
export { validateClientKey, generateSessionToken, verifySessionToken } from './token.js';
export type {
  RegistrationRequest,
  RegistrationResponse,
  ValidatedClient,
  GeneratedSessionToken,
  VerifiedSession,
} from './types.js';
