/**
 * Configuration schema (Zod)
 *
 * Validates ambassador-server.yaml structure with type-safe config object.
 *
 * @see Architecture §6 Server Configuration Model
 * @see ADR-005 Secrets Management Strategy
 */

import { z } from 'zod';

// ===== §6.1 Server Configuration =====

const ServerConfigSchema = z.object({
  host: z.string().default('0.0.0.0'),
  port: z.number().int().min(1).max(65535).default(8443),
  tls: z
    .object({
      enabled: z.boolean().default(true),
      auto_cert: z.boolean().optional(),
      cert_file: z.string().optional(),
      key_file: z.string().optional(),
      ca_file: z.string().optional(),
    })
    .optional(),
});

// ===== §6.1 Registration Configuration =====

const RegistrationConfigSchema = z.object({
  mode: z.enum(['open', 'admin_only']).default('open'),
  default_profile: z.string().default('all-tools'),
  rate_limit: z.string().default('10/hour'),
  max_clients: z.number().int().min(1).default(50),
  max_body_size: z.number().int().min(1).default(4096),
});

// ===== §9.2 Authentication Configuration =====

const AuthenticationConfigSchema = z.object({
  provider: z.string(), // 'api_key', 'jwt', 'oidc', 'saml', 'mtls'
  config: z.record(z.unknown()),
});

// ===== §10 Authorization Configuration =====

const AuthorizationConfigSchema = z.object({
  provider: z.string(), // 'local_rbac', 'ldap', 'opa'
  config: z.record(z.unknown()),
});

// ===== §11 Audit Configuration =====

const AuditConfigSchema = z.object({
  provider: z.string(), // 'file', 'database', 'syslog', 'siem'
  on_failure: z.enum(['block', 'buffer']).default('buffer'),
  config: z.record(z.unknown()),
});

// ===== §8 Downstream MCP Configuration =====

const DownstreamMcpConfigSchema = z.object({
  name: z.string(),
  transport: z.enum(['stdio', 'sse', 'http']),
  command: z.array(z.string()).optional(),
  url: z.string().optional(),
  env: z.record(z.string()).optional(),
  timeout_ms: z.number().int().min(100).optional(),
  health_check_interval_ms: z.number().int().min(1000).optional(),
});

// ===== §6.4 Providers Configuration (Supply Chain Security) =====

const ProvidersConfigSchema = z.object({
  allowed_packages: z
    .array(z.string())
    .default([
      '@mcpambassador/authn-ephemeral',
      '@mcpambassador/authz-local',
      '@mcpambassador/audit-file',
    ]),
});

// ===== §6.5 Database Configuration =====

const DatabaseConfigSchema = z.object({
  type: z.enum(['sqlite', 'postgres']).default('sqlite'),
  url: z.string(), // Connection string or file path (supports ${...} resolution)
  pool_size: z.number().int().min(1).optional(),
  ssl: z.boolean().optional(),
});

// ===== §6.6 Session Lifecycle Configuration (M15) =====

const SessionConfigSchema = z
  .object({
    /** Idle timeout in seconds (30 min default, max 24h) — SEC-V2-009 */
    idle_timeout_seconds: z.number().int().min(5).max(86400).default(1800),
    /** Spindown delay in seconds (5 min default, max 24h) */
    spindown_delay_seconds: z.number().int().min(5).max(86400).default(300),
    /** Session TTL in seconds (8h default, max 24h) — SEC-V2-009 */
    ttl_seconds: z.number().int().min(60).max(86400).default(28800),
    /** Expected heartbeat interval in seconds (2 min default) */
    heartbeat_expected_interval_seconds: z.number().int().min(15).max(3600).default(120),
    /** Sweep interval in seconds (30 min default) */
    sweep_interval_seconds: z.number().int().min(30).max(86400).default(1800),
    /** Evaluation interval in seconds (2 min default) */
    evaluation_interval_seconds: z.number().int().min(5).max(600).default(120),
  })
  .optional();

// ===== §18 Per-User MCP Pool Configuration (SEC-M17-005) =====

const UserPoolConfigSchema = z
  .object({
    /** Max MCP instances per user (default: 10) */
    max_instances_per_user: z.number().int().min(1).max(1000).default(10),
    /** Max total MCP instances system-wide (default: 100) */
    max_total_instances: z.number().int().min(1).max(10000).default(100),
    /** Health check interval in milliseconds (default: 120000) */
    health_check_interval_ms: z.number().int().min(1000).max(600000).default(120000),
  })
  .optional();

// ===== §11.4 Audit Buffer Configuration =====

const BufferConfigSchema = z.object({
  size: z.number().int().min(100).default(10000),
  flush_interval_ms: z.number().int().min(100).default(5000),
  spill_to_disk: z.boolean().default(true),
  spill_path: z.string().default('./data/audit-spill.jsonl'), // F-SEC-M3-005: not /tmp
  max_spill_size_bytes: z
    .number()
    .int()
    .min(1024 * 1024)
    .default(100 * 1024 * 1024), // F-SEC-M3-006: 100MB default
});

// ===== Root Configuration Schema =====

export const AmbassadorConfigSchema = z.object({
  server: ServerConfigSchema,
  registration: RegistrationConfigSchema.optional(),
  authentication: AuthenticationConfigSchema,
  authorization: AuthorizationConfigSchema,
  audit: AuditConfigSchema,
  database: DatabaseConfigSchema,
  downstream_mcps: z.array(DownstreamMcpConfigSchema),
  providers: ProvidersConfigSchema.optional(),
  buffer: BufferConfigSchema.optional(),
  session: SessionConfigSchema,
  user_pool: UserPoolConfigSchema, // SEC-M17-005: Per-user MCP pool limits
});

// ===== Infer TypeScript type from schema =====

export type AmbassadorConfig = z.infer<typeof AmbassadorConfigSchema>;

// ===== Credential field patterns (ADR-005 §2.3.1) =====

export const CREDENTIAL_FIELD_PATTERNS = [
  'password',
  'secret',
  'token',
  'key',
  'credential',
  'passphrase',
  'bearer',
] as const;

/**
 * Check if a config key is likely a credential field
 */
export function isCredentialField(key: string): boolean {
  const lowerKey = key.toLowerCase();
  return CREDENTIAL_FIELD_PATTERNS.some(pattern => lowerKey.includes(pattern));
}

/**
 * Additional credential patterns from config (F-017)
 */
export function buildCredentialPatterns(additional: string[] = []): string[] {
  return [...CREDENTIAL_FIELD_PATTERNS, ...additional];
}
