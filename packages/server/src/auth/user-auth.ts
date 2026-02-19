/**
 * User Authentication Service
 *
 * Core business logic for user authentication and password management.
 * Handles user lookup, password verification, and user CRUD operations.
 *
 * @see M21.2: User Auth Service
 */

import { eq } from 'drizzle-orm';
import { users, type User, compatInsert, compatUpdate } from '@mcpambassador/core';
import type { DatabaseClient } from '@mcpambassador/core';
import { hashPassword, verifyPassword } from './password-policy.js';
import { v4 as uuidv4 } from 'uuid';
import { getGroupByName, addUserToGroup } from '@mcpambassador/core';

/**
 * Pre-computed dummy hash for timing attack mitigation
 * H-1: Used when user not found or has null password to equalize response times
 *
 * This is an argon2id hash of "dummy-password-for-timing-safety"
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$aR5kZXNpZ25lZC1mb3ItdGltaW5nLXNhZmV0eQ$9xQZJ5kLZ5YzJ5kLZ5YzJ5kLZ5YzJ5kLZ5Yz';

/**
 * Authenticate user with username and password
 *
 * @param db - Database client
 * @param username - Username
 * @param password - Plain text password
 * @returns User record if credentials are valid, null otherwise
 */
export async function authenticateUser(
  db: DatabaseClient,
  username: string,
  password: string
): Promise<User | null> {
  // Look up user by username
  const user = await db.query.users.findFirst({
    where: (users, { eq }) => eq(users.username, username),
  });

  // H-1: Timing attack mitigation - always run password verification to equalize response time
  if (!user) {
    // User not found - run dummy verify to prevent username enumeration via timing
    await verifyPassword(DUMMY_HASH, password);
    return null;
  }

  // M-1: Check user status - deactivated/suspended users cannot authenticate
  if (user.status !== 'active') {
    // Still run password verification to prevent status enumeration via timing
    await verifyPassword(DUMMY_HASH, password);
    return null;
  }

  // Check if user has a password hash
  if (!user.password_hash) {
    // No password set - run dummy verify to prevent detection via timing
    await verifyPassword(DUMMY_HASH, password);
    return null;
  }

  // Verify password
  const isValid = await verifyPassword(user.password_hash, password);
  if (!isValid) {
    return null;
  }

  return user;
}

/**
 * Create new user with password
 *
 * @param db - Database client
 * @param data - User creation data
 * @returns Created user record
 */
export async function createUser(
  db: DatabaseClient,
  data: {
    username: string;
    password: string;
    display_name: string;
    email?: string;
    is_admin?: boolean;
    created_by?: string;
  }
): Promise<User> {
  const passwordHash = await hashPassword(data.password);
  const timestamp = new Date().toISOString();

  const userId = uuidv4();

  await compatInsert(db, users).values({
    user_id: userId,
    username: data.username,
    password_hash: passwordHash,
    display_name: data.display_name,
    email: data.email ?? null,
    is_admin: data.is_admin ?? false,
    status: 'active',
    auth_source: 'local',
    created_at: timestamp,
    updated_at: timestamp,
    last_login_at: null,
    vault_salt: null,
    metadata: '{}',
  });

  const user = await db.query.users.findFirst({
    where: (users, { eq }) => eq(users.user_id, userId),
  });

  if (!user) {
    throw new Error('Failed to create user');
  }

  // M22.4: Auto-assign new user to "all-users" group
  try {
    const allUsersGroup = await getGroupByName(db, 'all-users');
    if (allUsersGroup) {
      await addUserToGroup(db, {
        user_id: userId,
        group_id: allUsersGroup.group_id,
        assigned_by: data.created_by || 'system',
      });
    }
  } catch (err) {
    // Log error but don't fail user creation if group assignment fails
    console.error('[user-auth] Failed to assign user to all-users group:', err);
  }

  return user;
}

/**
 * Update user password
 *
 * @param db - Database client
 * @param userId - User ID
 * @param newPassword - New plain text password
 */
export async function updateUserPassword(
  db: DatabaseClient,
  userId: string,
  newPassword: string
): Promise<void> {
  const passwordHash = await hashPassword(newPassword);
  const timestamp = new Date().toISOString();

  await compatUpdate(db, users)
    .set({
      password_hash: passwordHash,
      updated_at: timestamp,
    })
    .where(eq(users.user_id, userId));
}

/**
 * Get user by ID
 *
 * @param db - Database client
 * @param userId - User ID
 * @returns User record or null
 */
export async function getUserById(db: DatabaseClient, userId: string): Promise<User | null> {
  const user = await db.query.users.findFirst({
    where: (users, { eq }) => eq(users.user_id, userId),
  });

  return user ?? null;
}

/**
 * Get user by username
 *
 * @param db - Database client
 * @param username - Username
 * @returns User record or null
 */
export async function getUserByUsername(
  db: DatabaseClient,
  username: string
): Promise<User | null> {
  const user = await db.query.users.findFirst({
    where: (users, { eq }) => eq(users.username, username),
  });

  return user ?? null;
}
