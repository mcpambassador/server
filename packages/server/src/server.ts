/* eslint-disable no-console, @typescript-eslint/no-floating-promises, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/require-await, @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-function-return-type */

import Fastify, { FastifyInstance, FastifyRequest } from 'fastify';
import fastifyCors from '@fastify/cors';
import { initializeTls } from './tls.js';
import { DownstreamMcpManager, type DownstreamMcpConfig } from './downstream/index.js';
import path from 'path';
import { fileURLToPath } from 'node:url';
import {
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
  type PipelineToolInvocationRequest,
  getEffectiveProfile,
  AuthorizationError,
} from '@mcpambassador/core';
import { ApiKeyAuthProvider } from '@mcpambassador/authn-apikey';
import { LocalRbacProvider } from '@mcpambassador/authz-local';
import { FileAuditProvider } from '@mcpambassador/audit-file';
import type { ToolCatalogResponse, ToolDescriptor } from '@mcpambassador/protocol';
import { BoundedSessionStore } from './admin/session.js';
import { KillSwitchManager } from './admin/kill-switch-manager.js';

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
   * Trust X-Forwarded-For header for source IP (F-SEC-M6-020 remediation)
   * - false (default): Ignore X-Forwarded-For, use direct connection IP
   * - true: Trust first IP in X-Forwarded-For (use only if behind trusted proxy)
   * - string[]: Trust X-Forwarded-For only if request comes from these CIDR ranges
   *
   * WARNING: Trusting X-Forwarded-For without proxy validation allows IP spoofing
   */
  trustProxy?: boolean | string[];
  /** Admin UI port (defaults to 9443, 0 for ephemeral) */
  adminPort?: number;
  /** Enable admin UI (defaults to true) */
  adminUiEnabled?: boolean;
}

export class AmbassadorServer {
  private fastify: FastifyInstance | null = null;
  private adminServer: FastifyInstance | null = null;
  private mcpManager: DownstreamMcpManager;
  private config: Required<ServerConfig> & { adminPort: number; adminUiEnabled: boolean };
  private db: DatabaseClient | null = null;
  private authn: AuthenticationProvider | null = null;
  private authz: AuthorizationProvider | null = null;
  private audit: AuditProvider | null = null;
  private pipeline: Pipeline | null = null;
  private killSwitchManager: KillSwitchManager; // CR-M10-001
  private sessionStore: BoundedSessionStore | null = null; // F-SEC-M10-005

  constructor(config: ServerConfig) {
    this.config = {
      host: config.host || '0.0.0.0',
      port: config.port || 8443,
      dataDir: config.dataDir,
      serverName: config.serverName || 'localhost',
      logLevel: config.logLevel || 'info',
      downstreamMcps: config.downstreamMcps || [],
      dbPath: config.dbPath || path.join(config.dataDir, 'ambassador.db'),
      trustProxy: config.trustProxy || false,
      adminPort: config.adminPort ?? 9443,
      adminUiEnabled: config.adminUiEnabled ?? true,
    };

    this.mcpManager = new DownstreamMcpManager();
    this.killSwitchManager = new KillSwitchManager(); // CR-M10-001: Initialize shared manager
  }

  /**
   * Initialize server with TLS and routing
   */
  async initialize(): Promise<void> {
    console.log('[Server] Initializing MCP Ambassador Server...');

    // Initialize TLS certificates
    const certDir = path.join(this.config.dataDir, 'certs');
    const tlsCerts = await initializeTls({
      caPath: path.join(certDir, 'ca.pem'),
      certPath: path.join(certDir, 'server.pem'),
      keyPath: path.join(certDir, 'server-key.pem'),
      serverName: this.config.serverName,
    });

    console.log(`[TLS] CA Fingerprint: ${tlsCerts.caFingerprint}`);
    console.log('[TLS] Store this fingerprint for client TOFU trust prompt');

    // Create Fastify instance with HTTPS + TLS
    this.fastify = Fastify({
      logger: {
        level: this.config.logLevel,
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
    console.log(`[Server] Initializing database: ${this.config.dbPath}`);
    this.db = await initializeDatabase({
      type: 'sqlite',
      sqliteFilePath: this.config.dbPath,
      enableWAL: true,
      seedOnInit: true,
    });

    // Run database migrations (creates tables if needed)
    console.log('[Server] Running database migrations...');
    await runMigrations(this.db as DatabaseClient);

    // Seed default profiles if needed
    console.log('[Server] Seeding database...');
    await seedDatabaseIfNeeded(this.db as DatabaseClient, {
      type: 'sqlite',
      seedOnInit: true,
    });

    // Bootstrap admin key on first boot
    await this.bootstrapAdminKey();

    // Initialize AAA providers
    console.log('[Server] Initializing AAA providers...');
    this.authn = new ApiKeyAuthProvider(this.db);
    this.authz = new LocalRbacProvider(this.db);
    this.audit = new FileAuditProvider({
      auditDir: path.join(this.config.dataDir, 'audit'),
      retention: 90,
    });

    await this.authn!.initialize({ id: 'api_key_auth' });
    await this.authz!.initialize({ id: 'local_rbac' });
    await this.audit!.initialize({ id: 'file_audit' });

    // Initialize AAA pipeline
    this.pipeline = new Pipeline(this.authn!, this.authz!, this.audit!, {
      audit_on_failure: 'buffer', // Fail-open for audit (M5 behavior)
    });

    console.log('[Server] AAA providers initialized');
    console.log('[Server] Pipeline initialized (available for M6.5)');

    // Initialize downstream MCP connections
    console.log(
      `[Server] Initializing ${this.config.downstreamMcps.length} downstream MCP connections...`
    );
    await this.mcpManager.initialize(this.config.downstreamMcps);

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

    console.log('[Server] Initialization complete');
  }

  /**
   * Initialize admin UI server (M10)
   * 
   * Creates separate Fastify instance on adminPort with:
   * - Session management
   * - EJS view rendering
   * - Static file serving
   * - UI and htmx routes
   * - Security headers
   * 
   * @see ADR-007 Admin UI Technology Selection (EJS + htmx)
   * @see ADR-008 Admin UI Routing (Dedicated Port 9443)
   */
  private async initializeAdminServer(tlsCerts: { key: string; cert: string; ca: string }): Promise<void> {
    console.log('[Admin] Initializing admin UI server...');

    // Import required plugins
    const fastifyView = (await import('@fastify/view')).default;
    const fastifyStatic = (await import('@fastify/static')).default;
    const fastifyFormbody = (await import('@fastify/formbody')).default;
    const fastifyCookie = (await import('@fastify/cookie')).default;
    const fastifySession = (await import('@fastify/session')).default;
    const ejs = (await import('ejs')).default;

    // Import admin modules
    const { getOrCreateSessionSecret } = await import('./admin/session.js');
    const { registerUiRoutes } = await import('./admin/ui-routes.js');
    const { registerHtmxRoutes } = await import('./admin/htmx-routes.js');

    // Create session store instance if not already created (F-SEC-M10-005)
    if (!this.sessionStore) {
      this.sessionStore = new BoundedSessionStore(100);
    }

    // Create admin Fastify instance with same TLS config
    this.adminServer = Fastify({
      logger: {
        level: this.config.logLevel,
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

    // Register cookie support
    await this.adminServer.register(fastifyCookie);

    // F-SEC-M10-001: Use secure session secret (env var or generated)
    await this.adminServer.register(fastifySession, {
      secret: getOrCreateSessionSecret(this.config.dataDir),
      cookie: {
        secure: true,
        httpOnly: true,
        sameSite: 'strict',
        path: '/admin',
      },
      store: this.sessionStore,
      saveUninitialized: false, // SEC-M10-07: Don't create session on anonymous requests
    });

    // Register form body parser
    await this.adminServer.register(fastifyFormbody);

    // Determine view paths relative to this source file
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const viewsPath = path.join(__dirname, '..', 'views');
    const publicPath = path.join(__dirname, '..', 'public');

    // Register view engine (EJS)
    await this.adminServer.register(fastifyView, {
      engine: {
        ejs,
      },
      root: viewsPath,
      options: {
        filename: viewsPath,
      },
    });

    // Register static file serving
    await this.adminServer.register(fastifyStatic, {
      root: publicPath,
      prefix: '/',
    });

    // Security headers hook (SEC-M10-01, SEC-M10-10)
    this.adminServer.addHook('onSend', async (_request, reply, payload) => {
      // SEC-M10-01: Content Security Policy
      reply.header(
        'Content-Security-Policy',
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'self'"
      );

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
    });

    // Register UI routes
    await registerUiRoutes(this.adminServer, {
      db: this.db!,
      mcpManager: this.mcpManager,
      dataDir: this.config.dataDir,
      audit: this.audit!, // F-SEC-M10-004
      killSwitchManager: this.killSwitchManager, // CR-M10-001
      sessionStore: this.sessionStore, // F-SEC-M10-005
    });

    // Register htmx fragment routes
    await registerHtmxRoutes(this.adminServer, {
      db: this.db!,
      killSwitchManager: this.killSwitchManager, // CR-M10-001
    });

    console.log('[Admin] Admin UI server initialized');
  }

  /**
   * Extract source IP from request, respecting trustProxy configuration
   *
   * Security: F-SEC-M6-020 remediation + F-SEC-P1-001 fix
   * - If trustProxy is false (default): Use only request.ip (direct connection)
   * - If trustProxy is true: Trust first IP in X-Forwarded-For header
   * - Always falls back to '0.0.0.0' if no IP available
   *
   * @param request - Fastify request object
   * @returns Source IP address as string
   */
  private getSourceIp(request: FastifyRequest): string {
    if (this.config.trustProxy) {
      // Trust X-Forwarded-For (first IP in comma-separated list)
      const forwardedHeader = request.headers['x-forwarded-for'];
      const forwardedFor =
        (Array.isArray(forwardedHeader) ? forwardedHeader[0] : forwardedHeader) ||
        request.ip ||
        '0.0.0.0';
      return forwardedFor.split(',')[0]?.trim() || '0.0.0.0';
      // TODO: If trustProxy is string[], validate request.ip is in trusted CIDR ranges
    } else {
      // Default: Ignore X-Forwarded-For, use direct connection IP
      return request.ip ?? '0.0.0.0';
    }
  }

  /**
   * Authentication helper - extracts and validates auth from request
   * Returns SessionContext on success, throws 401 on failure
   */
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
    // CLIENT REGISTRATION (no auth required - this is how clients get API keys)
    // ==========================================================================

    // F-SEC-M6-025 remediation: Rate limiting required when registration is implemented
    // TODO: Add rate limiter before registration (e.g., @fastify/rate-limit) to prevent:
    //   - DoS attacks via registration flooding
    //   - API key exhaustion attacks
    //   - Resource consumption (DB writes, email sends, etc.)
    // Recommended: 5 requests per IP per hour, with exponential backoff on repeated violations

    this.fastify.post('/v1/clients/register', async (_request, reply) => {
      // M6: Stub implementation - will be completed with client registration logic
      reply.status(501).send({
        error: 'Not Implemented',
        message: 'Client registration endpoint - M6 implementation pending',
      });
    });

    // ==========================================================================
    // MCP ENDPOINTS (authenticated)
    // ==========================================================================

    // Tool catalog endpoint (M6.4)
    this.fastify.get('/v1/tools', async (request, reply) => {
      try {
        // Authenticate request
        const session = await this.authenticate(request);

        // Get client's effective profile
        if (!this.db || !this.authz) {
          throw new Error('Server not properly initialized');
        }

        const profile = await getEffectiveProfile(this.db, session.client_id);

        if (!profile) {
          reply.status(403).send({
            error: 'Forbidden',
            message: 'No profile assigned to client',
          });
          return;
        }

        // Get aggregated tool catalog from downstream MCPs
        const aggregatedTools = this.mcpManager.getToolCatalog();

        // Filter tools based on client's profile
        // Check each tool against allowed_tools (glob patterns) and denied_tools
        const allowedTools: ToolDescriptor[] = [];

        for (const tool of aggregatedTools) {
          // Use authz provider to check if tool is allowed
          const authzResult = await this.authz.authorize(session, {
            tool_name: tool.name,
            tool_arguments: {}, // Not needed for catalog check
          });

          if (authzResult.decision === 'permit') {
            // Transform from AggregatedTool to protocol ToolDescriptor
            allowedTools.push({
              name: tool.name,
              description: tool.description || '',
              input_schema: tool.inputSchema,
              metadata: {
                mcp_server: tool.source_mcp,
              },
            });
          }
        }

        // Return tool catalog
        const response: ToolCatalogResponse = {
          tools: allowedTools,
          api_version: '1.0',
          timestamp: new Date().toISOString(),
        };

        reply.send(response);
      } catch (err) {
        if (err instanceof Error && err.message === 'Unauthorized') {
          reply.status(401).send({
            error: 'Unauthorized',
            message:
              'Valid API key required. Include X-API-Key or Authorization: Bearer <key> header.',
          });
        } else {
          console.error('[/v1/tools] Error:', err);
          reply.status(500).send({
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
          reply.status(415).send({
            error: 'Unsupported Media Type',
            message: 'Content-Type must be application/json',
          });
          return;
        }

        // Validate request body
        const body = request.body as any;
        if (!body || typeof body !== 'object') {
          reply.status(400).send({
            error: 'Bad Request',
            message: 'Request body must be a JSON object',
          });
          return;
        }

        if (!body.tool || typeof body.tool !== 'string') {
          reply.status(400).send({
            error: 'Bad Request',
            message: 'Missing or invalid "tool" field',
          });
          return;
        }

        if (!body.arguments || typeof body.arguments !== 'object') {
          reply.status(400).send({
            error: 'Bad Request',
            message: 'Missing or invalid "arguments" field',
          });
          return;
        }

        // Authenticate request
        const session = await this.authenticate(request);

        // F-SEC-M5-007: Validate client_id from session (defense-in-depth)
        if (!session.client_id || typeof session.client_id !== 'string') {
          reply.status(500).send({
            error: 'Internal Server Error',
            message: 'Invalid session context',
          });
          return;
        }

        // Transform protocol request → pipeline internal request
        const pipelineRequest: PipelineToolInvocationRequest = {
          tool_name: body.tool,
          client_id: session.client_id,
          arguments: body.arguments,
        };

        // Build AuthRequest
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(request.headers)) {
          if (typeof value === 'string') {
            headers[key] = value;
          }
        }
        // Use centralized sourceIp extraction (F-SEC-P1-001 fix)
        const sourceIp = this.getSourceIp(request);

        const authRequest = {
          headers,
          sourceIp,
        };

        // Create router function for pipeline
        const router = async (toolName: string, args: Record<string, unknown>) => {
          const mcpRequest = {
            tool_name: toolName,
            arguments: args,
          };

          const mcpResponse = await this.mcpManager.invokeTool(mcpRequest);

          // Get MCP name from tool catalog
          const tool = this.mcpManager.getToolDescriptor(toolName);

          return {
            content: mcpResponse.content,
            isError: mcpResponse.isError,
            mcpServer: tool?.source_mcp,
          };
        };

        // Invoke through AAA pipeline (with null check for pipeline)
        if (!this.pipeline) {
          reply.status(500).send({
            error: 'Internal Server Error',
            message: 'Pipeline not initialized',
          });
          return;
        }

        const response = await this.pipeline.invoke(pipelineRequest, authRequest, router);

        reply.send(response);
      } catch (err) {
        if (err instanceof Error && err.message === 'Unauthorized') {
          reply.status(401).send({
            error: 'Unauthorized',
            message: 'Valid API key required',
          });
        } else if (err instanceof AuthorizationError) {
          // F-SEC-M5-009: Sanitize reason field (don't expose internal rules)
          // F-SEC-M6-021 remediation: Use instanceof instead of string matching
          reply.status(403).send({
            error: 'Forbidden',
            message: 'Access denied',
          });
        } else {
          console.error('[/v1/tools/invoke] Error:', err);
          // F-SEC-M5-009: Generic error message (don't expose internals)
          reply.status(500).send({
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
    await this.fastify.register(
      adminRoutes,
      {
        db: this.db!,
        audit: this.audit!,
        mcpManager: this.mcpManager,
        dataDir: this.config.dataDir,
        killSwitchManager: this.killSwitchManager, // CR-M10-001
      }
    );

    // F-SEC-M6-005: Detailed health endpoint (admin only)
    this.fastify.get('/v1/admin/health', async (request, reply) => {
      try {
        // Authentication required (F-SEC-M6.6 remediation)
        await this.authenticate(request);

        reply.send({
          status: 'ok',
          version: '0.1.0',
          mcp_status: this.mcpManager.getStatus(),
        });
      } catch (err) {
        if (err instanceof Error && err.message === 'Unauthorized') {
          reply.status(401).send({
            error: 'Unauthorized',
            message: 'Valid API key required',
          });
        } else {
          console.error('[/v1/admin/health] Error:', err);
          reply.status(500).send({
            error: 'Internal Server Error',
            message: 'Health check failed',
          });
        }
      }
    });

    console.log('[Router] All routes registered');
  }

  /**
   * Start the server
   */
  async start(): Promise<void> {
    if (!this.fastify) {
      throw new Error('Server not initialized - call initialize() first');
    }

    try {
      await this.fastify.listen({
        host: this.config.host,
        port: this.config.port,
      });

      console.log(`[Server] Listening on https://${this.config.host}:${this.config.port}`);

      // Start admin UI server if enabled
      if (this.adminServer) {
        await this.adminServer.listen({
          host: this.config.host,
          port: this.config.adminPort,
        });

        console.log(`[Admin] Admin UI listening on https://${this.config.host}:${this.config.adminPort}`);
      }
    } catch (err) {
      console.error('[Server] Failed to start:', err);
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
      const row = client.prepare('SELECT COUNT(*) as cnt FROM admin_keys WHERE is_active = 1').get();
      hasKey = row?.cnt > 0;
    }

    if (hasKey) {
      console.log('[Server] Admin key already exists');
      return;
    }

    // First boot — generate admin key
    console.log('[Server] First boot detected — generating admin key...');
    const { admin_key, recovery_token } = await createAdminKey(
      this.db! as DatabaseClient,
      this.config.dataDir
    );

    // Print to stdout ONLY (security: never logged, never stored in plaintext)
    console.log('');
    console.log('======================================================================');
    console.log('           FIRST BOOT — ADMIN CREDENTIALS (shown only once!)');
    console.log('======================================================================');
    console.log(`  Admin Key:      ${admin_key}`);
    console.log(`  Recovery Token: ${recovery_token}`);
    console.log(`  Recovery file:  ${this.config.dataDir}/.recovery-token`);
    console.log('');
    console.log('  ⚠  SAVE THESE NOW — they will NOT be shown again!');
    console.log('======================================================================');
    console.log('');
  }

  /**
   * Stop the server
   */
  async stop(): Promise<void> {
    console.log('[Server] Shutting down...');

    // Shutdown providers first (flushes audit buffer)
    if (this.audit) {
      console.log('[Server] Shutting down audit provider...');
      await this.audit.shutdown?.();
    }

    // Shutdown MCP connections
    await this.mcpManager.shutdown();

    // Close database
    if (this.db) {
      console.log('[Server] Closing database...');
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

    console.log('[Server] Shutdown complete');
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
