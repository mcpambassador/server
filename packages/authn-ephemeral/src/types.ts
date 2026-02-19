/**
 * Local types for ephemeral authentication provider
 */

/**
 * Registration request body
 */
export interface RegistrationRequest {
  preshared_key: string;
  friendly_name: string;
  host_tool: string;
}

/**
 * Registration response
 */
export interface RegistrationResponse {
  session_id: string;
  session_token: string;
  expires_at: string; // ISO 8601
  profile_id: string;
  connection_id: string;
}

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
  user_id: string;
  profile_id: string;
  connection_id?: string;
  expires_at: string;
}
