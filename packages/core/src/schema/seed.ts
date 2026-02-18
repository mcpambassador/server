/**
 * MCP Ambassador - Seed Data
 *
 * Default Tool Profiles and reference data for Phase 1 deployment.
 * These profiles are inserted on first server boot.
 *
 * @see Architecture §10.2 Tool Profile Examples
 * @see dev-plan.md M1.4 Seed Data Requirements
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any */
/* eslint-disable no-console */

import { tool_profiles, users } from './index.js';

import { v4 as uuidv4 } from 'uuid';
import type { NewToolProfile } from './index.js';

/**
 * Generates ISO 8601 timestamp for current time
 */
function now(): string {
  return new Date().toISOString();
}

/**
 * Default Tool Profiles (Phase 1)
 *
 * These profiles are created on first boot and can be modified by admins.
 */
export const defaultProfiles: NewToolProfile[] = [
  {
    profile_id: uuidv4(),
    name: 'all-tools',
    description:
      'Full access to all tools. Default profile for auto-registered clients in Community tier.',
    allowed_tools: JSON.stringify(['*']), // Glob: all tools
    denied_tools: JSON.stringify([]), // No denials
    rate_limits: JSON.stringify({
      requests_per_minute: 60,
      requests_per_hour: 1000,
      max_concurrent: 10,
    }),
    inherited_from: null,
    environment_scope: JSON.stringify([]), // All environments
    time_restrictions: JSON.stringify([]), // No time restrictions
    created_at: now(),
    updated_at: now(),
  },
  {
    profile_id: uuidv4(),
    name: 'restricted',
    description: 'No access to any tools. Used for suspended or quarantined clients.',
    allowed_tools: JSON.stringify([]), // No tools allowed
    denied_tools: JSON.stringify(['*']), // Deny all
    rate_limits: JSON.stringify({
      requests_per_minute: 0,
      requests_per_hour: 0,
      max_concurrent: 0,
    }),
    inherited_from: null,
    environment_scope: JSON.stringify([]),
    time_restrictions: JSON.stringify([]),
    created_at: now(),
    updated_at: now(),
  },
  {
    profile_id: uuidv4(),
    name: 'read-only',
    description: 'Read-only tools (git, filesystem read, search). Safe for auditors and analysts.',
    allowed_tools: JSON.stringify([
      'git.log',
      'git.show',
      'git.diff',
      'filesystem.read_file',
      'filesystem.list_directory',
      'search.*',
      'database.query', // SELECT only, not mutations
    ]),
    denied_tools: JSON.stringify([
      'filesystem.write_file',
      'filesystem.delete_file',
      'git.commit',
      'git.push',
      'database.execute', // No DDL/DML
      '*.delete_*',
      '*.drop_*',
      '*.truncate_*',
    ]),
    rate_limits: JSON.stringify({
      requests_per_minute: 30,
      requests_per_hour: 500,
      max_concurrent: 5,
    }),
    inherited_from: null,
    environment_scope: JSON.stringify([]),
    time_restrictions: JSON.stringify([]),
    created_at: now(),
    updated_at: now(),
  },
  {
    profile_id: uuidv4(),
    name: 'developer',
    description: 'Full development tools. Standard profile for engineering teams.',
    allowed_tools: JSON.stringify([
      'git.*',
      'filesystem.*',
      'search.*',
      'database.*',
      'web.*',
      'slack.*',
      'jira.*',
    ]),
    denied_tools: JSON.stringify([
      'aws.iam.*', // No IAM changes
      'gcp.iam.*',
      'azure.rbac.*',
      'database.drop_database', // No database deletion
      '*.production.*', // No production access (handled via environment_scope)
    ]),
    rate_limits: JSON.stringify({
      requests_per_minute: 120,
      requests_per_hour: 2000,
      max_concurrent: 15,
    }),
    inherited_from: null,
    environment_scope: JSON.stringify(['dev', 'staging']), // Not production
    time_restrictions: JSON.stringify([]),
    created_at: now(),
    updated_at: now(),
  },
  {
    profile_id: uuidv4(),
    name: 'database-engineer',
    description: 'Database-focused tools. Inherits from developer + database admin tools.',
    allowed_tools: JSON.stringify(['database.*', 'postgres.*', 'mysql.*', 'mongodb.*', 'redis.*']),
    denied_tools: JSON.stringify([]),
    rate_limits: JSON.stringify({
      requests_per_minute: 60,
      requests_per_hour: 1000,
      max_concurrent: 10,
    }),
    inherited_from: null, // Could inherit from 'developer' but keeping simple for Phase 1
    environment_scope: JSON.stringify([]),
    time_restrictions: JSON.stringify([]),
    created_at: now(),
    updated_at: now(),
  },
  {
    profile_id: uuidv4(),
    name: 'security-engineer',
    description: 'Security audit and compliance tools. Read-only access to sensitive systems.',
    allowed_tools: JSON.stringify([
      'git.log',
      'git.show',
      'search.*',
      'audit.*',
      'security.*',
      'secrets.list', // List secrets, not read values
      'iam.list_*', // List IAM, not modify
    ]),
    denied_tools: JSON.stringify([
      '*.write_*',
      '*.delete_*',
      '*.modify_*',
      '*.create_*',
      'secrets.read', // Cannot read secret values
      'iam.create_*',
      'iam.update_*',
      'iam.delete_*',
    ]),
    rate_limits: JSON.stringify({
      requests_per_minute: 30,
      requests_per_hour: 500,
      max_concurrent: 5,
    }),
    inherited_from: null,
    environment_scope: JSON.stringify([]), // All environments (audit everywhere)
    time_restrictions: JSON.stringify([]),
    created_at: now(),
    updated_at: now(),
  },
  {
    profile_id: uuidv4(),
    name: 'business-hours',
    description: 'Example time-restricted profile. Tools available Mon-Fri 8am-6pm UTC.',
    allowed_tools: JSON.stringify(['*']),
    denied_tools: JSON.stringify([]),
    rate_limits: JSON.stringify({
      requests_per_minute: 60,
      requests_per_hour: 1000,
      max_concurrent: 10,
    }),
    inherited_from: null,
    environment_scope: JSON.stringify([]),
    time_restrictions: JSON.stringify([
      {
        days: ['mon', 'tue', 'wed', 'thu', 'fri'],
        start_utc: '08:00',
        end_utc: '18:00',
      },
    ]),
    created_at: now(),
    updated_at: now(),
  },
];

/**
 * Built-in admin roles (referenced in ADR-006)
 *
 * These are NOT stored in tool_profiles — they are hardcoded authorization
 * roles for admin API access. Documented here for reference.
 */
export const builtInAdminRoles = {
  'ambassador-admin': {
    description:
      'Full admin access: profile CRUD, client lifecycle, kill switch, audit read, admin key rotation',
    permissions: ['admin:*', 'audit:read'],
    immutable: true,
  },
  'ambassador-auditor': {
    description: 'Read-only audit access: GET /v1/audit/* only',
    permissions: ['audit:read'],
    immutable: true,
  },
} as const;

/**
 * Seed function - inserts default profiles if none exist
 *
 * Called by server bootstrap on first run. Idempotent (checks if profiles exist).
 *
 * @param db Drizzle database instance
 */
export async function seedDatabase(db: any): Promise<void> {
  // Check if profiles already exist
  const existingProfiles = await db.query.tool_profiles.findMany({ limit: 1 });

  if (existingProfiles.length > 0) {
    console.log('[seed] Profiles already exist, skipping seed');
    return;
  }

  console.log(`[seed] Inserting ${defaultProfiles.length} default Tool Profiles...`);

  for (const profile of defaultProfiles) {
    await db.insert(tool_profiles).values(profile);
  }

  console.log('[seed] Seed complete');
}

/**
 * Get default profile ID by name (for server config defaults)
 */
export function getDefaultProfileId(name: string): string | null {
  const profile = defaultProfiles.find(p => p.name === name);
  return profile ? profile.profile_id : null;
}

/**
 * Seeds dev/test preshared key data
 * Only runs in NODE_ENV=development or NODE_ENV=test
 */
export async function seedDevPresharedKeys(db: any): Promise<void> {
  if (process.env.NODE_ENV !== 'development' && process.env.NODE_ENV !== 'test') {
    console.log('[seed] Skipping dev preshared key seed (not development/test environment)');
    return;
  }

  // Check if dev user already exists
  const existingUsers = await db.query.users.findMany({ limit: 1 });
  if (existingUsers.length > 0) {
    console.log('[seed] Users already exist, skipping dev seed');
    return;
  }

  const devUserId = uuidv4();
  const timestamp = now();

  // Find the all-tools profile
  const allToolsProfile = await db.query.tool_profiles.findFirst({
    where: (profile: any, { eq }: any) => eq(profile.name, 'all-tools'),
  });

  if (!allToolsProfile) {
    console.log('[seed] Warning: all-tools profile not found, skipping dev preshared key seed');
    return;
  }

  // Insert dev user
  await db.insert(users).values({
    user_id: devUserId,
    display_name: 'Dev User',
    email: 'dev@localhost',
    status: 'active',
    auth_source: 'preshared_key',
    created_at: timestamp,
    metadata: '{}',
  });

  // NOTE: The actual preshared key hash and prefix are generated at server startup
  // when the server detects no preshared keys exist and the dev seed flag is set.
  // This seed only creates the user entry. The preshared key record is created
  // by the server's bootstrap logic (similar to admin key first-boot generation).
  // This avoids hardcoding Argon2id hashes in seed data.
  console.log(`[seed] Created dev user: ${devUserId}`);
  console.log('[seed] Dev preshared key will be generated on first server boot');
}
