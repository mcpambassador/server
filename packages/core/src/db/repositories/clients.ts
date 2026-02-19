/**
 * DEPRECATED — Scheduled for removal.
 *
 * The old `amb_sk_` client model has been replaced by the Phase 3
 * preshared key model (now renamed to 'clients' in the schema).
 *
 * Client management is now handled through:
 * - Schema: packages/core/src/schema/index.ts (clients table)
 * - Admin routes: packages/server/src/admin/routes.ts (CRUD endpoints)
 * - Auth: packages/authn-ephemeral/src/token.ts (key validation)
 *
 * @see ADR-P3-06 Rename preshared_keys → clients
 * @see ADR-P3-07 Clean-slate schema approach
 */

// No exports — barrel exports in db/index.ts have been updated to remove references.
