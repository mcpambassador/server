/**
 * Client MCP Subscriptions Repository
 *
 * Data access layer for client MCP subscriptions.
 * Tracks which MCPs each client subscribes to and their tool selections.
 *
 * @see Architecture §4.2 Client Subscription Management
 * @see schema/index.ts client_mcp_subscriptions table
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any */
/* eslint-disable no-console, @typescript-eslint/require-await */

import { eq } from 'drizzle-orm';
import type { DatabaseClient } from '../client.js';
import {
  client_mcp_subscriptions,
  type ClientMcpSubscription,
  type NewClientMcpSubscription,
} from '../../schema/index.js';
import { v4 as uuidv4 } from 'uuid';
import { compatInsert, compatSelect, compatUpdate, compatDelete } from '../compat.js';

/**
 * Create a new subscription
 *
 * @param db Database client
 * @param data Subscription data
 * @returns Created subscription
 */
export async function createSubscription(
  db: DatabaseClient,
  data: { client_id: string; mcp_id: string; selected_tools?: string[] }
): Promise<ClientMcpSubscription> {
  const now = new Date().toISOString();
  const subscription_id = uuidv4();

  const newSubscription: NewClientMcpSubscription = {
    subscription_id,
    client_id: data.client_id,
    mcp_id: data.mcp_id,
    selected_tools: JSON.stringify(data.selected_tools || []),
    status: 'active',
    subscribed_at: now,
    updated_at: now,
  };

  await compatInsert(db, client_mcp_subscriptions).values(newSubscription);

  console.log(
    `[db:subscriptions] Created subscription: ${subscription_id} (client ${data.client_id} -> MCP ${data.mcp_id})`
  );

  return newSubscription as ClientMcpSubscription;
}

/**
 * Get subscription by ID
 *
 * @param db Database client
 * @param subscription_id Subscription UUID
 * @returns Subscription or null if not found
 */
export async function getSubscription(
  db: DatabaseClient,
  subscription_id: string
): Promise<ClientMcpSubscription | null> {
  const [subscription] = await compatSelect(db)
    .from(client_mcp_subscriptions)
    .where(eq(client_mcp_subscriptions.subscription_id, subscription_id))
    .limit(1);

  return subscription || null;
}

/**
 * List all subscriptions for a client
 *
 * @param db Database client
 * @param client_id Client UUID
 * @returns Array of subscriptions
 */
export async function listSubscriptionsForClient(
  db: DatabaseClient,
  client_id: string
): Promise<ClientMcpSubscription[]> {
  return compatSelect(db)
    .from(client_mcp_subscriptions)
    .where(eq(client_mcp_subscriptions.client_id, client_id));
}

/**
 * List all subscriptions for an MCP
 *
 * @param db Database client
 * @param mcp_id MCP UUID
 * @returns Array of subscriptions
 */
export async function listSubscriptionsForMcp(
  db: DatabaseClient,
  mcp_id: string
): Promise<ClientMcpSubscription[]> {
  return compatSelect(db)
    .from(client_mcp_subscriptions)
    .where(eq(client_mcp_subscriptions.mcp_id, mcp_id));
}

/**
 * Update subscription
 *
 * @param db Database client
 * @param subscription_id Subscription UUID
 * @param updates Subscription updates
 */
export async function updateSubscription(
  db: DatabaseClient,
  subscription_id: string,
  updates: { selected_tools?: string[]; status?: 'active' | 'paused' | 'removed' }
): Promise<void> {
  const now = new Date().toISOString();

  const updateData: Partial<ClientMcpSubscription> = {
    updated_at: now,
  };

  if (updates.selected_tools !== undefined) {
    updateData.selected_tools = JSON.stringify(updates.selected_tools);
  }

  if (updates.status !== undefined) {
    updateData.status = updates.status;
  }

  await compatUpdate(db, client_mcp_subscriptions)
    .set(updateData)
    .where(eq(client_mcp_subscriptions.subscription_id, subscription_id));

  console.log(`[db:subscriptions] Subscription updated: ${subscription_id}`);
}

/**
 * Remove subscription
 *
 * Hard deletes the subscription record.
 *
 * @param db Database client
 * @param subscription_id Subscription UUID
 */
export async function removeSubscription(
  db: DatabaseClient,
  subscription_id: string
): Promise<void> {
  await compatDelete(db, client_mcp_subscriptions).where(
    eq(client_mcp_subscriptions.subscription_id, subscription_id)
  );

  console.log(`[db:subscriptions] Subscription removed: ${subscription_id}`);
}
