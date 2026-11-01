/**
 * Local types for ephemeral authentication provider
 */

/**
 * Registration wire types live in @mcpambassador/protocol (single source of truth).
 */
export type { RegistrationRequest, RegistrationResponse } from '@mcpambassador/protocol';

/**
 * Validated client key result
 */
export interface ValidatedClient {
  client_id: string;
  user_id: string;
  profile_id: string;
}

/**
 * Generated session token result
 */
export interface GeneratedSessionToken {
  token: string; // amb_st_...
  tokenHash: string; // hex string for storage
  nonce: string; // hex string for storage
}

/**
 * Verified session context
 */
export interface VerifiedSession {
  session_id: string;
  client_id: string;
  user_id: string;
  profile_id: string;
  connection_id?: string;
  expires_at: string;
}
