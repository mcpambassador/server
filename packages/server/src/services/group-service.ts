/**
 * Group Service
 *
 * Business logic layer for group management, wrapping core repository functions.
 * Handles validation, error handling, and business rules for group operations.
 *
 * @see M22.1: Group Service Layer
 * @see Architecture §3.7 Groups and Access Control
 */

import type { DatabaseClient } from '@mcpambassador/core';
import {
  createGroup,
  getGroupById,
  getGroupByName,
  listGroups,
  updateGroup,
  deleteGroup,
  addUserToGroup,
  removeUserFromGroup,
  listGroupMembers,
  listUserGroups,
  grantGroupAccess,
  revokeGroupAccess,
  listMcpsForGroup,
  getMcpEntryById,
} from '@mcpambassador/core';
import type { Group, UserGroup, McpCatalogEntry } from '@mcpambassador/core';
import { getUserById } from '../auth/user-auth.js';

/**
 * Create a new group
 *
 * @param db Database client
 * @param data Group creation data
 * @returns Created group
 * @throws Error if group name already exists
 */
export async function createGroupService(
  db: DatabaseClient,
  data: {
    name: string;
    description?: string;
    status?: 'active' | 'suspended';
    created_by: string;
  }
): Promise<Group> {
  // Validate unique name
  const existing = await getGroupByName(db, data.name);
  if (existing) {
    throw new Error(`Group with name '${data.name}' already exists`);
  }

  return createGroup(db, {
    name: data.name,
    description: data.description,
    status: data.status,
    created_by: data.created_by,
  });
}

/**
 * Get group by ID
 *
 * @param db Database client
 * @param groupId Group UUID
 * @returns Group
 * @throws Error if group not found
 */
export async function getGroupService(db: DatabaseClient, groupId: string): Promise<Group> {
  const group = await getGroupById(db, groupId);
  if (!group) {
    throw new Error(`Group not found: ${groupId}`);
  }
  return group;
}

/**
 * List groups with cursor pagination
 *
 * @param db Database client
 * @param pagination Pagination options
 * @returns Groups and pagination metadata
 */
export async function listGroupsService(
  db: DatabaseClient,
  pagination?: { limit?: number; cursor?: string }
): Promise<{ groups: Group[]; has_more: boolean; next_cursor?: string }> {
  return listGroups(db, pagination);
}

/**
 * Update group
 *
 * @param db Database client
 * @param groupId Group UUID
 * @param updates Partial group data to update
 * @throws Error if group not found
 */
export async function updateGroupService(
  db: DatabaseClient,
  groupId: string,
  updates: Partial<Pick<Group, 'name' | 'description' | 'status'>>
): Promise<void> {
  // Check group exists
  const group = await getGroupById(db, groupId);
  if (!group) {
    throw new Error(`Group not found: ${groupId}`);
  }

  // If updating name, validate uniqueness
  if (updates.name && updates.name !== group.name) {
    const existing = await getGroupByName(db, updates.name);
    if (existing) {
      throw new Error(`Group with name '${updates.name}' already exists`);
    }
  }

  await updateGroup(db, groupId, updates);
}

/**
 * Delete group
 *
 * @param db Database client
 * @param groupId Group UUID
 * @throws Error if group not found or is "all-users"
 */
export async function deleteGroupService(db: DatabaseClient, groupId: string): Promise<void> {
  const group = await getGroupById(db, groupId);
  if (!group) {
    throw new Error(`Group not found: ${groupId}`);
  }

  // Prevent deletion of "all-users" group
  if (group.name === 'all-users') {
    throw new Error('Cannot delete the "all-users" group');
  }

  await deleteGroup(db, groupId);
}

/**
 * Add user to group
 *
 * @param db Database client
 * @param data User-group association data
 * @throws Error if user or group not found, or user already in group
 */
export async function addUserToGroupService(
  db: DatabaseClient,
  data: { user_id: string; group_id: string; assigned_by: string }
): Promise<void> {
  // Validate group exists
  const group = await getGroupById(db, data.group_id);
  if (!group) {
    throw new Error(`Group not found: ${data.group_id}`);
  }

  // Validate user exists (GRP-001: use repository function)
  const user = await getUserById(db, data.user_id);
  if (!user) {
    throw new Error(`User not found: ${data.user_id}`);
  }

  // Check for duplicate membership
  const userGroups = await listUserGroups(db, data.user_id);
  if (userGroups.some(ug => ug.group_id === data.group_id)) {
    throw new Error(`User ${data.user_id} is already a member of group ${data.group_id}`);
  }

  await addUserToGroup(db, data);
}

/**
 * Remove user from group
 *
 * @param db Database client
 * @param userId User UUID
 * @param groupId Group UUID
 * @throws Error if trying to remove from "all-users" when it's the only group
 */
export async function removeUserFromGroupService(
  db: DatabaseClient,
  userId: string,
  groupId: string
): Promise<void> {
  // Get the group
  const group = await getGroupById(db, groupId);
  if (!group) {
    throw new Error(`Group not found: ${groupId}`);
  }

  // Get user's groups
  const userGroups = await listUserGroups(db, userId);

  // Prevent removing from "all-users" if it's the only group
  if (group.name === 'all-users' && userGroups.length === 1) {
    throw new Error('Cannot remove user from "all-users" when it is their only group');
  }

  await removeUserFromGroup(db, userId, groupId);
}

/**
 * List members of a group
 *
 * @param db Database client
 * @param groupId Group UUID
 * @returns Array of user-group associations
 */
export async function listGroupMembersService(
  db: DatabaseClient,
  groupId: string
): Promise<
  Array<{ user_id: string; username: string; display_name: string | null; added_at: string }>
> {
  return listGroupMembers(db, groupId);
}

/**
 * Get all groups for a user (M22.3: group resolution)
 *
 * @param db Database client
 * @param userId User UUID
 * @returns Array of user-group associations
 */
export async function getUserGroupsService(
  db: DatabaseClient,
  userId: string
): Promise<UserGroup[]> {
  return listUserGroups(db, userId);
}

/**
 * Assign MCP to group
 *
 * @param db Database client
 * @param data MCP-group assignment data
 * @throws Error if MCP or group not found, or already assigned
 */
export async function assignMcpToGroupService(
  db: DatabaseClient,
  data: { mcp_id: string; group_id: string; assigned_by: string }
): Promise<void> {
  // Validate MCP exists (GRP-001: use repository function)
  const mcp = await getMcpEntryById(db, data.mcp_id);
  if (!mcp) {
    throw new Error(`MCP not found: ${data.mcp_id}`);
  }

  // Validate group exists
  const group = await getGroupById(db, data.group_id);
  if (!group) {
    throw new Error(`Group not found: ${data.group_id}`);
  }

  // Check for duplicate assignment
  const mcps = await listMcpsForGroup(db, data.group_id);
  if (mcps.some(m => m.mcp_id === data.mcp_id)) {
    throw new Error(`MCP ${data.mcp_id} is already assigned to group ${data.group_id}`);
  }

  await grantGroupAccess(db, data);
}

/**
 * Remove MCP from group
 *
 * @param db Database client
 * @param mcpId MCP UUID
 * @param groupId Group UUID
 */
export async function removeMcpFromGroupService(
  db: DatabaseClient,
  mcpId: string,
  groupId: string
): Promise<void> {
  await revokeGroupAccess(db, mcpId, groupId);
}

/**
 * List MCPs accessible to a group
 *
 * @param db Database client
 * @param groupId Group UUID
 * @returns Array of MCP-group access associations
 */
export async function listMcpsForGroupService(
  db: DatabaseClient,
  groupId: string
): Promise<McpCatalogEntry[]> {
  return listMcpsForGroup(db, groupId);
}
