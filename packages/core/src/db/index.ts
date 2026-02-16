/**
 * Database Access Layer - Barrel Export
 * 
 * Exports all database client setup and repository functions.
 * 
 * Usage:
 * ```typescript
 * import { initializeDatabase, registerClient, createToolProfile } from './db';
 * 
 * const db = await initializeDatabase({ type: 'sqlite', sqliteFilePath: './data/ambassador.db' });
 * const client = await registerClient(db, { ... }, apiKey);
 * ```
 */

// Database client setup
export {
  initializeDatabase,
  runMigrations,
  seedDatabaseIfNeeded,
  closeDatabase,
  checkDatabaseHealth,
  type DatabaseClient,
  type DatabaseConfig,
} from './client.js';

// Client repository
export {
  registerClient,
  authenticateClient,
  getClientById,
  listClients,
  updateClientStatus,
  updateLastSeen,
  rotateClientApiKey,
  updateClientMetadata,
  deleteClient,
  countClientsByStatus,
  sanitizeFriendlyName,
} from './repositories/clients.js';

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
  ClientMetadata,
  RateLimits,
  TimeWindow,
  AuditRequestSummary,
  AuditResponseSummary,
} from '../schema/index.js';
