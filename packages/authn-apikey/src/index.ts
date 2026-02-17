/**
 * @mcpambassador/authn-apikey
 *
 * API Key Authentication Provider (Phase 1)
 *
 * Authenticates clients using X-API-Key header with Argon2id-hashed keys.
 * Validates against the clients table in the database.
 *
 * @see Architecture §5.1 AuthenticationProvider
 * @see Architecture §9.2 API Key Authentication
 */

export { ApiKeyAuthProvider } from './provider.js';
export { generateApiKey, hashApiKey, verifyApiKey, isValidApiKeyFormat } from './keys.js';
export {
  registerClient,
  type RegisterClientRequest,
  type RegisterClientResponse,
} from './registration.js';
export { rotateClientKey, type RotateKeyResponse } from './rotation.js';
export {
  generateAdminKey,
  recoverAdminKey,
  rotateAdminKey,
  factoryResetAdminKey,
  type AdminKeyRecord,
  type AdminKeyGeneration,
} from './admin/keys.js';
export { authenticateAdmin, type AdminAuthResult } from './admin/middleware.js';

// Utilities
export { RateLimiter } from './utils/rate-limiter.js';
export { hashIp, redactIp } from './utils/privacy.js';
