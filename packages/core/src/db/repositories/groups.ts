/**
 * Groups Repository
 *
 * Data access layer for user groups and group membership.
 * Handles group CRUD operations and user-group associations.
 *
 * @see Architecture §3.7 Groups and Access Control
 * @see schema/index.ts groups, user_groups tables
 */

import { eq, and, sql } from 'drizzle-orm';
import type { DatabaseClient } from '../client.js';
import {
  groups,
  user_groups,
  users,
  type Group,
  type NewGroup,
  type UserGroup,
  type NewUserGroup,
} from '../../schema/index.js';
import { v4 as uuidv4 } from 'uuid';
import { compatInsert, compatSelect, compatUpdate, compatDelete } from '../compat.js';

/**
 * Create a new group
 *
 * @param db Database client
 * @param data Group data
 * @returns Created group
 */
export async function createGroup(
  db: DatabaseClient,
  data: Omit<NewGroup, 'group_id' | 'created_at' | 'updated_at'>
): Promise<Group> {
  const now = new Date().toISOString();
  const group_id = uuidv4();

  const newGroup: NewGroup = {
    group_id,
    name: data.name,
    description: data.description || '',
    status: data.status || 'active',
    created_by: data.created_by,
    created_at: now,
    updated_at: now,
  };

  await compatInsert(db, groups).values(newGroup);

  console.log(`[db:groups] Created group: ${group_id} (${newGroup.name})`);

  return newGroup as Group;
}

/**
 * Get group by ID
 *
 * @param db Database client
 * @param group_id Group UUID
 * @returns Group or null if not found
 */
export async function getGroupById(
  db: DatabaseClient,
  group_id: string
): Promise<Group | null> {
  const [group] = await compatSelect(db)
    .from(groups)
    .where(eq(groups.group_id, group_id))
    .limit(1);

  return group || null;
}

/**
 * Get group by name
 *
 * @param db Database client
 * @param name Group name (unique)
 * @returns Group or null if not found
 */
export async function getGroupByName(
  db: DatabaseClient,
  name: string
): Promise<Group | null> {
  const [group] = await compatSelect(db)
    .from(groups)
    .where(eq(groups.name, name))
    .limit(1);

  return group || null;
}

/**
 * List all groups
 *
 * @param db Database client
 * @param pagination Cursor-based pagination
 * @returns Array of groups + pagination metadata
 */
export async function listGroups(
  db: DatabaseClient,
  pagination?: {
    limit?: number;
    cursor?: string; // group name (lexicographic sort)
  }
): Promise<{ groups: Group[]; has_more: boolean; next_cursor?: string }> {
  const limit = pagination?.limit || 25;

  let query = compatSelect(db).from(groups);

  // Cursor pagination (by name ASC)
  if (pagination?.cursor) {
    query = query.where(sql`${groups.name} > ${pagination.cursor}`);
  }

  const results = await query.orderBy(groups.name).limit(limit + 1);

  const has_more = results.length > limit;
  const groupsPage = has_more ? results.slice(0, limit) : results;
  const next_cursor = has_more ? groupsPage[groupsPage.length - 1].name : undefined;

  return {
    groups: groupsPage,
    has_more,
    next_cursor,
  };
}

/**
 * Update group
 *
 * @param db Database client
 * @param group_id Group UUID
 * @param updates Partial group data to update
 */
export async function updateGroup(
  db: DatabaseClient,
  group_id: string,
  updates: Partial<Pick<Group, 'name' | 'description' | 'status'>>
): Promise<void> {
  const now = new Date().toISOString();

  await compatUpdate(db, groups)
    .set({ ...updates, updated_at: now })
    .where(eq(groups.group_id, group_id));

  console.log(`[db:groups] Group updated: ${group_id}`);
}

/**
 * Delete group
 *
 * @param db Database client
 * @param group_id Group UUID
 * @throws Error if group has members (FK constraint CASCADE will remove them)
 */
export async function deleteGroup(db: DatabaseClient, group_id: string): Promise<void> {
  await compatDelete(db, groups).where(eq(groups.group_id, group_id));
  console.log(`[db:groups] Group deleted: ${group_id}`);
}

/**
 * Add user to group
 *
 * @param db Database client
 * @param data User-group association data
 */
export async function addUserToGroup(
  db: DatabaseClient,
  data: { user_id: string; group_id: string; assigned_by: string }
): Promise<void> {
  const now = new Date().toISOString();

  const newUserGroup: NewUserGroup = {
    user_id: data.user_id,
    group_id: data.group_id,
    assigned_at: now,
    assigned_by: data.assigned_by,
  };

  await compatInsert(db, user_groups).values(newUserGroup);

  console.log(`[db:groups] User ${data.user_id} added to group ${data.group_id}`);
}

/**
 * Remove user from group
 *
 * @param db Database client
 * @param user_id User UUID
 * @param group_id Group UUID
 */
export async function removeUserFromGroup(
  db: DatabaseClient,
  user_id: string,
  group_id: string
): Promise<void> {
  await compatDelete(db, user_groups).where(
    and(eq(user_groups.user_id, user_id), eq(user_groups.group_id, group_id))
  );

  console.log(`[db:groups] User ${user_id} removed from group ${group_id}`);
}

/**
 * List all members of a group
 *
 * @param db Database client
 * @param group_id Group UUID
 * @returns Array of enriched group members with user details
 */
export async function listGroupMembers(
  db: DatabaseClient,
  group_id: string
): Promise<Array<{ user_id: string; username: string; display_name: string | null; added_at: string }>> {
  const rows = await compatSelect(db)
    .from(user_groups)
    .innerJoin(users, eq(user_groups.user_id, users.user_id))
    .where(eq(user_groups.group_id, group_id));

  return rows.map((row: any) => ({
    user_id: row.user_groups.user_id,
    username: row.users.username,
    display_name: row.users.display_name ?? null,
    added_at: row.user_groups.assigned_at,
  }));
}

/**
 * List all groups for a user
 *
 * @param db Database client
 * @param user_id User UUID
 * @returns Array of user-group associations
 */
export async function listUserGroups(
  db: DatabaseClient,
  user_id: string
): Promise<UserGroup[]> {
  return compatSelect(db).from(user_groups).where(eq(user_groups.user_id, user_id));
}
