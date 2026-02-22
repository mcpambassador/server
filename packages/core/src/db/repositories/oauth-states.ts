/**
 * OAuth States Repository
 *
 * Data access layer for OAuth 2.0 authorization flow state management.
 * Manages temporary state records used during OAuth flows with PKCE.
 *
 * @see ADR-014: Generic OAuth 2.0 Downstream Credentials
 * @see schema/index.ts oauth_states table
 */

import { eq, and, lt, gt } from 'drizzle-orm';
import type { DatabaseClient } from '../client.js';
import {
  oauth_states,
  type OAuthState,
  type NewOAuthState,
} from '../../schema/index.js';
import { compatInsert, compatSelect, compatDelete, compatTransaction } from '../compat.js';

/**
 * Create a new OAuth state record
 *
 * NOTE: Unlike other repositories, this does NOT generate the state UUID.
 * The caller must supply the state parameter (typically a UUID v4).
 *
 * @param db Database client
 * @param data OAuth state data with caller-generated state UUID
 * @returns Created state record
 */
export async function createOAuthState(
  db: DatabaseClient,
  data: NewOAuthState
): Promise<OAuthState> {
  await compatInsert(db, oauth_states).values(data);

  console.log(
    `[db:oauth-states] Created state: ${data.state} (user ${data.user_id} -> MCP ${data.mcp_id})`
  );

  return data as OAuthState;
}

/**
 * Get OAuth state by state parameter
 *
 * @param db Database client
 * @param state State UUID
 * @returns OAuth state or null if not found
 */
export async function getOAuthState(
  db: DatabaseClient,
  state: string
): Promise<OAuthState | null> {
  const [stateRecord] = await compatSelect(db)
    .from(oauth_states)
    .where(eq(oauth_states.state, state))
    .limit(1);

  return stateRecord || null;
}

/**
 * Consume OAuth state (atomic get-and-delete)
 *
 * This ensures single-use of state tokens by atomically retrieving
 * and deleting the state record. Returns null if not found or expired.
 *
 * @param db Database client
 * @param state State UUID
 * @returns OAuth state or null if not found/expired
 */
export async function consumeOAuthState(
  db: DatabaseClient,
  state: string
): Promise<OAuthState | null> {
  return compatTransaction(db, async () => {
    const now = new Date().toISOString();
    const [stateRecord] = await compatSelect(db)
      .from(oauth_states)
      .where(
        and(
          eq(oauth_states.state, state),
          gt(oauth_states.expires_at, now)
        )
      )
      .limit(1);

    if (!stateRecord) {
      return null;
    }

    // Delete it (single-use) — inside transaction guarantees atomicity
    await compatDelete(db, oauth_states).where(eq(oauth_states.state, state));

    console.log(`[db:oauth-states] Consumed state: ${state}`);

    return stateRecord;
  });
}

/**
 * Clean up expired OAuth states
 *
 * Removes all state records where expires_at < now.
 * Should be called periodically (e.g., every 5 minutes).
 *
 * @param db Database client
 * @returns Count of deleted rows
 */
export async function cleanupExpiredStates(db: DatabaseClient): Promise<number> {
  const now = new Date().toISOString();

  // Get count before deletion
  const expiredStates = await compatSelect(db)
    .from(oauth_states)
    .where(lt(oauth_states.expires_at, now));

  const count = expiredStates.length;

  if (count > 0) {
    await compatDelete(db, oauth_states).where(lt(oauth_states.expires_at, now));
    console.log(`[db:oauth-states] Cleaned up ${count} expired state(s)`);
  }

  return count;
}

/**
 * Delete all OAuth states for a user
 *
 * Used during user deletion or cleanup operations.
 *
 * @param db Database client
 * @param userId User UUID
 */
export async function deleteOAuthStatesForUser(
  db: DatabaseClient,
  userId: string
): Promise<void> {
  await compatDelete(db, oauth_states).where(eq(oauth_states.user_id, userId));

  console.log(`[db:oauth-states] Deleted all states for user ${userId}`);
}
