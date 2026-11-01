/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/require-await, @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-function-return-type */

import { requestLogSerializers } from './log-serializers.js';
import Fastify, { FastifyInstance, FastifyRequest } from 'fastify';
import fastifyCors from '@fastify/cors';
import crypto from 'crypto';
import { eq, or } from 'drizzle-orm';
import argon2 from 'argon2';
import { initializeTls } from './tls.js';
import { isAgentEndpointPath } from './spa-handler.js';
import {
  listPermittedTools,
  invokeTool,
  resolveSessionUserId,
  SessionBindingError,
  KillSwitchError,
  SessionStateError,
  type ToolServiceDeps,
} from './services/tool-service.js';
import {
  SharedMcpManager,
  UserMcpPool,
  ToolRouter,
  type DownstreamMcpConfig,
} from './downstream/index.js';
import { SessionLifecycleManager } from './session/index.js';
import path from 'path';
import { writeFileSync, mkdirSync } from 'node:fs';
import {
  logger,
  initializeDatabase,
  runMigrations,
  seedDatabaseIfNeeded,
  createAdminKey,
  closeDatabase,
  Pipeline,
  type DatabaseClient,
  type AuthenticationProvider,
  type AuthorizationProvider,
  type AuditProvider,
  type SessionContext,
  AuthorizationError,
  AmbassadorError,
  user_sessions,
  session_connections,
  clients,
  compatUpdate,
  compatInsert,
  compatTransaction,
  // seedDevData removed — replaced by first-run setup wizard (ADR-019)
  type OAuthCredentialBlob,
  type OAuthConfig,
  type AmbassadorConfig,
} from '@mcpambassador/core';
import {
  EphemeralAuthProvider,
  getOrCreateHmacSecret,
  persistHmacSecret,
  registerSession,
  startRateLimitCleanup,
  stopRateLimitCleanup,
  type RegistrationRequest,
  type SessionRegConfig,
} from '@mcpambassador/authn-ephemeral';
import { LocalRbacProvider } from '@mcpambassador/authz-local';
import { FileAuditProvider } from '@mcpambassador/audit-file';
import { AGENT_MCP_ROUTE } from '@mcpambassador/contracts';
import {
  resolveAgentEndpointConfig,
  createAgentEndpointDeps,
  loadPersistedSettings,
  type AgentEndpointDeps,
} from './services/agent-endpoint/index.js';
import type {
  ToolCatalogResponse,
  HeartbeatResponse,
  DisconnectResponse,
  ErrorResponse,
} from '@mcpambassador/protocol';
import { BoundedSessionStore, addSessionMaxAge } from './admin/session.js';
import { verifyAdminKeyHeader } from './admin/middleware.js';
import { wrapError, ErrorCodes } from './admin/reply-envelope.js';
import { KillSwitchManager } from './admin/kill-switch-manager.js';
import { CatalogReloader } from './services/catalog-reloader.js';
import type { CredentialVault } from './services/credential-vault.js';
import { SecretStore } from './services/secret-store.js';
import type { OAuthTokenManager } from './services/oauth-token-manager.js';
import type { RegistryService } from './services/registry-service.js';

/**
 * MCP Ambassador Server (M6)
 *
 * HTTPS + TLS server with:
 * - Auto-generated self-signed CA + server cert (TOFU model)
 * - AAA pipeline integration
 * - MCP JSON-RPC routing
 * - RESTful admin API
 * - Downstream MCP connection manager
 *
 * Per Architecture §7:
 * - Default port: 8443
 * - TLS always on (self-signed for Community)
 * - CORS default deny
 * - All requests authenticated
 *
 * Note: Using HTTPS for now; HTTP/2 can be enabled later as optimization
 */

export interface ServerConfig {
  host?: string;
  port?: number;
  dataDir: string;
  serverName?: string;
  logLevel?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  downstreamMcps?: DownstreamMcpConfig[];
  /** Database file path (defaults to dataDir/ambassador.db) */
  dbPath?: string;
  /**
   * Fastify trustProxy for BOTH listeners (config key server.trust_proxy, env MCP_AMBASSADOR_TRUST_PROXY)
   * - false (default): ignore X-Forwarded-For, use the direct connection IP
   * - string | string[]: trust only these proxy IPs/CIDRs
   * - true: trust every hop (spoofable)
   *
   * WARNING: Trusting X-Forwarded-For without proxy validation allows IP spoofing
   */
  trustProxy?: boolean | string | string[];
  /** Admin UI port (defaults to 9443, 0 for ephemeral) */
  adminPort?: number;
  /** Enable admin UI (defaults to true) */
  adminUiEnabled?: boolean;
  /** Max MCP instances per user (defaults to 10) - SEC-M17-005 */
  maxMcpInstancesPerUser?: number;
  /** Max total MCP instances system-wide (defaults to 100) - SEC-M17-005 */
  maxTotalMcpInstances?: number;
  /** Public base URL for OAuth callbacks (overrides serverName:adminPort when behind reverse proxy) */
  publicUrl?: string;
  /** Community registry configuration */
  registryConfig?: {
    url: string;
    refreshIntervalHours: number;
    enabled: boolean;
    token?: string;
  };
  /** Full Ambassador configuration from YAML file (TD-014) */
  ambassadorConfig?: AmbassadorConfig;
  /** TD-027: OAuth client secrets captured before the env scrub, bound to allowed token hosts */
  oauthClientSecrets?: Record<string, { value: string; allowedTokenHosts: string[] }>;
}

export class AmbassadorServer {
  private fastify: FastifyInstance | null = null;
  private adminServer: FastifyInstance | null = null;
  private mcpManager: SharedMcpManager;
  private catalogReloader!: CatalogReloader; // one instance for both listeners (shared reload mutex)
  private userPool!: UserMcpPool; // M17: Per-user MCP pools (initialized in initialize())
  private toolRouter!: ToolRouter; // M17: Tool routing layer (initialized in initialize())
  private config: Omit<
    Required<ServerConfig>,
    'publicUrl' | 'registryConfig' | 'ambassadorConfig' | 'oauthClientSecrets'
  > & {
    adminPort: number;
    adminUiEnabled: boolean;
    maxMcpInstancesPerUser: number;
    maxTotalMcpInstances: number;
    publicUrl?: string;
    registryConfig: {
      url: string;
      refreshIntervalHours: number;
      enabled: boolean;
      token?: string;
    };
    ambassadorConfig?: AmbassadorConfig;
    oauthClientSecrets?: Record<string, { value: string; allowedTokenHosts: string[] }>;
  };
  private secretStore: SecretStore; // TD-027
  private db: DatabaseClient | null = null;
  private toolPins: import('./services/tool-pins/pin-service.js').ToolPinService | null = null;
  private toolPinRediscovery:
    | import('./services/tool-pins/rediscovery.js').ToolPinRediscovery
    | null = null;
  private authn: AuthenticationProvider | null = null;
  private authz: AuthorizationProvider | null = null;
  private audit: AuditProvider | null = null;
  private agentEndpointDeps: AgentEndpointDeps | null = null;
  private pipeline: Pipeline | null = null;
  private killSwitchManager: KillSwitchManager; // CR-M10-001
  private sessionStore: BoundedSessionStore | null = null; // F-SEC-M10-005: Admin session store
  private hmacSecret: Buffer | null = null; // M14: HMAC secret for session tokens
  private lifecycleManager: SessionLifecycleManager | null = null; // M15: Session lifecycle manager
  private heartbeatRateLimit: Map<string, number> = new Map(); // M15: Heartbeat rate limiting
  private credentialVault: CredentialVault | null = null; // CR-H2: M26: Credential vault with proper type
  private oauthTokenManager: OAuthTokenManager | null = null; // ADR-014: OAuth token lifecycle manager
  private registryService: RegistryService | null = null; // Community registry service

  constructor(config: ServerConfig) {
    this.config = {
      host: config.host || '0.0.0.0',
      port: config.port ?? 8443,
      dataDir: config.dataDir,
      serverName: config.serverName || 'localhost',
      logLevel: config.logLevel || 'info',
      downstreamMcps: config.downstreamMcps || [],
      dbPath: config.dbPath || path.join(config.dataDir, 'ambassador.db'),
      trustProxy: config.trustProxy || false,
      adminPort: config.adminPort ?? 9443,
      adminUiEnabled: config.adminUiEnabled ?? true,
      maxMcpInstancesPerUser: config.maxMcpInstancesPerUser ?? 10,
      maxTotalMcpInstances: config.maxTotalMcpInstances ?? 100,
      publicUrl: config.publicUrl,
      registryConfig: config.registryConfig || {
        url: 'https://api.github.com/repos/mcpambassador/community-registry/contents/registry.yaml',
        refreshIntervalHours: 24,
        enabled: true,
        token: undefined,
      },
      ambassadorConfig: config.ambassadorConfig,
      oauthClientSecrets: config.oauthClientSecrets,
    };

    this.secretStore = new SecretStore(config.oauthClientSecrets);
    this.mcpManager = new SharedMcpManager();
    this.killSwitchManager = new KillSwitchManager(); // CR-M10-001: Initialize shared manager
    // CR-M17-001: UserMcpPool and ToolRouter are now initialized in initialize() where MCP configs are available
  }

  /**
   * Initialize server with TLS and routing
   */
  async initialize(): Promise<void> {
    logger.info('[Server] Initializing MCP Ambassador Server...');

    // Initialize TLS certificates
    const certDir = path.join(this.config.dataDir, 'certs');
    const tlsCerts = await initializeTls({
      caPath: path.join(certDir, 'ca.pem'),
      certPath: path.join(certDir, 'server.pem'),
      keyPath: path.join(certDir, 'server-key.pem'),
      serverName: this.config.serverName,
    });

    logger.info(`[TLS] CA Fingerprint: ${tlsCerts.caFingerprint}`);
    logger.info('[TLS] Store this fingerprint for client TOFU trust prompt');

    // Create Fastify instance with HTTPS + TLS
    this.fastify = Fastify({
      trustProxy: this.config.trustProxy ?? false,
      logger: {
        level: this.config.logLevel,
        serializers: requestLogSerializers,
      },
      bodyLimit: 1048576, // 1MB max request body (F-SEC-M6 condition)
      https: {
        key: tlsCerts.key,
        cert: tlsCerts.cert,
        ca: tlsCerts.ca,
        // F-SEC-M6-002: TLS hardening
        minVersion: 'TLSv1.2',
        ciphers: [
          'TLS_AES_256_GCM_SHA384',
          'TLS_AES_128_GCM_SHA256',
          'TLS_CHACHA20_POLY1305_SHA256',
          'ECDHE-ECDSA-AES256-GCM-SHA384',
          'ECDHE-RSA-AES256-GCM-SHA384',
          'ECDHE-ECDSA-AES128-GCM-SHA256',
          'ECDHE-RSA-AES128-GCM-SHA256',
        ].join(':'),
        honorCipherOrder: true,
      },
    });

    // Register CORS plugin (default deny per Architecture §7.2)
    await this.fastify.register(fastifyCors, {
      origin: false, // Default deny
    });

    // F-SEC-M6-008: Security headers
    this.fastify.addHook('onSend', async (_request, reply) => {
      reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('X-Frame-Options', 'DENY');
      reply.header('Cache-Control', 'no-store');
    });

    // Initialize database
    logger.info(`[Server] Initializing database: ${this.config.dbPath}`);
    this.db = await initializeDatabase({
      type: 'sqlite',
      sqliteFilePath: this.config.dbPath,
      enableWAL: true,
      seedOnInit: true,
    });

    // Run database migrations (creates tables if needed)
    logger.info('[Server] Running database migrations...');
    await runMigrations(this.db as DatabaseClient);

    // TD-022: kill switches survive restarts — load persisted state before any listener starts
    this.killSwitchManager = new KillSwitchManager(this.db as DatabaseClient);
    const activeKillSwitches = await this.killSwitchManager.load();
    if (activeKillSwitches > 0) {
      logger.warn(`[Server] ${activeKillSwitches} kill switch(es) active (restored from database)`);
    }

    // Seed default profiles if needed
    logger.info('[Server] Seeding database...');
    await seedDatabaseIfNeeded(this.db as DatabaseClient, {
      type: 'sqlite',
      seedOnInit: true,
    });

    // ADR-019: seedDevData() removed — first admin is created via setup wizard at /setup

    // M23.5: Import YAML downstream MCPs to catalog on first boot
    const { importYamlMcps } = await import('./services/mcp-import.js');
    const importResult = await importYamlMcps(this.db!, this.config.downstreamMcps);
    if (importResult.imported > 0) {
      logger.info(`[Server] Imported ${importResult.imported} YAML MCPs to catalog`);
    }

    // Bootstrap admin key on first boot
    await this.bootstrapAdminKey();

    // Bootstrap dev client key on first boot (dev/test only)
    await this.bootstrapDevClient();

    // Initialize AAA providers
    logger.info('[Server] Initializing AAA providers...');

    // M26.8: Initialize credential vault and master key manager
    logger.info('[Server] Initializing credential vault...');
    const { MasterKeyManager } = await import('./services/master-key-manager.js');
    const { CredentialVault } = await import('./services/credential-vault.js');
    const keyManager = new MasterKeyManager(this.config.dataDir);
    const masterKey = await keyManager.loadMasterKey();
    this.credentialVault = new CredentialVault(masterKey);
    logger.info('[Server] Credential vault initialized');

    // ADR-014: Initialize OAuth token manager
    const { OAuthTokenManager } = await import('./services/oauth-token-manager.js');

    // Construct OAuth callback base URL
    let callbackBaseUrl: string;
    if (this.config.publicUrl) {
      // Use PUBLIC_URL if provided (for reverse proxy deployments)
      callbackBaseUrl = this.config.publicUrl.replace(/\/+$/, ''); // Strip trailing slashes

      // Validate URL format
      if (!callbackBaseUrl.startsWith('https://') && !callbackBaseUrl.startsWith('http://')) {
        throw new Error('PUBLIC_URL must start with https:// or http://');
      }
      if (callbackBaseUrl.startsWith('http://')) {
        logger.warn(
          '[Server] WARNING: PUBLIC_URL uses http:// instead of https:// - OAuth tokens will be transmitted insecurely'
        );
      }
    } else {
      // Fall back to serverName:adminPort for local/development deployments
      callbackBaseUrl = `https://${this.config.serverName}:${this.config.adminPort}`;
    }

    logger.info(`[Server] OAuth callback URL: ${callbackBaseUrl}/v1/oauth/callback`);

    this.oauthTokenManager = new OAuthTokenManager({
      db: this.db,
      vault: this.credentialVault,
      callbackBaseUrl,
      secretStore: this.secretStore,
    });
    logger.info('[Server] OAuth token manager initialized');

    // Initialize community registry service
    logger.info('[Server] Initializing community registry...');
    const { RegistryService } = await import('./services/registry-service.js');
    this.registryService = new RegistryService(
      this.config.registryConfig,
      this.db,
      this.secretStore
    );

    // Fetch registry on startup (non-blocking, errors are logged)
    if (this.config.registryConfig.enabled) {
      try {
        await this.registryService.fetchRegistry();
        logger.info('[Server] Community registry loaded');
      } catch (error) {
        logger.warn({ err: error }, '[Server] Failed to load community registry on startup:');
        logger.warn('[Server] Registry will be available after manual refresh');
      }
    } else {
      logger.info('[Server] Community registry disabled');
    }

    // Register server instance for global access by services
    registerServerInstance(this);

    // Initialize ephemeral auth provider with HMAC secret
    this.hmacSecret = getOrCreateHmacSecret(this.config.dataDir);
    this.authn = new EphemeralAuthProvider(this.db, this.hmacSecret);

    this.authz = new LocalRbacProvider(this.db);
    this.audit = new FileAuditProvider({
      auditDir: path.join(this.config.dataDir, 'audit'),
      retention: 90,
    });

    await this.authn!.initialize({ id: 'ephemeral_auth' });
    await this.authz!.initialize({ id: 'local_rbac' });
    await this.audit!.initialize({ id: 'file_audit' });

    // Initialize AAA pipeline
    this.pipeline = new Pipeline(this.authn!, this.authz!, this.audit!, {
      audit_on_failure: 'buffer', // Fail-open for audit (M5 behavior)
    });

    logger.info('[Server] AAA providers initialized');
    logger.info('[Server] Pipeline initialized (available for M6.5)');

    // Load published shared MCPs from database catalog
    // This replaces the legacy YAML config approach (config.downstreamMcps)
    const { listMcpCatalogEntries } = await import('./services/mcp-catalog-service.js');
    const catalogResult = await listMcpCatalogEntries(
      this.db!,
      { status: 'published', isolation_mode: 'shared' },
      { limit: 100 } // Load up to 100 MCPs
    );
    logger.info(`[Server] Found ${catalogResult.entries.length} published shared MCPs in catalog`);

    // Initialize downstream MCP connections from catalog
    await this.mcpManager.initializeFromCatalog(this.db!, catalogResult.entries);

    // M26: Also load per-user MCPs for UserMcpPool
    const perUserResult = await listMcpCatalogEntries(
      this.db!,
      { status: 'published', isolation_mode: 'per_user' },
      { limit: 100 }
    );
    logger.info(
      `[Server] Found ${perUserResult.entries.length} published per-user MCPs in catalog`
    );

    // Extract configs for UserMcpPool (convert catalog entries back to DownstreamMcpConfig format)
    // This is needed because UserMcpPool expects the old config format
    const mcpConfigs: DownstreamMcpConfig[] = perUserResult.entries.map(entry => {
      const config = JSON.parse(entry.config) as Record<string, unknown>;
      const mcpConfig: DownstreamMcpConfig = {
        name: entry.name,
        transport: entry.transport_type as 'stdio' | 'http' | 'sse',
      };

      if (entry.transport_type === 'stdio') {
        // Command is stored as an array in catalog
        const command = config.command;
        if (Array.isArray(command)) {
          mcpConfig.command = command as string[];
        } else {
          mcpConfig.command = [config.command as string];
        }
        if (config.env) mcpConfig.env = config.env as Record<string, string>;
        if (config.cwd) mcpConfig.cwd = config.cwd as string;
      } else if (entry.transport_type === 'http' || entry.transport_type === 'sse') {
        mcpConfig.url = config.url as string;
        if (config.headers) mcpConfig.headers = config.headers as Record<string, string>;
        if (config.timeout_ms) mcpConfig.timeout_ms = config.timeout_ms as number;
      }

      return mcpConfig;
    });

    // M17: Initialize per-user MCP pool with catalog-based configs
    // SEC-M17-001: Must be created BEFORE SessionLifecycleManager
    // SEC-M17-005: Use configurable limits from config instead of hardcoded values
    logger.info('[Server] Initializing per-user MCP pool...');
    this.userPool = new UserMcpPool({
      mcpConfigs,
      maxInstancesPerUser: this.config.maxMcpInstancesPerUser,
      maxTotalInstances: this.config.maxTotalMcpInstances,
      healthCheckIntervalMs:
        this.config.ambassadorConfig?.user_pool?.health_check_interval_ms ?? 120000, // Configurable, defaults to 2 minutes
    });
    // ADR-013 B1 fix: Store catalog-derived fingerprints for accurate hot reload diffing
    const { computeConfigFingerprint } = await import('./downstream/manager.js');
    const perUserFingerprints = new Map<string, string>();
    for (const entry of perUserResult.entries) {
      perUserFingerprints.set(
        entry.name,
        computeConfigFingerprint(entry.transport_type, entry.config, entry.isolation_mode)
      );
    }
    this.userPool.setMcpConfigFingerprints(perUserFingerprints);
    this.toolRouter = new ToolRouter(this.mcpManager, this.userPool);

    // ADR-021: tool definition pinning. Pins load before any catalog is served; hashes-only audit.
    {
      const { ToolPinService } = await import('./services/tool-pins/pin-service.js');
      const pinAudit = this.audit!;
      const pinAuditFn = (action: string, metadata: Record<string, unknown>): void => {
        void pinAudit
          .emit({
            event_id: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            event_type: 'admin_action',
            severity:
              action === 'tool_definition_changed' || action === 'tool_pin_flagged'
                ? 'warn'
                : 'info',
            source_ip: '127.0.0.1',
            action,
            metadata,
          })
          .catch(err => logger.error({ err }, '[tool-pins] audit emit failed'));
      };
      const pins = new ToolPinService(this.db!, pinAuditFn);
      await pins.load();
      this.toolPins = pins;
      const { ToolPinBaseline } = await import('./services/tool-pins/baseline.js');
      const baseline = new ToolPinBaseline(this.db!, pins, pinAuditFn);
      await baseline.init();
      this.toolRouter.setPinService(pins, (mcpId, scope) => baseline.baselineFor(mcpId, scope));
      const { ToolPinRediscovery, rediscoveryHoursFromEnv } =
        await import('./services/tool-pins/rediscovery.js');
      this.toolPinRediscovery = new ToolPinRediscovery({
        db: this.db!,
        mcpManager: this.mcpManager,
        userPool: this.userPool,
        toolRouter: this.toolRouter,
        intervalHours: rediscoveryHoursFromEnv(),
      });
      this.toolPinRediscovery.start();
    }
    this.catalogReloader = new CatalogReloader(
      this.db as DatabaseClient,
      this.mcpManager,
      this.userPool
    );
    const rediscovery = this.toolPinRediscovery;
    if (rediscovery) {
      // A catalog apply is an explicit reload: re-fetch tool lists and record pins for new/changed tools now.
      this.catalogReloader.onApplied = () => rediscovery.observeAllShared({ refresh: true });
      // Boot: pins (and the one-shot baseline) are recorded without waiting for the first agent listing.
      void rediscovery
        .observeAllShared()
        .catch(err => logger.warn({ err }, '[tool-pins] boot observation failed'));
    }
    logger.info('[Server] Per-user MCP pool initialized');

    // Initialize session lifecycle manager (M15)
    // SEC-M17-001: Must be created AFTER UserMcpPool so it can receive valid reference
    // TD-014: Read from config with sensible defaults
    const sessionConfig = {
      evaluationIntervalMs:
        (this.config.ambassadorConfig?.session?.evaluation_interval_seconds ?? 120) * 1000,
      sweepIntervalMs:
        (this.config.ambassadorConfig?.session?.sweep_interval_seconds ?? 1800) * 1000,
      ttlHardMaxSeconds: 86400, // 24 hours — SEC-V2-009 hard max (not configurable for security)
    };
    this.lifecycleManager = new SessionLifecycleManager(
      this.db,
      this.audit!,
      sessionConfig,
      this.userPool
    );
    this.lifecycleManager.start();
    logger.info('[Server] Session lifecycle manager started');

    // Start rate limit cleanup timer (Sprint 3.3)
    startRateLimitCleanup();
    logger.info('[Server] Rate limit cleanup timer started');

    // Health check endpoint (no auth required)
    // F-SEC-M6-005: Only return aggregate status, no internal topology
    // F-SEC-M6-012: No version banner
    this.fastify.get('/health', async () => {
      return {
        status: 'ok',
      };
    });

    // Register route handlers
    await this.registerRoutes();

    // Initialize admin UI server (M10)
    if (this.config.adminUiEnabled !== false) {
      await this.initializeAdminServer(tlsCerts);
    }

    logger.info('[Server] Initialization complete');
  }

  /**
   * Initialize admin server (M10, M29.5)
   *
   * Creates separate Fastify instance on adminPort with:
   * - Session management
   * - REST API routes
   * - Security headers
   * - Legacy path redirects to SPA (M29.6)
   *
   * Note: EJS-based admin UI removed in M29.5. Admin UI is now the React SPA.
   *
   * @see ADR-008 Admin UI Routing (Dedicated Port 9443)
   */
  private async initializeAdminServer(tlsCerts: {
    key: string;
    cert: string;
    ca: string;
  }): Promise<void> {
    logger.info('[Admin] Initializing admin server...');

    // Import required plugins
    const fastifyCookie = (await import('@fastify/cookie')).default;
    const fastifySession = (await import('@fastify/session')).default;

    // Import admin modules
    const { getOrCreateSessionSecret } = await import('./admin/session.js');

    // Create session store instance if not already created (F-SEC-M10-005)
    if (!this.sessionStore) {
      this.sessionStore = new BoundedSessionStore(
        100,
        this.config.ambassadorConfig?.session?.ui_ttl_seconds ?? 28800
      );
    }

    // Create admin Fastify instance with same TLS config
    this.adminServer = Fastify({
      trustProxy: this.config.trustProxy ?? false,
      logger: {
        level: this.config.logLevel,
        serializers: requestLogSerializers,
      },
      bodyLimit: 1048576,
      https: {
        key: Buffer.from(tlsCerts.key),
        cert: Buffer.from(tlsCerts.cert),
        ca: Buffer.from(tlsCerts.ca),
        minVersion: 'TLSv1.2',
        ciphers: [
          'TLS_AES_256_GCM_SHA384',
          'TLS_AES_128_GCM_SHA256',
          'TLS_CHACHA20_POLY1305_SHA256',
          'ECDHE-ECDSA-AES256-GCM-SHA384',
          'ECDHE-RSA-AES256-GCM-SHA384',
          'ECDHE-ECDSA-AES128-GCM-SHA256',
          'ECDHE-RSA-AES128-GCM-SHA256',
        ].join(':'),
        honorCipherOrder: true,
      },
    });

    // A.1: Register CORS plugin (default deny per Architecture §7.2)
    await this.adminServer.register(fastifyCors, {
      origin: false, // Default deny — matches main API server config
    });

    // Register cookie support
    await this.adminServer.register(fastifyCookie);

    // F-SEC-M10-001: Use secure session secret (env var or generated)
    await this.adminServer.register(fastifySession, {
      secret: getOrCreateSessionSecret(this.config.dataDir),
      cookie: {
        secure: true,
        httpOnly: true,
        sameSite: 'strict',
        path: '/', // M29.5: Changed from '/admin' to '/' to support SPA routes
        // B1/S1: browser session lifetime (absolute, enforced server-side by BoundedSessionStore)
        maxAge: (this.config.ambassadorConfig?.session?.ui_ttl_seconds ?? 28800) * 1000,
      },
      rolling: false, // absolute TTL: activity must not extend the cookie
      store: this.sessionStore,
      saveUninitialized: false, // SEC-M10-07: Don't create session on anonymous requests
    });

    // B1: expose the absolute lifetime as Max-Age on the session cookie too
    this.adminServer.addHook('onSend', async (_request, reply, payload) => {
      const fixed = addSessionMaxAge(reply.getHeader('set-cookie'));
      if (fixed) {
        void reply.removeHeader('set-cookie');
        void reply.header('set-cookie', fixed);
      }
      return payload;
    });

    // A.2: Register CSRF protection plugin.
    // Uses cookie mode (no sessionPlugin) so a CSRF secret is available before the user
    // has an authenticated session. This is required for the login and setup endpoints.
    // The secret is stored in a `_csrf` cookie (HttpOnly, SameSite=strict, Secure).
    // Tokens are signed with HMAC-SHA256 using the secret.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const csrfProtection = (await import('@fastify/csrf-protection')).default;
    await this.adminServer.register(csrfProtection, {
      cookieKey: '_csrf',
      cookieOpts: {
        httpOnly: true,
        secure: true,
        sameSite: 'strict',
        path: '/',
      },
      // Read token from custom header only (recommended for SPAs — prevents misuse via
      // form-encoded body while keeping browser-native form POSTs ineffective).
      getToken: req => req.headers['x-csrf-token'] as string | undefined,
    });

    // A.2: CSRF enforcement hook — fires on every state-changing request.
    // Skips CSRF for X-Admin-Key requests (API key auth is not cookie-based).
    // Skips CSRF for safe HTTP methods (GET, HEAD, OPTIONS) per RFC 7231.
    // All cookie-session–based mutations must supply x-csrf-token header.
    const CSRF_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
    this.adminServer.addHook('onRequest', async (request, reply) => {
      if (CSRF_SAFE_METHODS.has(request.method)) return;
      // ADR-020: /oauth/*, /mcp are bearer/client-authenticated (never cookie), so a
      // disabled endpoint answers a JSON 404 rather than a CSRF 403.
      if (isAgentEndpointPath(request.url)) return;
      // S2: CSRF is skipped ONLY when the admin key VALIDATES. A present-but-invalid key is a
      // 401 here — it never falls through to the cookie session.
      const keyState = await verifyAdminKeyHeader(this.db!, request);
      if (keyState === 'valid') return;
      if (keyState === 'invalid') {
        return reply
          .status(401)
          .send(wrapError(ErrorCodes.UNAUTHORIZED, 'Invalid or missing admin key'));
      }
      // Delegate to the csrfProtection handler registered by the plugin.
      // csrfProtection is a callback-style middleware (req, reply, next) —
      // wrap it in a Promise so the async hook awaits the outcome correctly.
      return new Promise<void>((resolve, reject) => {
        this.adminServer!.csrfProtection(request, reply, (err?: Error) => {
          if (err) return reject(err);
          resolve();
        });
      });
    });

    // Security headers hook (SEC-M10-10)
    this.adminServer.addHook('onSend', async (_request, reply, payload) => {
      // SEC-M10-10: Cache-Control for all admin responses
      reply.header('Cache-Control', 'no-store');

      // Additional security headers
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('X-Frame-Options', 'DENY');
      reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

      return payload;
    });

    // Register admin REST API routes (so they work on admin port too)
    const { adminRoutes } = await import('./admin/routes.js');
    await this.adminServer.register(adminRoutes, {
      db: this.db!,
      audit: this.audit!,
      mcpManager: this.mcpManager,
      dataDir: this.config.dataDir,
      killSwitchManager: this.killSwitchManager, // CR-M10-001
      catalogReloader: this.catalogReloader,
      userPool: this.userPool, // M18: Per-user MCP pool
      rotateHmacSecret: this.rotateHmacSecret.bind(this), // M19.2a: HMAC rotation
      registryService: this.registryService, // Community registry service
      secretStore: this.secretStore, // TD-027
      getToolPins: () => this.getToolPins(), // ADR-021
      onToolPinsChanged: () => this.toolRouter.invalidatePinObservations(),
      onGrantsRevoked: ids => {
        for (const id of ids) this.agentEndpointDeps?.streams.closeGrant(id);
      },
    });

    // Register user-facing API routes on admin server (M29.7)
    // This allows the SPA served on port 9443 to make API calls to the same port
    logger.info('[Admin] Registering user-facing API routes...');

    // Health endpoint for SPA
    this.adminServer.get('/health', async (_request, reply) => {
      return reply.send({ status: 'ok' });
    });

    // A.2: CSRF token endpoint — must be GET (safe, no side effects).
    // The SPA fetches this before any mutation request. The plugin sets the `_csrf`
    // cookie and returns a fresh token the SPA must send as `x-csrf-token` header.
    this.adminServer.get('/v1/csrf-token', async (_request, reply) => {
      const token = reply.generateCsrf();
      return reply.send({ csrfToken: token });
    });

    // Auth routes
    const { registerAuthRoutes } = await import('./auth/routes.js');
    await registerAuthRoutes(this.adminServer, {
      db: this.db!,
    });

    // Setup routes (first-run setup wizard)
    const { registerSetupRoutes } = await import('./auth/setup-routes.js');
    await registerSetupRoutes(this.adminServer, {
      db: this.db! as DatabaseClient,
      audit: this.audit!,
    });

    // Self-service routes
    const { registerSelfServiceRoutes } = await import('./auth/self-service-routes.js');
    await registerSelfServiceRoutes(this.adminServer, {
      db: this.db!,
    });

    // Client routes
    const { registerClientRoutes } = await import('./routes/clients.js');
    await registerClientRoutes(this.adminServer, {
      db: this.db!,
      audit: this.audit!,
      onGrantsRevoked: ids => {
        for (const id of ids) this.agentEndpointDeps?.streams.closeGrant(id);
      },
    });

    // Subscription routes
    const { registerSubscriptionRoutes } = await import('./routes/subscriptions.js');
    await registerSubscriptionRoutes(this.adminServer, { db: this.db! });

    // Credential routes
    const { registerCredentialRoutes } = await import('./routes/credentials.js');
    if (!this.credentialVault) {
      throw new Error('Credential vault not initialized before admin server');
    }
    await registerCredentialRoutes(this.adminServer, {
      db: this.db!,
      vault: this.credentialVault,
      userPool: this.userPool,
    });

    // Marketplace routes
    const { registerMarketplaceRoutes } = await import('./routes/marketplace.js');
    await registerMarketplaceRoutes(this.adminServer, {
      db: this.db!,
    });

    // ADR-014: OAuth routes
    const { registerOAuthRoutes } = await import('./routes/oauth.js');
    if (!this.oauthTokenManager) {
      throw new Error('OAuth token manager not initialized before admin server');
    }
    const portalBaseUrl = `https://${this.config.serverName}:${this.config.adminPort}`;
    await registerOAuthRoutes(this.adminServer, {
      db: this.db!,
      vault: this.credentialVault,
      oauthManager: this.oauthTokenManager,
      userPool: this.userPool,
      portalBaseUrl,
    });

    // ADR-020: agent authorization server (off by default)
    const agentEndpointConfig = this.config.ambassadorConfig?.agent_endpoint;
    const { registerAgentOAuthRoutes, registerAgentEndpointInfoRoute, registerCookieFreeGuard } =
      await import('./routes/agent-oauth.js');
    registerCookieFreeGuard(this.adminServer);
    await registerAgentEndpointInfoRoute(this.adminServer, {
      enabled: !!agentEndpointConfig?.enabled,
      default_grant_ttl_seconds: agentEndpointConfig?.default_grant_ttl_seconds ?? 3600,
      max_grant_ttl_seconds: agentEndpointConfig?.max_grant_ttl_seconds ?? 86400,
      refresh_tokens_enabled:
        !!agentEndpointConfig?.enabled && agentEndpointConfig.refresh_tokens_enabled,
      // Canonical MCP resource URL (what clients register as `claude mcp add ... <url>`)
      resource_url: agentEndpointConfig?.enabled
        ? `${this.agentPublicUrls().agentBaseUrl}${AGENT_MCP_ROUTE}`
        : null,
    });
    if (agentEndpointConfig?.enabled) {
      await registerAgentOAuthRoutes(this.adminServer, await this.buildAgentEndpointDeps());
    }

    logger.info('[Admin] User-facing API routes registered');

    // Register SPA handler on admin server (M29.5)
    // This allows the React admin UI to be served on the admin port
    // IMPORTANT: Must be registered LAST to avoid intercepting API routes
    const { registerSpaHandler } = await import('./spa-handler.js');
    await registerSpaHandler(this.adminServer, { db: this.db! });

    // M29.6: Legacy admin UI path redirects to SPA
    // EJS admin UI was removed in M29.5; redirect old paths to new SPA routes
    this.adminServer.get('/admin/login', async (_request, reply) => {
      return reply.redirect('/login', 301);
    });

    this.adminServer.get('/admin/dashboard', async (_request, reply) => {
      return reply.redirect('/app/admin/dashboard', 301);
    });

    this.adminServer.get('/admin/users', async (_request, reply) => {
      return reply.redirect('/app/admin/users', 301);
    });

    this.adminServer.get('/admin/clients', async (_request, reply) => {
      return reply.redirect('/app/admin/mcps', 301);
    });

    this.adminServer.get('/admin/profiles', async (_request, reply) => {
      return reply.redirect('/app/admin/groups', 301);
    });

    this.adminServer.get('/admin/sessions', async (_request, reply) => {
      return reply.redirect('/app/admin/users', 301);
    });

    this.adminServer.get('/admin/preshared-keys', async (_request, reply) => {
      return reply.redirect('/app/admin/users', 301);
    });

    this.adminServer.get('/admin/downstream', async (_request, reply) => {
      return reply.redirect('/app/admin/mcps', 301);
    });

    this.adminServer.get('/admin/kill-switches', async (_request, reply) => {
      return reply.redirect('/app/admin/kill-switches', 301);
    });

    this.adminServer.get('/admin/audit-log', async (_request, reply) => {
      return reply.redirect('/app/admin/audit', 301);
    });

    // Redirect /admin to dashboard
    this.adminServer.get('/admin', async (_request, reply) => {
      return reply.redirect('/app/admin/dashboard', 301);
    });

    logger.info('[Admin] Admin server initialized');
  }

  /**
   * Source IP of the request. Fastify resolves X-Forwarded-For itself according to the
   * `trustProxy` option (S3), so this is just request.ip: with trust_proxy=false (default) a
   * spoofed header is ignored; with a CIDR list only trusted proxies are believed.
   */
  private getSourceIp(request: FastifyRequest): string {
    return request.ip ?? '0.0.0.0';
  }

  /**
   * Authentication helper - extracts and validates auth from request
   * Returns SessionContext on success, throws 401 on failure
   */
  private getToolServiceDeps(): ToolServiceDeps {
    if (!this.db || !this.authz || !this.pipeline) {
      throw new Error('Server not properly initialized');
    }
    return {
      db: this.db,
      authz: this.authz,
      pipeline: this.pipeline,
      toolRouter: this.toolRouter,
      mcpManager: this.mcpManager,
      userPool: this.userPool,
      killSwitch: this.killSwitchManager,
    };
  }

  private async authenticate(request: FastifyRequest): Promise<SessionContext> {
    if (!this.authn) throw new Error('Authentication provider not initialized');

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers)) {
      if (typeof value === 'string') {
        headers[key] = value;
      }
    }

    // Use centralized sourceIp extraction (F-SEC-P1-001 fix)
    const sourceIp = this.getSourceIp(request);

    if (!this.authn) {
      throw new Error('Authentication provider not initialized');
    }

    const authResult = await this.authn.authenticate({ headers, sourceIp });

    if (!authResult.success || !authResult.session) {
      throw new Error('Unauthorized');
    }

    return authResult.session;
  }

  /**
   * Load and prepare user credentials for MCP spawning
   *
   * Queries user_mcp_credentials, decrypts credentials using the vault,
   * and maps them to environment variables according to each MCP's credential_schema.
   *
   * @param userId User UUID
   * @returns Map of MCP name to credentials (env vars and headers)
   */
  private async loadUserCredentialsForMcps(
    userId: string
  ): Promise<Map<string, import('./downstream/types.js').UserMcpCredentials>> {
    if (!this.credentialVault || !this.db) {
      return new Map(); // Vault not initialized, return empty map
    }

    try {
      // Get user's vault_salt
      const user = await this.db.query.users.findFirst({
        where: (users, { eq }) => eq(users.user_id, userId),
      });

      if (!user?.vault_salt) {
        logger.warn(`[Server] User ${userId} has no vault_salt, skipping credential loading`);
        return new Map();
      }

      // Load all credentials for this user
      const { listCredentialsForUser, getMcpEntryById } = await import('@mcpambassador/core');
      const credentials = await listCredentialsForUser(this.db, userId);

      if (credentials.length === 0) {
        return new Map();
      }

      const credMap = new Map<string, import('./downstream/types.js').UserMcpCredentials>();

      for (const cred of credentials) {
        try {
          // Get MCP catalog entry for credential schema
          const mcpEntry = await getMcpEntryById(this.db, cred.mcp_id);
          if (!mcpEntry) {
            logger.warn(`[Server] MCP ${cred.mcp_id} not found in catalog, skipping credential`);
            continue;
          }

          // Decrypt credentials
          const decryptedJson = this.credentialVault.decrypt(
            user.vault_salt,
            cred.encrypted_credentials,
            cred.encryption_iv
          );

          // ADR-014: Branch on credential_type
          if (cred.credential_type === 'oauth2') {
            // OAuth2 credential flow with refresh-before-spawn
            const { compatUpdate, user_mcp_credentials } = await import('@mcpambassador/core');
            const oauthBlob = JSON.parse(decryptedJson) as OAuthCredentialBlob;

            // Check if token is expired or within 5-minute buffer
            const expiresAt = new Date(oauthBlob.expires_at);
            const now = new Date();
            const fiveMinutesFromNow = new Date(now.getTime() + 5 * 60 * 1000);

            let accessToken = oauthBlob.access_token;

            if (expiresAt <= fiveMinutesFromNow) {
              // Token expired or near expiry — refresh it
              logger.info(
                `[Server] OAuth token for MCP ${mcpEntry.name} expired or near expiry, refreshing...`
              );

              try {
                // Parse oauth_config from MCP entry
                const oauthConfig =
                  typeof mcpEntry.oauth_config === 'string'
                    ? (JSON.parse(mcpEntry.oauth_config) as OAuthConfig)
                    : (mcpEntry.oauth_config as OAuthConfig);

                if (!this.oauthTokenManager) {
                  throw new Error('OAuth token manager not initialized');
                }

                // Refresh the access token
                const tokenSet = await this.oauthTokenManager.refreshAccessToken(
                  oauthConfig,
                  oauthBlob.refresh_token
                );

                // Update the blob with new tokens
                const expiresIn = tokenSet.expires_in || 31536000; // Default 1 year
                const updatedBlob: OAuthCredentialBlob = {
                  access_token: tokenSet.access_token,
                  refresh_token: tokenSet.refresh_token || oauthBlob.refresh_token, // Some providers rotate
                  token_type: tokenSet.token_type,
                  scope: tokenSet.scope || oauthBlob.scope,
                  expires_at: new Date(now.getTime() + expiresIn * 1000).toISOString(),
                };

                // Re-encrypt and update in database
                const { encryptedCredentials, iv } = this.credentialVault.encrypt(
                  user.vault_salt,
                  JSON.stringify(updatedBlob)
                );

                await compatUpdate(this.db, user_mcp_credentials)
                  .set({
                    encrypted_credentials: encryptedCredentials,
                    encryption_iv: iv,
                    oauth_status: 'active',
                    expires_at: updatedBlob.expires_at,
                    updated_at: now.toISOString(),
                  })
                  .where(eq(user_mcp_credentials.credential_id, cred.credential_id));

                accessToken = updatedBlob.access_token;
                logger.info(`[Server] Successfully refreshed OAuth token for MCP ${mcpEntry.name}`);
              } catch (refreshErr) {
                logger.error(
                  { err: refreshErr },
                  `[Server] Failed to refresh OAuth token for MCP ${mcpEntry.name}:`
                );

                // Check if token was revoked (401/invalid_grant)
                if (refreshErr instanceof Error && refreshErr.message.includes('401')) {
                  // Mark as revoked and skip this MCP
                  await compatUpdate(this.db, user_mcp_credentials)
                    .set({ oauth_status: 'revoked', updated_at: now.toISOString() })
                    .where(eq(user_mcp_credentials.credential_id, cred.credential_id));
                  logger.warn(`[Server] OAuth token revoked for MCP ${mcpEntry.name}, skipping`);
                }

                // Skip this MCP on refresh failure
                continue;
              }
            }

            // Inject access_token as env var AND Authorization header
            const oauthConfig =
              typeof mcpEntry.oauth_config === 'string'
                ? (JSON.parse(mcpEntry.oauth_config) as OAuthConfig)
                : (mcpEntry.oauth_config as OAuthConfig);

            if (oauthConfig.access_token_env_var) {
              const envVars: Record<string, string> = {
                [oauthConfig.access_token_env_var]: accessToken,
              };
              const headers: Record<string, string> = {
                Authorization: `Bearer ${accessToken}`,
              };
              credMap.set(mcpEntry.name, { envVars, headers });
              logger.info(
                `[Server] Loaded OAuth credentials for MCP ${mcpEntry.name}: env var ${oauthConfig.access_token_env_var}, Authorization header`
              );
            }
          } else {
            // Static credential flow (existing logic)
            const decryptedCreds = JSON.parse(decryptedJson) as Record<string, string>;

            // Parse credential schema
            const schema =
              typeof mcpEntry.credential_schema === 'string'
                ? JSON.parse(mcpEntry.credential_schema)
                : mcpEntry.credential_schema;

            // Map credential fields to environment variables according to schema
            const envVars: Record<string, string> = {};
            if (schema && typeof schema === 'object' && schema.properties) {
              for (const [fieldName, fieldDef] of Object.entries(
                schema.properties as Record<string, any>
              )) {
                const envVarName = fieldDef.env_var;
                const credValue = decryptedCreds[fieldName];

                if (envVarName && credValue) {
                  envVars[envVarName] = credValue;
                }
              }
            }

            if (Object.keys(envVars).length > 0) {
              credMap.set(mcpEntry.name, { envVars, headers: {} });
              logger.info(
                `[Server] Loaded ${Object.keys(envVars).length} static credential env vars for MCP ${mcpEntry.name}`
              );
            }
          }
        } catch (err) {
          logger.error({ err }, `[Server] Failed to process credential for MCP ${cred.mcp_id}:`);
          // Continue processing other credentials
        }
      }

      return credMap;
    } catch (err) {
      logger.error({ err }, `[Server] Failed to load user credentials for user ${userId}:`);
      return new Map();
    }
  }

  /**
   * Register all route handlers
   * Per Architecture §7.2:
   * - /v1/mcp/* - MCP JSON-RPC (tool catalog, invocation)
   * - /v1/clients/* - Client registration, management
   * - /v1/auth/* - Authentication (API key generation, etc.)
   * - /v1/admin/* - Admin API (profiles, kill switch, audit query)
   * - /v1/audit/* - Audit query endpoint
   */
  private async registerRoutes(): Promise<void> {
    if (!this.fastify) throw new Error('Server not initialized');

    // ==========================================================================
    // SESSION REGISTRATION (no auth required - uses preshared key)
    // ==========================================================================

    this.fastify.post('/v1/sessions/register', { bodyLimit: 4096 }, async (request, reply) => {
      try {
        // Parse request body
        const body = request.body as RegistrationRequest;

        // Get source IP for rate limiting
        const sourceIp = this.getSourceIp(request);

        // Build session config from loaded AmbassadorConfig (TD-014)
        // Falls back to sensible defaults if config not loaded
        const sessionConfig: SessionRegConfig = {
          ttlSeconds: this.config.ambassadorConfig?.session?.ttl_seconds ?? 28800, // 8 hours (default)
          idleTimeoutSeconds: this.config.ambassadorConfig?.session?.idle_timeout_seconds ?? 1800, // 30 minutes (default)
          spindownDelaySeconds:
            this.config.ambassadorConfig?.session?.spindown_delay_seconds ?? 300, // 5 minutes (default)
        };

        // Register session (includes rate limiting, validation, token generation)
        const result = await registerSession(
          this.db!,
          this.hmacSecret!,
          body,
          sourceIp,
          sessionConfig
        );

        // M17.3: Spawn per-user MCP pool for this user BEFORE sending response
        // Extract userId from session context (body contains session_id, need to look up)
        const sessionRecord = await this.db!.query.user_sessions.findFirst({
          where: (sessions, { eq }) => eq(sessions.session_id, result.session_id),
        });

        if (sessionRecord?.user_id) {
          try {
            // M26: Load user credentials and inject into per-user MCPs
            const userCredentials = await this.loadUserCredentialsForMcps(sessionRecord.user_id);
            await this.userPool.spawnForUser(sessionRecord.user_id, userCredentials);
          } catch (err) {
            // Log but don't fail registration — user just won't have per-user MCPs
            this.fastify!.log.error(
              { err, userId: sessionRecord.user_id },
              '[Server] Failed to spawn per-user MCPs'
            );
          }
        }

        // Build protocol-compliant response
        return reply.status(201).send(result);
      } catch (err) {
        if (err instanceof AmbassadorError) {
          const errBody: ErrorResponse = { error: err.code, message: err.message };
          return reply.status(err.statusCode).send(errBody);
        } else {
          this.fastify!.log.error({ err }, '[Server] Session registration error');
          const errBody: ErrorResponse = {
            error: 'registration_failed',
            message: 'Failed to register session',
          };
          return reply.status(500).send(errBody);
        }
      }
    });

    // ==========================================================================
    // SESSION HEARTBEAT (M15.1)
    // ==========================================================================

    this.fastify.post('/v1/sessions/heartbeat', async (request, reply) => {
      try {
        // Authenticate request
        const session = await this.authenticate(request);

        // Rate limit: max 1 heartbeat per 10 seconds per session (SEC-V2-006)
        const lastHeartbeat = this.heartbeatRateLimit.get(session.session_id);
        const now = Date.now();
        if (lastHeartbeat && now - lastHeartbeat < 10000) {
          return reply.status(429).send({
            error: 'rate_limit_exceeded',
            message: 'Heartbeat rate limit: max 1 per 10 seconds',
          });
        }

        // Update rate limit tracker
        this.heartbeatRateLimit.set(session.session_id, now);

        // Get session record
        const sessionRecord = await this.db!.query.user_sessions.findFirst({
          where: (sessions, { eq }) => eq(sessions.session_id, session.session_id),
        });

        if (!sessionRecord) {
          return reply.status(404).send({
            error: 'session_not_found',
            message: 'Session not found',
          });
        }

        // Don't allow heartbeat on expired sessions — check both status AND time-based expiry (SR-M15-001)
        if (
          sessionRecord.status === 'expired' ||
          new Date(sessionRecord.expires_at).getTime() < now
        ) {
          return reply.status(410).send({
            error: 'session_expired',
            message: 'Session expired, re-register required',
          });
        }

        const nowIso = new Date(now).toISOString();

        // Calculate new expiry (extend by session TTL, but respect hard max from creation time)
        const createdAt = new Date(sessionRecord.created_at).getTime();
        const ttlHardMaxMs = 86400 * 1000; // 24 hours (SEC-V2-009)
        const maxExpiryTime = createdAt + ttlHardMaxMs;

        // Get TTL from session config (TD-014: wired to AmbassadorConfig)
        const sessionTtlSeconds = this.config.ambassadorConfig?.session?.ttl_seconds ?? 28800;
        const sessionTtlMs = sessionTtlSeconds * 1000;
        const newExpiryTime = Math.min(now + sessionTtlMs, maxExpiryTime);
        const newExpiryIso = new Date(newExpiryTime).toISOString();

        // Update session: last_activity_at, expires_at, reactivate if idle/suspended
        const updates: any = {
          last_activity_at: nowIso,
          expires_at: newExpiryIso,
        };

        // Reactivate if idle or suspended
        if (sessionRecord.status === 'idle' || sessionRecord.status === 'suspended') {
          updates.status = 'active';

          // M17.3: Respawn per-user MCPs if session is being reactivated
          const userId = sessionRecord.user_id;
          if (userId && !this.userPool.hasActiveInstances(userId)) {
            try {
              // M26: Load user credentials and inject into per-user MCPs
              const userCredentials = await this.loadUserCredentialsForMcps(userId);
              await this.userPool.spawnForUser(userId, userCredentials);
            } catch (err) {
              this.fastify!.log.error(
                { err, userId },
                '[Server] Failed to respawn per-user MCPs on reactivation'
              );
            }
          }
        }

        await compatUpdate(this.db!, user_sessions)
          .set(updates)
          .where(eq(user_sessions.session_id, session.session_id));

        // Update connection heartbeat (find connection for this request)
        // Note: We don't have connection_id in the auth context yet, so update all connected connections
        const connections = await this.db!.query.session_connections.findMany({
          where: (conns, { eq, and }) =>
            and(eq(conns.session_id, session.session_id), eq(conns.status, 'connected')),
        });

        for (const conn of connections) {
          await compatUpdate(this.db!, session_connections)
            .set({ last_heartbeat_at: nowIso })
            .where(eq(session_connections.connection_id, conn.connection_id));
        }

        // Emit audit event
        await this.audit!.emit({
          event_id: crypto.randomUUID(),
          timestamp: nowIso,
          event_type: 'admin_action' as any,
          severity: 'info',
          session_id: session.session_id,
          user_id: session.user_id,
          auth_method: 'api_key' as any,
          source_ip: this.getSourceIp(request),
          action: 'heartbeat_received',
          metadata: {
            previous_status: sessionRecord.status,
            new_status: updates.status || sessionRecord.status,
            expires_at: newExpiryIso,
          },
        });

        const heartbeatResponse: HeartbeatResponse = {
          status: 'ok',
          session_status: updates.status || sessionRecord.status,
          expires_at: newExpiryIso,
        };
        return reply.send(heartbeatResponse);
      } catch (err) {
        if (err instanceof Error && err.message === 'Unauthorized') {
          return reply.status(401).send({
            error: 'Unauthorized',
            message: 'Valid session token required',
          });
        } else {
          this.fastify!.log.error({ err }, '[Server] Heartbeat error');
          return reply.status(500).send({
            error: 'heartbeat_failed',
            message: 'Failed to process heartbeat',
          });
        }
      }
    });

    // ==========================================================================
    // GRACEFUL DISCONNECT (M15.2)
    // ==========================================================================

    this.fastify.delete('/v1/sessions/connections/:connectionId', async (request, reply) => {
      try {
        // Authenticate request
        const session = await this.authenticate(request);

        const { connectionId } = request.params as { connectionId: string };

        if (!connectionId) {
          return reply.status(400).send({
            error: 'validation_error',
            message: 'Connection ID required',
          });
        }

        // Get connection record
        const connection = await this.db!.query.session_connections.findFirst({
          where: (conns, { eq }) => eq(conns.connection_id, connectionId),
        });

        if (!connection) {
          return reply.status(404).send({
            error: 'connection_not_found',
            message: 'Connection not found',
          });
        }

        // Verify connection belongs to authenticated session
        if (connection.session_id !== session.session_id) {
          return reply.status(403).send({
            error: 'forbidden',
            message: 'Connection does not belong to authenticated session',
          });
        }

        // Mark connection as disconnected
        const nowIso = new Date().toISOString();
        await compatUpdate(this.db!, session_connections)
          .set({
            status: 'disconnected',
            disconnected_at: nowIso,
          })
          .where(eq(session_connections.connection_id, connectionId));

        // Emit audit event
        await this.audit!.emit({
          event_id: crypto.randomUUID(),
          timestamp: nowIso,
          event_type: 'admin_action' as any,
          severity: 'info',
          session_id: session.session_id,
          user_id: session.user_id,
          auth_method: 'api_key' as any,
          source_ip: this.getSourceIp(request),
          action: 'connection_disconnected',
          metadata: {
            connection_id: connectionId,
            friendly_name: connection.friendly_name,
            host_tool: connection.host_tool,
          },
        });

        const disconnectResponse: DisconnectResponse = {
          status: 'disconnected',
          connection_id: connectionId,
        };
        return reply.send(disconnectResponse);
      } catch (err) {
        if (err instanceof Error && err.message === 'Unauthorized') {
          return reply.status(401).send({
            error: 'Unauthorized',
            message: 'Valid session token required',
          });
        } else {
          this.fastify!.log.error({ err }, '[Server] Disconnect error');
          return reply.status(500).send({
            error: 'disconnect_failed',
            message: 'Failed to disconnect connection',
          });
        }
      }
    });

    // Legacy route: redirect /v1/clients/register to 410 Gone
    this.fastify.post('/v1/clients/register', async (_request, reply) => {
      return reply.status(410).send({
        error: 'endpoint_retired',
        message:
          'API key authentication is retired. Use POST /v1/sessions/register with preshared key instead.',
      });
    });

    // ==========================================================================
    // CLIENT KEY ROTATION (retired)
    // ==========================================================================

    this.fastify.post('/v1/clients/:id/rotate-key', async (_request, reply) => {
      return reply.status(410).send({
        error: 'endpoint_retired',
        message:
          'API key rotation is retired. Sessions are managed automatically with preshared keys.',
      });
    });

    // ==========================================================================
    // MCP ENDPOINTS (authenticated)
    // ==========================================================================

    // Tool catalog endpoint (M6.4) — logic lives in services/tool-service.ts (shared with /mcp)
    this.fastify.get('/v1/tools', async (request, reply) => {
      try {
        const session = await this.authenticate(request);
        const deps = this.getToolServiceDeps();
        const userId = await resolveSessionUserId(deps.db, session);
        const tools = await listPermittedTools(deps, session, userId);
        const response: ToolCatalogResponse = {
          tools,
          api_version: '1.0',
          timestamp: new Date().toISOString(),
        };
        return reply.send(response);
      } catch (err) {
        if (err instanceof Error && err.message === 'Unauthorized') {
          return reply.status(401).send({
            error: 'Unauthorized',
            message: 'Valid session token required. Include X-Session-Token header.',
          });
        } else if (err instanceof SessionBindingError) {
          return reply.status(500).send({
            error: 'Internal Server Error',
            message: 'Session missing client binding',
          });
        } else if (err instanceof SessionStateError) {
          this.fastify!.log.warn('[Server] Session record not found for authenticated session');
          return reply.status(500).send({
            error: 'Internal Server Error',
            message: 'Session state inconsistent',
          });
        } else {
          logger.error({ err }, '[/v1/tools] Error:');
          return reply.status(500).send({
            error: 'Internal Server Error',
            message: 'Failed to retrieve tool catalog',
          });
        }
      }
    });

    // Tool invocation endpoint (M6.5)
    this.fastify.post('/v1/tools/invoke', async (request, reply) => {
      try {
        // F-SEC-M6 condition: Enforce Content-Type
        const contentType = request.headers['content-type'];
        if (!contentType || !contentType.includes('application/json')) {
          return reply.status(415).send({
            error: 'Unsupported Media Type',
            message: 'Content-Type must be application/json',
          });
        }

        const body = request.body as any;
        if (!body || typeof body !== 'object') {
          return reply.status(400).send({
            error: 'Bad Request',
            message: 'Request body must be a JSON object',
          });
        }
        if (!body.tool || typeof body.tool !== 'string') {
          return reply.status(400).send({
            error: 'Bad Request',
            message: 'Missing or invalid "tool" field',
          });
        }
        if (!body.arguments || typeof body.arguments !== 'object') {
          return reply.status(400).send({
            error: 'Bad Request',
            message: 'Missing or invalid "arguments" field',
          });
        }

        const session = await this.authenticate(request);

        // F-SEC-M5-007: Validate client_id from session (defense-in-depth)
        if (!session.client_id || typeof session.client_id !== 'string') {
          return reply.status(500).send({
            error: 'Internal Server Error',
            message: 'Invalid session context',
          });
        }

        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(request.headers)) {
          if (typeof value === 'string') {
            headers[key] = value;
          }
        }
        // Use centralized sourceIp extraction (F-SEC-P1-001 fix)
        const authRequest = { headers, sourceIp: this.getSourceIp(request) };

        if (!this.pipeline) {
          return reply.status(500).send({
            error: 'Internal Server Error',
            message: 'Pipeline not initialized',
          });
        }

        const deps = this.getToolServiceDeps();
        const userId = await resolveSessionUserId(deps.db, session);
        const response = await invokeTool(
          deps,
          session,
          userId,
          { tool: body.tool, arguments: body.arguments },
          authRequest
        );

        return reply.send(response);
      } catch (err) {
        if (err instanceof Error && err.message === 'Unauthorized') {
          return reply.status(401).send({
            error: 'Unauthorized',
            message: 'Valid session token required. Include X-Session-Token header.',
          });
        } else if (err instanceof KillSwitchError) {
          return reply.status(403).send({
            error: 'Forbidden',
            message: err.message,
          });
        } else if (err instanceof AuthorizationError) {
          // F-SEC-M5-009: Sanitize reason field (don't expose internal rules)
          // F-SEC-M6-021 remediation: Use instanceof instead of string matching
          return reply.status(403).send({
            error: 'Forbidden',
            message: 'Access denied',
          });
        } else if (err instanceof SessionStateError) {
          this.fastify!.log.warn('[Server] Session record not found for authenticated session');
          return reply.status(500).send({
            error: 'Internal Server Error',
            message: 'Session state inconsistent',
          });
        } else if (err instanceof SessionBindingError) {
          return reply.status(500).send({
            error: 'Internal Server Error',
            message: 'Session missing client binding',
          });
        } else {
          logger.error({ err }, '[/v1/tools/invoke] Error:');
          // F-SEC-M5-009: Generic error message (don't expose internals)
          return reply.status(500).send({
            error: 'Internal Server Error',
            message: 'Tool invocation failed',
          });
        }
      }
    });

    // ==========================================================================
    // ADMIN ENDPOINTS (authenticated + admin role required)
    // M8: Admin API Implementation
    // ==========================================================================

    // Register admin routes plugin
    const { adminRoutes } = await import('./admin/routes.js');
    await this.fastify.register(adminRoutes, {
      db: this.db!,
      audit: this.audit!,
      mcpManager: this.mcpManager,
      dataDir: this.config.dataDir,
      killSwitchManager: this.killSwitchManager, // CR-M10-001
      catalogReloader: this.catalogReloader,
      userPool: this.userPool, // M18: Per-user MCP pool
      rotateHmacSecret: this.rotateHmacSecret.bind(this), // M19.2a: HMAC rotation
      registryService: this.registryService, // Community registry service
      secretStore: this.secretStore, // TD-027
      getToolPins: () => this.getToolPins(), // ADR-021
      onToolPinsChanged: () => this.toolRouter.invalidatePinObservations(),
      onGrantsRevoked: ids => {
        for (const id of ids) this.agentEndpointDeps?.streams.closeGrant(id);
      },
    });

    // F-SEC-M6-005: Detailed health endpoint (admin only)
    this.fastify.get('/v1/admin/health', async (request, reply) => {
      try {
        // Authentication required (F-SEC-M6.6 remediation)
        await this.authenticate(request);

        return reply.send({
          status: 'ok',
          version: '0.1.0',
          mcp_status: this.mcpManager.getStatus(),
        });
      } catch (err) {
        if (err instanceof Error && err.message === 'Unauthorized') {
          return reply.status(401).send({
            error: 'Unauthorized',
            message: 'Valid session token required. Include X-Session-Token header.',
          });
        } else {
          logger.error({ err }, '[/v1/admin/health] Error:');
          return reply.status(500).send({
            error: 'Internal Server Error',
            message: 'Health check failed',
          });
        }
      }
    });

    // F1: the browser (cookie-session) API — auth, setup, self-service, clients, subscriptions,
    // credentials, marketplace — lives ONLY on the admin/SPA listener (9443), which has the CSRF hook.
    // The 8443 listener serves the stdio client (/v1/sessions, /v1/tools*), the admin-key API, and /mcp,
    // and carries no cookie session.

    // ADR-020: MCP resource server (off by default)
    if (this.config.ambassadorConfig?.agent_endpoint?.enabled) {
      const { registerAgentMcpRoutes } = await import('./routes/agent-mcp.js');
      await registerAgentMcpRoutes(this.fastify, await this.buildAgentEndpointDeps(), {
        toolDeps: this.getToolServiceDeps(),
        userPool: this.userPool,
        ensureUserMcps: async (userId: string) => {
          if (this.userPool.hasActiveInstances(userId)) return;
          const creds = await this.loadUserCredentialsForMcps(userId);
          await this.userPool.spawnForUser(userId, creds);
        },
      });
    }

    // M24.10: Register SPA handler (must be last to avoid intercepting API routes)
    const { registerSpaHandler } = await import('./spa-handler.js');
    await registerSpaHandler(this.fastify, { db: this.db! });

    logger.info('[Router] All routes registered');
  }

  /**
   * Start the server
   */
  /** ADR-020: public issuer and /mcp base URL, from config/PUBLIC_URL, never the request Host */
  private agentPublicUrls(): { issuer: string; agentBaseUrl: string } {
    const cfg = this.config.ambassadorConfig!.agent_endpoint;
    const strip = (u: string): string => u.replace(/\/+$/, '');
    return {
      issuer: strip(
        cfg.issuer_url ??
          this.config.publicUrl ??
          `https://${this.config.serverName}:${this.config.adminPort}`
      ),
      agentBaseUrl: strip(
        cfg.resource_base_url ?? `https://${this.config.serverName}:${this.config.port}`
      ),
    };
  }

  /** ADR-020: resolved agent endpoint deps (URLs from PUBLIC_URL/config, never request Host) */
  private async buildAgentEndpointDeps(): Promise<AgentEndpointDeps> {
    // One shared instance for 9443 and 8443 so runtime settings/rate limits are consistent
    if (this.agentEndpointDeps) return this.agentEndpointDeps;
    const cfg = this.config.ambassadorConfig!.agent_endpoint;
    const { issuer, agentBaseUrl } = this.agentPublicUrls();
    this.agentEndpointDeps = createAgentEndpointDeps(
      this.db!,
      resolveAgentEndpointConfig(cfg, { issuer, agentBaseUrl }),
      this.audit!
    );
    // DB-persisted admin settings (e.g. DCR toggle) win over the config defaults
    await loadPersistedSettings(this.agentEndpointDeps);
    return this.agentEndpointDeps;
  }

  /** ADR-021 pin service (null before start) */
  getToolPins(): import('./services/tool-pins/pin-service.js').ToolPinService | null {
    return this.toolPins;
  }

  async start(): Promise<void> {
    if (!this.fastify) {
      throw new Error('Server not initialized - call initialize() first');
    }

    try {
      await this.fastify.listen({
        host: this.config.host,
        port: this.config.port,
      });

      logger.info(`[Server] Listening on https://${this.config.host}:${this.config.port}`);

      // Start admin UI server if enabled
      if (this.adminServer) {
        await this.adminServer.listen({
          host: this.config.host,
          port: this.config.adminPort,
        });

        logger.info(
          `[Admin] Admin UI listening on https://${this.config.host}:${this.config.adminPort}`
        );
      }
    } catch (err) {
      logger.error({ err }, '[Server] Failed to start:');
      throw err;
    }
  }

  /**
   * Bootstrap admin key on first boot
   *
   * If no active admin key exists in the database, generates one and prints
   * it to stdout. The key is only shown once — store it securely.
   *
   * Uses a raw SQL query to check for existing keys to avoid importing
   * schema tables into server.ts.
   *
   * @see ADR-006 Admin Authentication Model
   */
  private async bootstrapAdminKey(): Promise<void> {
    // Check for existing active admin key using a raw query
    // (avoids importing schema tables into server.ts)
    const client = (this.db as any).session?.client;
    let hasKey = false;

    if (client?.prepare) {
      // SQLite
      const row = client
        .prepare('SELECT COUNT(*) as cnt FROM admin_keys WHERE is_active = 1')
        .get();
      hasKey = row?.cnt > 0;
    }

    if (hasKey) {
      logger.info('[Server] Admin key already exists');
      return;
    }

    // First boot — generate admin key
    logger.info('[Server] First boot detected — generating admin key...');
    const { admin_key, recovery_token } = await createAdminKey(
      this.db! as DatabaseClient,
      this.config.dataDir
    );

    // Write credentials to file with restricted permissions (security: never logged to stdout)
    const credentialsPath = path.join(this.config.dataDir, 'initial-credentials.txt');
    const timestamp = new Date().toISOString();
    const credentialsContent = `MCP Ambassador — Initial Credentials (created: ${timestamp})
=============================================================
Admin API Key: ${admin_key}
Recovery Token: ${recovery_token}
Recovery file:  ${this.config.dataDir}/.recovery-token
=============================================================
DELETE THIS FILE after recording these values.
`;

    try {
      mkdirSync(this.config.dataDir, { recursive: true });
      writeFileSync(credentialsPath, credentialsContent, { mode: 0o600 });
      logger.info(`[Server] Initial credentials written to ${credentialsPath}`);
    } catch (error) {
      logger.error(`[Server] Failed to write credentials file: ${String(error)}`);
      throw error;
    }
  }

  /**
   * Bootstrap Dev Client Key (M14.3)
   *
   * On first boot in development/test environments, if no client keys exist
   * and an admin user exists (created via setup wizard), generates a random
   * preshared key and writes it to a file.
   *
   * The key is only shown once — store it securely for testing.
   *
   * ONLY runs if NODE_ENV is explicitly 'development' or 'test'.
   * An undefined or 'production' NODE_ENV is treated as production — no bootstrap.
   *
   * @see Architecture §14.3 Preshared Key Bootstrap
   * @see ADR-019 First-Run Setup Wizard
   * @see A.3 Security Fix: NODE_ENV must be explicit dev/test (never undefined)
   */
  private async bootstrapDevClient(): Promise<void> {
    // A.3: Only run when NODE_ENV is EXPLICITLY 'development' or 'test'.
    // Undefined NODE_ENV (e.g. Docker deployments without explicit env) must NOT
    // trigger bootstrap — it would silently create credential files in production.
    const nodeEnv = process.env.NODE_ENV;
    if (nodeEnv !== 'development' && nodeEnv !== 'test') {
      logger.info('[Server] Skipping dev client key bootstrap (not dev/test environment)');
      return;
    }

    // Check if any client keys already exist
    const existingKeys = await this.db!.query.clients.findMany({ limit: 1 });
    if (existingKeys.length > 0) {
      logger.info('[Server] Client keys already exist, skipping dev bootstrap');
      return;
    }

    // ADR-019: Find any admin user (previously depended on seedDevData's dev@localhost)
    const adminUser = await this.db!.query.users.findFirst({
      where: (user, { eq }) => eq(user.is_admin, true),
    });

    if (!adminUser) {
      logger.info('[Server] No admin user found, skipping dev client key bootstrap');
      return;
    }

    // Find the 'all-tools' profile
    const allToolsProfile = await this.db!.query.tool_profiles.findFirst({
      where: (profile, { eq }) => eq(profile.name, 'all-tools'),
    });

    if (!allToolsProfile) {
      logger.info(
        '[Server] Warning: all-tools profile not found, skipping dev client key bootstrap'
      );
      return;
    }

    // First boot in dev/test — generate dev preshared key
    logger.info('[Server] First boot detected (dev/test) — generating dev client key...');

    // Generate random preshared key: amb_pk_ + 48 chars of base64url
    const randomBytes = crypto.randomBytes(36); // 36 bytes → 48 base64 chars
    const base64url = randomBytes
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
    const clientKey = `amb_pk_${base64url}`;

    // Extract prefix: first 8 chars after amb_pk_
    const keyPrefix = base64url.substring(0, 8);

    // Hash with Argon2id
    const keyHash = await argon2.hash(clientKey, {
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });

    // Insert into clients table
    const nowIso = new Date().toISOString();
    await compatInsert(this.db!, clients).values({
      client_id: crypto.randomUUID(),
      key_prefix: keyPrefix,
      key_hash: keyHash,
      client_name: 'dev-bootstrap-key',
      user_id: adminUser.user_id,
      profile_id: allToolsProfile.profile_id,
      status: 'active',
      created_by: 'system-bootstrap',
      created_at: nowIso,
    });

    // Write dev client key to file with restricted permissions (security: never logged to stdout)
    const devKeyPath = path.join(this.config.dataDir, 'dev-client-key.txt');
    const timestamp = new Date().toISOString();
    const devKeyContent = `MCP Ambassador — Dev Client Key (created: ${timestamp})
=============================================================
Dev Client Key: ${clientKey}
=============================================================
This key is for development/testing only.
DELETE THIS FILE after recording the value.
`;

    try {
      mkdirSync(this.config.dataDir, { recursive: true });
      writeFileSync(devKeyPath, devKeyContent, { mode: 0o600 });
      logger.info(`[Server] Dev client key written to ${devKeyPath}`);
    } catch (error) {
      logger.error(`[Server] Failed to write dev client key file: ${String(error)}`);
      throw error;
    }
  }

  /**
   * Rotate HMAC secret (M19.2a)
   *
   * Generates a new HMAC secret, updates the auth provider, and invalidates
   * all active sessions (since tokens signed with old secret are invalid).
   *
   * This is a manual emergency operation for security incidents.
   *
   * @returns Count of invalidated sessions
   */
  async rotateHmacSecret(): Promise<number> {
    logger.info('[Server] Rotating HMAC secret...');

    // 1. Generate new HMAC secret (same method as startup)
    const newSecret = crypto.randomBytes(64);

    // 2. Count all non-expired sessions before invalidation
    // SEC-M19-002: Must expire active, idle, AND spinning_down sessions
    const activeSessions = await this.db!.query.user_sessions.findMany({
      where: (s, { or, eq }) =>
        or(eq(s.status, 'active'), eq(s.status, 'idle'), eq(s.status, 'spinning_down')),
    });
    const sessionCount = activeSessions.length;

    // 3. Atomic invalidation: batch update all sessions + connections in transaction
    await compatTransaction(this.db!, async () => {
      const nowIso = new Date().toISOString();

      // Batch invalidate all active/idle/spinning_down sessions
      await compatUpdate(this.db!, user_sessions)
        .set({ status: 'expired' })
        .where(
          or(
            eq(user_sessions.status, 'active'),
            eq(user_sessions.status, 'idle'),
            eq(user_sessions.status, 'spinning_down')
          )
        );

      // Batch disconnect all connections
      await compatUpdate(this.db!, session_connections)
        .set({ status: 'disconnected', disconnected_at: nowIso })
        .where(eq(session_connections.status, 'connected'));
    });

    // 4. Update auth provider with new secret (after DB commit)
    if (this.authn && 'updateHmacSecret' in this.authn) {
      (this.authn as any).updateHmacSecret(newSecret);
    } else {
      throw new Error('Auth provider does not support HMAC secret rotation');
    }

    // 5. Update in-memory HMAC secret reference
    this.hmacSecret = newSecret;

    // 6. SEC-M19-001: Persist new secret to disk so it survives restarts
    persistHmacSecret(this.config.dataDir, newSecret);

    logger.info(`[Server] HMAC secret rotated, ${sessionCount} sessions invalidated`);
    return sessionCount;
  }

  /**
   * Stop the server
   */
  async stop(): Promise<void> {
    logger.info('[Server] Shutting down...');

    // Stop rate limit cleanup timer (Sprint 3.3)
    logger.info('[Server] Stopping rate limit cleanup timer...');
    stopRateLimitCleanup();

    // Stop session lifecycle manager (M15)
    if (this.lifecycleManager) {
      logger.info('[Server] Stopping session lifecycle manager...');
      this.lifecycleManager.stop();
      this.heartbeatRateLimit.clear();
    }

    // Shutdown providers first (flushes audit buffer)
    if (this.audit) {
      logger.info('[Server] Shutting down audit provider...');
      await this.audit.shutdown?.();
    }

    this.toolPinRediscovery?.stop();

    // M17.3: Shutdown per-user MCP pool first
    logger.info('[Server] Shutting down per-user MCP pool...');
    await this.userPool.shutdown();

    // Shutdown MCP connections
    await this.mcpManager.shutdown();

    // Close database
    if (this.db) {
      logger.info('[Server] Closing database...');
      await closeDatabase(this.db);
    }

    // Shutdown admin server
    if (this.adminServer) {
      await this.adminServer.close();
    }

    // Then shutdown HTTP server
    if (this.fastify) {
      await this.fastify.close();
    }

    logger.info('[Server] Shutdown complete');
  }

  /**
   * Get the main API Fastify instance (for testing)
   *
   * Returns the primary API server instance. Tests use this to inject
   * requests for API routes (/health, /v1/*).
   */
  getServer(): FastifyInstance {
    if (!this.fastify) {
      throw new Error('Server not initialized');
    }
    return this.fastify;
  }

  /**
   * Get the admin UI Fastify instance (for testing)
   *
   * Returns the admin UI server instance. Tests use this to inject
   * requests for admin UI and htmx routes. Falls back to the main
   * server if admin UI is disabled.
   */
  getAdminServer(): FastifyInstance {
    if (this.adminServer) {
      return this.adminServer;
    }
    // Fallback to main server when admin UI is disabled
    if (!this.fastify) {
      throw new Error('Server not initialized');
    }
    return this.fastify;
  }
}

/**
 * Module-level singleton reference for accessing server resources
 * from services that can't receive them via dependency injection
 */
let serverInstance: AmbassadorServer | null = null;

/**
 * Register the server instance (called during initialize())
 * @internal
 */
export function registerServerInstance(instance: AmbassadorServer): void {
  serverInstance = instance;
}

/**
 * Get the database client for services that need it
 * @internal
 */
export function getDb(): DatabaseClient | null {
  return serverInstance?.['db'] ?? null;
}

/**
 * Get the credential vault for services that need it
 * @internal
 */
export function getCredentialVault(): CredentialVault | null {
  return serverInstance?.['credentialVault'] ?? null;
}

/**
 * Get the OAuth token manager for services that need it
 * @internal
 */
export function getOAuthTokenManager(): OAuthTokenManager | null {
  return serverInstance?.['oauthTokenManager'] ?? null;
}

/**
 * Get the registry service for services that need it
 * @internal
 */
export function getRegistryService(): RegistryService | null {
  return serverInstance?.['registryService'] ?? null;
}
