/** Test helper: seed a real user + group and grant the user the given MCPs (ADR-025 M2 call-time check). */
import {
  compatInsert,
  createGroup,
  addUserToGroup,
  grantGroupAccess,
  users,
  type DatabaseClient,
} from '@mcpambassador/core';

export async function seedUserGrants(
  db: DatabaseClient,
  userId: string,
  mcpIds: string[],
  groupName = `grp-${userId}`
): Promise<{ groupId: string }> {
  const now = new Date().toISOString();
  await compatInsert(db, users).values({
    user_id: userId,
    username: `user-${userId}`,
    display_name: userId,
    created_at: now,
    updated_at: now,
  } as never);
  return grantExistingUser(db, userId, mcpIds, groupName);
}

/** Grant an ALREADY-EXISTING user the given MCPs through a fresh active group. */
export async function grantExistingUser(
  db: DatabaseClient,
  userId: string,
  mcpIds: string[],
  groupName = `grp-${userId}`
): Promise<{ groupId: string }> {
  const group = await createGroup(db, {
    name: groupName,
    description: '',
    created_by: 'test',
  } as never);
  await addUserToGroup(db, { user_id: userId, group_id: group.group_id, assigned_by: 'test' });
  for (const mcp_id of mcpIds) {
    await grantGroupAccess(db, { mcp_id, group_id: group.group_id, assigned_by: 'test' });
  }
  return { groupId: group.group_id };
}
