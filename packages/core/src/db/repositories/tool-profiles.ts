/**
 * Tool Profile Repository
 * 
 * Data access layer for Tool Profiles (authorization rules).
 * Handles profile inheritance, cycle detection, glob matching.
 * 
 * @see Architecture §3.3 ToolProfile
 * @see Architecture §10.2 Profile Inheritance
 * @see schema/index.ts tool_profiles table
 */

import { eq, sql, isNull } from 'drizzle-orm';
import type { DatabaseClient } from '../client.js';
import { tool_profiles, type ToolProfile, type NewToolProfile, type RateLimits } from '../../schema/index.js';
import { v4 as uuidv4 } from 'uuid';
import { compatInsert, compatSelect, compatUpdate, compatDelete } from '../compat.js';

/**
 * Maximum profile inheritance depth (Architecture §3.3)
 */
const MAX_INHERITANCE_DEPTH = 5;

/**
 * Create a new tool profile
 * 
 * @param db Database client
 * @param data Profile data
 * @returns Created profile
 * @throws Error if inheritance creates a cycle or exceeds max depth
 */
export async function createToolProfile(
  db: DatabaseClient,
  data: Omit<NewToolProfile, 'profile_id' | 'created_at' | 'updated_at'>
): Promise<ToolProfile> {
  const now = new Date().toISOString();
  const profile_id = uuidv4();
  
  // Validate inheritance (cycle detection + depth check)
  if (data.inherited_from) {
    await validateInheritance(db, data.inherited_from, profile_id);
  }
  
  const newProfile: NewToolProfile = {
    profile_id,
    name: data.name,
    description: data.description,
    allowed_tools: data.allowed_tools || '[]',
    denied_tools: data.denied_tools || '[]',
    rate_limits: data.rate_limits || JSON.stringify({
      requests_per_minute: 60,
      requests_per_hour: 1000,
      max_concurrent: 5,
    }),
    inherited_from: data.inherited_from || null,
    environment_scope: data.environment_scope || '[]',
    time_restrictions: data.time_restrictions || '[]',
    created_at: now,
    updated_at: now,
  };
  
  await compatInsert(db, tool_profiles).values(newProfile);
  
  console.log(`[db:tool-profiles] Created profile: ${profile_id} (${newProfile.name})`);
  
  return newProfile as ToolProfile;
}

/**
 * Get profile by ID
 */
export async function getToolProfileById(db: DatabaseClient, profile_id: string): Promise<ToolProfile | null> {
  const [profile] = await compatSelect(db)
    .from(tool_profiles)
    .where(eq(tool_profiles.profile_id, profile_id))
    .limit(1);
  
  return profile || null;
}

/**
 * Get profile by name
 */
export async function getToolProfileByName(db: DatabaseClient, name: string): Promise<ToolProfile | null> {
  const [profile] = await compatSelect(db)
    .from(tool_profiles)
    .where(eq(tool_profiles.name, name))
    .limit(1);
  
  return profile || null;
}

/**
 * List all tool profiles
 * 
 * @param db Database client
 * @param pagination Cursor-based pagination (§16.4)
 * @returns Array of profiles + pagination metadata
 */
export async function listToolProfiles(
  db: DatabaseClient,
  pagination?: {
    limit?: number;
    cursor?: string; // profile name (lexicographic sort)
  }
): Promise<{ profiles: ToolProfile[]; has_more: boolean; next_cursor?: string }> {
  const limit = pagination?.limit || 25;
  
  let query = compatSelect(db).from(tool_profiles);
  
  // Cursor pagination (by name ASC)
  if (pagination?.cursor) {
    query = query.where(sql`${tool_profiles.name} > ${pagination.cursor}`);
  }
  
  const results = await query
    .orderBy(tool_profiles.name)
    .limit(limit + 1);
  
  const has_more = results.length > limit;
  const profilesPage = has_more ? results.slice(0, limit) : results;
  const next_cursor = has_more ? profilesPage[profilesPage.length - 1].name : undefined;
  
  return {
    profiles: profilesPage,
    has_more,
    next_cursor,
  };
}

/**
 * Update tool profile
 * 
 * @param db Database client
 * @param profile_id Profile UUID
 * @param updates Partial profile data to update
 * @throws Error if inheritance update creates a cycle or exceeds max depth
 */
export async function updateToolProfile(
  db: DatabaseClient,
  profile_id: string,
  updates: Partial<Omit<ToolProfile, 'profile_id' | 'created_at' | 'updated_at'>>
): Promise<void> {
  // Validate inheritance if being changed
  if (updates.inherited_from !== undefined) {
    await validateInheritance(db, updates.inherited_from, profile_id);
  }
  
  const now = new Date().toISOString();
  
  await compatUpdate(db, tool_profiles)
    .set({ ...updates, updated_at: now })
    .where(eq(tool_profiles.profile_id, profile_id));
  
  console.log(`[db:tool-profiles] Profile updated: ${profile_id}`);
}

/**
 * Delete tool profile
 * 
 * @throws Error if clients reference this profile (FK constraint RESTRICT)
 */
export async function deleteToolProfile(db: DatabaseClient, profile_id: string): Promise<void> {
  // FK constraint will reject if any clients reference this profile
  await compatDelete(db, tool_profiles).where(eq(tool_profiles.profile_id, profile_id));
  console.log(`[db:tool-profiles] Profile deleted: ${profile_id}`);
}

/**
 * Resolve profile inheritance chain
 * 
 * Returns the full inheritance chain from leaf to root, with merged rules.
 * 
 * @param db Database client
 * @param profile_id Starting profile ID
 * @returns Array of profiles in inheritance order [child, parent, grandparent, ...]
 */
export async function resolveInheritanceChain(
  db: DatabaseClient,
  profile_id: string
): Promise<ToolProfile[]> {
  const chain: ToolProfile[] = [];
  let current_id: string | null = profile_id;
  
  while (current_id && chain.length < MAX_INHERITANCE_DEPTH) {
    const profile = await getToolProfileById(db, current_id);
    
    if (!profile) {
      console.warn(`[db:tool-profiles] Profile not found in inheritance chain: ${current_id}`);
      break;
    }
    
    chain.push(profile);
    current_id = profile.inherited_from;
  }
  
  return chain;
}

/**
 * Get effective profile rules (merged from inheritance chain)
 * 
 * Merges allowed_tools, denied_tools, rate_limits from parent chain.
 * Child rules override parent rules.
 * 
 * @param db Database client
 * @param profile_id Profile ID
 * @returns Merged profile with effective rules
 */
export async function getEffectiveProfile(
  db: DatabaseClient,
  profile_id: string
): Promise<{
  profile_id: string;
  name: string;
  allowed_tools: string[];
  denied_tools: string[];
  rate_limits: RateLimits;
  inheritance_chain: string[]; // Array of profile names from leaf to root
}> {
  const chain = await resolveInheritanceChain(db, profile_id);
  
  if (chain.length === 0) {
    throw new Error(`Profile not found: ${profile_id}`);
  }
  
  // Start with leaf profile (child overrides parent)
  const leaf = chain[0];
  
  // Merge rules from parent chain (reverse order: root to leaf)
  const allowed_tools = new Set<string>();
  const denied_tools = new Set<string>();
  let rate_limits: RateLimits = {
    requests_per_minute: 60,
    requests_per_hour: 1000,
    max_concurrent: 5,
  };
  
  // Process from root to leaf (parents first, child last)
  for (let i = chain.length - 1; i >= 0; i--) {
    const profile = chain[i];
    
    // Merge allowed_tools (M-1: JSON parsing with error handling)
    try {
      const profileAllowed = JSON.parse(profile.allowed_tools) as string[];
      profileAllowed.forEach(tool => allowed_tools.add(tool));
    } catch (err) {
      console.error(`[db:tool-profiles] Invalid allowed_tools JSON for profile ${profile.profile_id}:`, err);
      // Continue with empty array - don't break authorization
    }
    
    // Merge denied_tools
    try {
      const profileDenied = JSON.parse(profile.denied_tools) as string[];
      profileDenied.forEach(tool => denied_tools.add(tool));
    } catch (err) {
      console.error(`[db:tool-profiles] Invalid denied_tools JSON for profile ${profile.profile_id}:`, err);
    }
    
    // Override rate_limits (child wins)
    try {
      rate_limits = JSON.parse(profile.rate_limits) as RateLimits;
    } catch (err) {
      console.error(`[db:tool-profiles] Invalid rate_limits JSON for profile ${profile.profile_id}:`, err);
      // Keep previous rate_limits (or default from initialization)
    }
  }
  
  return {
    profile_id: leaf.profile_id,
    name: leaf.name,
    allowed_tools: Array.from(allowed_tools),
    denied_tools: Array.from(denied_tools),
    rate_limits,
    inheritance_chain: chain.map(p => p.name),
  };
}

/**
 * Validate profile inheritance (cycle detection + depth check)
 * 
 * @param db Database client
 * @param parent_id Parent profile ID (or null)
 * @param child_id Child profile ID
 * @throws Error if cycle detected or max depth exceeded
 */
async function validateInheritance(
  db: DatabaseClient,
  parent_id: string | null,
  child_id: string
): Promise<void> {
  if (!parent_id) {
    return; // No inheritance to validate
  }
  
  // Traverse upwards from parent to check for cycles and depth
  const visited = new Set<string>([child_id]);
  let current_id: string | null = parent_id;
  let depth = 1;
  
  while (current_id) {
    if (visited.has(current_id)) {
      throw new Error(`Profile inheritance cycle detected: ${child_id} -> ${current_id}`);
    }
    
    if (depth > MAX_INHERITANCE_DEPTH) {
      throw new Error(`Profile inheritance depth exceeds maximum (${MAX_INHERITANCE_DEPTH})`);
    }
    
    visited.add(current_id);
    
    const profile = await getToolProfileById(db, current_id);
    if (!profile) {
      throw new Error(`Parent profile not found: ${current_id}`);
    }
    
    current_id = profile.inherited_from;
    depth++;
  }
}

/**
 * Get child profiles (profiles that inherit from this one)
 */
export async function getChildProfiles(db: DatabaseClient, profile_id: string): Promise<ToolProfile[]> {
  return compatSelect(db)
    .from(tool_profiles)
    .where(eq(tool_profiles.inherited_from, profile_id));
}

/**
 * Get root profiles (profiles with no parent)
 */
export async function getRootProfiles(db: DatabaseClient): Promise<ToolProfile[]> {
  return compatSelect(db)
    .from(tool_profiles)
    .where(isNull(tool_profiles.inherited_from));
}
