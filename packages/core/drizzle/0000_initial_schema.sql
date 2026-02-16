-- MCP Ambassador - Initial Schema Migration
-- Generated: 2026-02-16
-- Description: Creates core tables for Phase 1 (Community tier)
--
-- Tables:
--   - tool_profiles: Authorization profiles with allow/deny rules
--   - clients: Registered Ambassador Client installations
--   - admin_keys: Admin API key hashes and recovery tokens
--   - audit_events: Audit log (for database audit provider in Phase 2)
--
-- Design: SQLite-compatible (baseline). Same migration works for PostgreSQL
-- with Drizzle's dialect abstraction.

-- =============================================================================
-- tool_profiles table
-- =============================================================================
CREATE TABLE IF NOT EXISTS tool_profiles (
  profile_id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  allowed_tools TEXT NOT NULL DEFAULT '[]',
  denied_tools TEXT NOT NULL DEFAULT '[]',
  rate_limits TEXT NOT NULL DEFAULT '{"requests_per_minute":60,"requests_per_hour":1000,"max_concurrent":5}',
  inherited_from TEXT REFERENCES tool_profiles(profile_id) ON DELETE SET NULL ON UPDATE CASCADE,
  environment_scope TEXT DEFAULT '[]',
  time_restrictions TEXT DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tool_profiles_name ON tool_profiles(name);

-- =============================================================================
-- clients table
-- =============================================================================
CREATE TABLE IF NOT EXISTS clients (
  client_id TEXT PRIMARY KEY NOT NULL,
  friendly_name TEXT NOT NULL,
  host_tool TEXT NOT NULL CHECK(host_tool IN ('vscode', 'claude-desktop', 'claude-code', 'opencode', 'gemini-cli', 'chatgpt', 'custom')),
  machine_fingerprint TEXT,
  owner_user_id TEXT,
  auth_method TEXT NOT NULL CHECK(auth_method IN ('api_key', 'jwt', 'oidc', 'saml', 'mtls')),
  api_key_hash TEXT,
  profile_id TEXT NOT NULL REFERENCES tool_profiles(profile_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'suspended', 'revoked')),
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_clients_status ON clients(status);
CREATE INDEX IF NOT EXISTS idx_clients_profile_id ON clients(profile_id);
CREATE INDEX IF NOT EXISTS idx_clients_last_seen_at ON clients(last_seen_at);
CREATE INDEX IF NOT EXISTS idx_clients_host_tool ON clients(host_tool);

-- =============================================================================
-- admin_keys table
-- =============================================================================
CREATE TABLE IF NOT EXISTS admin_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_hash TEXT NOT NULL UNIQUE,
  recovery_token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  rotated_at TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_admin_keys_is_active ON admin_keys(is_active);

-- =============================================================================
-- audit_events table
-- =============================================================================
CREATE TABLE IF NOT EXISTS audit_events (
  event_id TEXT PRIMARY KEY NOT NULL,
  timestamp TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN (
    'client_register', 'auth_success', 'auth_failure', 'token_refresh', 'token_revoke',
    'authz_permit', 'authz_deny', 'tool_invocation', 'tool_error', 'kill_switch_activated',
    'config_change', 'admin_action', 'admin_recovery_attempt', 'admin_key_rotated',
    'provider_loaded', 'provider_blocked'
  )),
  severity TEXT NOT NULL CHECK(severity IN ('info', 'warn', 'error', 'critical')),
  session_id TEXT NOT NULL,
  client_id TEXT,
  user_id TEXT,
  auth_method TEXT NOT NULL,
  source_ip TEXT NOT NULL,
  tool_name TEXT,
  downstream_mcp TEXT,
  action TEXT NOT NULL,
  request_summary TEXT DEFAULT '{}',
  response_summary TEXT DEFAULT '{}',
  authz_decision TEXT CHECK(authz_decision IN ('permit', 'deny', 'conditional')),
  authz_policy TEXT,
  ambassador_node TEXT,
  metadata TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_audit_events_timestamp ON audit_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_events_client_id ON audit_events(client_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_event_type ON audit_events(event_type);
CREATE INDEX IF NOT EXISTS idx_audit_events_severity ON audit_events(severity);
CREATE INDEX IF NOT EXISTS idx_audit_events_timestamp_client ON audit_events(timestamp, client_id);

-- =============================================================================
-- Migration complete
-- =============================================================================
