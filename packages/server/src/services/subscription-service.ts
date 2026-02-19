/**
 * Subscription Service
 *
 * Business logic layer for client MCP subscriptions.
 * Handles subscription CRUD with access control and validation.
 *
 * @see M25.2: Subscription Service
 * @see Architecture §4.2 Client Subscription Management
 */

import type { DatabaseClient } from '@mcpambassador/core';
import {
  createSubscription,
  getSubscription,
  listSubscriptionsForClient,
  updateSubscription as updateSubscriptionRepo,
  listUserGroups,
  listMcpsForGroup,
  getMcpEntryById,
  getCredential,
  mcp_catalog,
  compatSelect,
} from '@mcpambassador/core';
import { getUserClient } from './client-service.js';
import { inArray } from 'drizzle-orm';

export interface SubscriptionWithMcp {
  subscription_id: string;
  client_id: string;
  mcp_id: string;
  mcp_name: string;
  selected_tools: string[];
  status: 'active' | 'paused' | 'removed';
  subscribed_at: string;
  updated_at: string;
}

/**
 * Subscribe a client to an MCP with validation
 *
 * @param db Database client
 * @param data Subscription data
 * @returns Created subscription
 * @throws Error if validation fails
 */
export async function subscribeClientToMcp(
  db: DatabaseClient,
  data: {
    userId: string;
    clientId: string;
    mcpId: string;
    selectedTools?: string[];
  }
) {
  // Verify client belongs to user
  await getUserClient(db, data.userId, data.clientId);

  // Verify MCP exists and is published
  const mcp = await getMcpEntryById(db, data.mcpId);
  if (!mcp) {
    throw new Error('MCP not found');
  }

  if (mcp.status !== 'published') {
    throw new Error('MCP is not published');
  }

  // Verify user has group access to this MCP
  const userGroups = await listUserGroups(db, data.userId);
  const groupIds = userGroups.map(g => g.group_id);

  let hasAccess = false;
  for (const groupId of groupIds) {
    const mcpAccesses = await listMcpsForGroup(db, groupId);
    if (mcpAccesses.some(access => access.mcp_id === data.mcpId)) {
      hasAccess = true;
      break;
    }
  }

  if (!hasAccess) {
    throw new Error('User does not have access to this MCP');
  }

  // If MCP requires user credentials, verify they exist
  if (mcp.requires_user_credentials) {
    const credential = await getCredential(db, data.userId, data.mcpId);
    if (!credential) {
      throw new Error('MCP requires user credentials, but none are stored');
    }
  }

  // Check for duplicate subscription (same client+mcp, not removed)
  const existingSubscriptions = await listSubscriptionsForClient(db, data.clientId);
  const duplicate = existingSubscriptions.find(
    sub => sub.mcp_id === data.mcpId && sub.status !== 'removed'
  );

  if (duplicate) {
    throw new Error('Client is already subscribed to this MCP');
  }

  // Create subscription
  return createSubscription(db, {
    client_id: data.clientId,
    mcp_id: data.mcpId,
    selected_tools: data.selectedTools,
  });
}

/**
 * Update a subscription with ownership validation
 *
 * @param db Database client
 * @param data Update data
 */
export async function updateSubscription(
  db: DatabaseClient,
  data: {
    userId: string;
    clientId: string;
    subscriptionId: string;
    selectedTools?: string[];
    status?: 'active' | 'paused' | 'removed';
  }
): Promise<void> {
  // Verify client belongs to user
  await getUserClient(db, data.userId, data.clientId);

  // Verify subscription belongs to client
  const subscription = await getSubscription(db, data.subscriptionId);
  if (!subscription) {
    throw new Error('Subscription not found');
  }

  if (subscription.client_id !== data.clientId) {
    throw new Error('Subscription does not belong to this client');
  }

  // Update subscription
  await updateSubscriptionRepo(db, data.subscriptionId, {
    selected_tools: data.selectedTools,
    status: data.status,
  });

  console.log(`[SubscriptionService] Updated subscription ${data.subscriptionId}`);
}

/**
 * List subscriptions for a client with MCP names
 *
 * @param db Database client
 * @param data Query data
 * @returns Array of subscriptions with MCP details
 */
export async function listClientSubscriptions(
  db: DatabaseClient,
  data: {
    userId: string;
    clientId: string;
  }
): Promise<SubscriptionWithMcp[]> {
  // Verify client belongs to user
  await getUserClient(db, data.userId, data.clientId);

  // Get subscriptions
  const subscriptions = await listSubscriptionsForClient(db, data.clientId);

  // CR-M3: Fix N+1 query - batch-fetch MCP entries by IDs
  const mcpIds = subscriptions.map(sub => sub.mcp_id);
  const mcpMap = new Map<string, { name: string }>();

  if (mcpIds.length > 0) {
    const mcps = await compatSelect(db)
      .from(mcp_catalog)
      .where(inArray(mcp_catalog.mcp_id, mcpIds));

    for (const mcp of mcps) {
      mcpMap.set(mcp.mcp_id, { name: mcp.name });
    }
  }

  // Enrich with MCP names
  const enriched: SubscriptionWithMcp[] = [];
  for (const sub of subscriptions) {
    const mcp = mcpMap.get(sub.mcp_id);
    if (mcp) {
      enriched.push({
        subscription_id: sub.subscription_id,
        client_id: sub.client_id,
        mcp_id: sub.mcp_id,
        mcp_name: mcp.name,
        selected_tools: typeof sub.selected_tools === 'string' 
          ? JSON.parse(sub.selected_tools)
          : sub.selected_tools,
        status: sub.status,
        subscribed_at: sub.subscribed_at,
        updated_at: sub.updated_at,
      });
    }
  }

  return enriched;
}

/**
 * Get subscription detail with ownership validation
 *
 * @param db Database client
 * @param data Query data
 * @returns Subscription with MCP details
 */
export async function getSubscriptionDetail(
  db: DatabaseClient,
  data: {
    userId: string;
    clientId: string;
    subscriptionId: string;
  }
): Promise<SubscriptionWithMcp> {
  // Verify client belongs to user
  await getUserClient(db, data.userId, data.clientId);

  // Get subscription and verify it belongs to client
  const subscription = await getSubscription(db, data.subscriptionId);
  if (!subscription) {
    throw new Error('Subscription not found');
  }

  if (subscription.client_id !== data.clientId) {
    throw new Error('Subscription does not belong to this client');
  }

  // Get MCP details
  const mcp = await getMcpEntryById(db, subscription.mcp_id);
  if (!mcp) {
    throw new Error('MCP not found');
  }

  return {
    subscription_id: subscription.subscription_id,
    client_id: subscription.client_id,
    mcp_id: subscription.mcp_id,
    mcp_name: mcp.name,
    selected_tools: typeof subscription.selected_tools === 'string'
      ? JSON.parse(subscription.selected_tools)
      : subscription.selected_tools,
    status: subscription.status,
    subscribed_at: subscription.subscribed_at,
    updated_at: subscription.updated_at,
  };
}

/**
 * Remove a subscription with ownership validation
 *
 * @param db Database client
 * @param data Query data
 */
export async function removeSubscription(
  db: DatabaseClient,
  data: {
    userId: string;
    clientId: string;
    subscriptionId: string;
  }
): Promise<void> {
  // Verify client belongs to user
  await getUserClient(db, data.userId, data.clientId);

  // Verify subscription belongs to client
  const subscription = await getSubscription(db, data.subscriptionId);
  if (!subscription) {
    throw new Error('Subscription not found');
  }

  if (subscription.client_id !== data.clientId) {
    throw new Error('Subscription does not belong to this client');
  }

  // Soft delete: mark as removed
  await updateSubscriptionRepo(db, data.subscriptionId, {
    status: 'removed',
  });

  console.log(`[SubscriptionService] Removed subscription ${data.subscriptionId}`);
}
