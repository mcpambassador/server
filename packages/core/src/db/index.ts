/**
 * Database Access Layer - Barrel Export
 *
 * Exports all database client setup and repository functions.
 *
 * @see Architecture §3 Data Model
 */

// Database client setup
export {
  initializeDatabase,
  runMigrations,
  MigrationIntegrityError,
  MIGRATION_BOOTSTRAP_LAST,
  type RunMigrationsOptions,
  seedDatabaseIfNeeded,
  closeDatabase,
  checkDatabaseHealth,
  type DatabaseClient,
  type DatabaseConfig,
} from './client.js';

// Seed functions
export { seedDatabase, seedDevData } from '../schema/seed.js';

// Compatibility layer for Drizzle ORM queries
export {
  compatInsert,
  compatSelect,
  compatUpdate,
  compatDelete,
  compatTransaction,
} from './compat.js';

// Tool profile repository
export {
  createToolProfile,
  getToolProfileById,
  getToolProfileByName,
  listToolProfiles,
  updateToolProfile,
  deleteToolProfile,
  resolveInheritanceChain,
  getEffectiveProfile,
  getChildProfiles,
  getRootProfiles,
} from './repositories/tool-profiles.js';

// Admin key repository
export {
  generateAdminKey,
  generateRecoveryToken,
  createAdminKey,
  authenticateAdminKey,
  authenticateAdminKeyId,
  rotateAdminKey,
  recoverAdminKey,
  factoryResetAdminKey,
  getAdminKeyHashPrefix,
  readRecoveryTokenFile,
} from './repositories/admin-keys.js';

// Audit event repository
export {
  insertAuditEvent,
  queryAuditEvents,
  getAuditEventById,
  countAuditEvents,
  deleteOldAuditEvents,
  getAuditStatistics,
} from './repositories/audit-events.js';

// Group repository
export {
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
} from './repositories/groups.js';

// MCP catalog repository
export {
  createMcpEntry,
  getMcpEntryById,
  getMcpEntryByName,
  listMcpEntries,
  updateMcpEntry,
  deleteMcpEntry,
  publishMcpEntry,
  updateValidationStatus,
  updateToolCatalog,
  grantGroupAccess,
  revokeGroupAccess,
  listGroupsForMcp,
  listMcpsForGroup,
} from './repositories/mcp-catalog.js';

// Subscription repository
export {
  createSubscription,
  getSubscription,
  listSubscriptionsForClient,
  listSubscriptionsForMcp,
  updateSubscription,
  removeSubscription,
} from './repositories/subscriptions.js';

// User credential repository
export {
  storeCredential,
  getCredential,
  listCredentialsForUser,
  updateCredential,
  deleteCredential,
  deleteCredentialsForMcp,
} from './repositories/user-credentials.js';

// OAuth states repository
export {
  createOAuthState,
  getOAuthState,
  consumeOAuthState,
  cleanupExpiredStates,
  deleteOAuthStatesForUser,
} from './repositories/oauth-states.js';

// Re-export schema types for convenience
export type {
  Client,
  NewClient,
  ToolProfile,
  NewToolProfile,
  AdminKey,
  NewAdminKey,
  AuditEvent,
  NewAuditEvent,
  Group,
  NewGroup,
  UserGroup,
  NewUserGroup,
  McpCatalogEntry,
  NewMcpCatalogEntry,
  McpGroupAccess,
  NewMcpGroupAccess,
  McpGroupAccessTool,
  NewMcpGroupAccessTool,
  ClientMcpSubscription,
  NewClientMcpSubscription,
  UserMcpCredential,
  NewUserMcpCredential,
  OAuthState,
  NewOAuthState,
  ClientMetadata,
  RateLimits,
  TimeWindow,
  AuditRequestSummary,
  AuditResponseSummary,
} from '../schema/index.js';

// ADR-020 agent OAuth repositories (stubs until P3)
export * from './repositories/agent-oauth.js';
export * from './repositories/kill-switches.js';
export * from './repositories/tool-pins.js';
export * from './repositories/group-tool-policy.js';
export * from './repositories/approvals.js';
