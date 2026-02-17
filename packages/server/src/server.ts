import Fastify, { FastifyInstance, FastifyRequest } from 'fastify';
import fastifyCors from '@fastify/cors';
import { initializeTls } from './tls.js';
import { DownstreamMcpManager, type DownstreamMcpConfig } from './downstream/index.js';
import path from 'path';
import {
  initializeDatabase,
  closeDatabase,
  Pipeline,
  type DatabaseClient,
  type AuthenticationProvider,
  type AuthorizationProvider,
  type AuditProvider,
  type SessionContext,
  type PipelineToolInvocationRequest,
  getEffectiveProfile,
} from '@mcpambassador/core';
import { ApiKeyAuthProvider } from '@mcpambassador/authn-apikey';
import { LocalRbacProvider } from '@mcpambassador/authz-local';
import { FileAuditProvider } from '@mcpambassador/audit-file';
import type { 
  ToolCatalogResponse, 
  ToolDescriptor,
} from '@mcpambassador/protocol';

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
}

export class AmbassadorServer {
  private fastify: FastifyInstance | null = null;
  private mcpManager: DownstreamMcpManager;
  private config: Required<ServerConfig>;
  private db: DatabaseClient | null = null;
  private authn: AuthenticationProvider | null = null;
  private authz: AuthorizationProvider | null = null;
  private audit: AuditProvider | null = null;
  private pipeline: Pipeline | null = null;
  
  constructor(config: ServerConfig) {
    this.config = {
      host: config.host || '0.0.0.0',
      port: config.port || 8443,
      dataDir: config.dataDir,
      serverName: config.serverName || 'localhost',
      logLevel: config.logLevel || 'info',
      downstreamMcps: config.downstreamMcps || [],
      dbPath: config.dbPath || path.join(config.dataDir, 'ambassador.db'),
    };
    
    this.mcpManager = new DownstreamMcpManager();
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
    
    // Initialize AAA providers
    console.log('[Server] Initializing AAA providers...');
    this.authn = new ApiKeyAuthProvider(this.db);
    this.authz = new LocalRbacProvider(this.db);
    this.audit = new FileAuditProvider({
      logDir: path.join(this.config.dataDir, 'audit'),
      maxFileSizeMb: 100,
      retentionDays: 90,
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
    console.log(`[Server] Initializing ${this.config.downstreamMcps.length} downstream MCP connections...`);
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
    
    console.log('[Server] Initialization complete');
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
    
   // Extract source IP (handle X-Forwarded-For if behind proxy)
    const sourceIp = (headers['x-forwarded-for'] ?? request.ip ?? '0.0.0.0').split(',')[0].trim();
    
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
            message: 'Valid API key required. Include X-API-Key or Authorization: Bearer <key> header.',
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
        const sourceIp = (headers['x-forwarded-for'] ?? request.ip ?? '0.0.0.0').split(',')[0].trim();
        
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
        } else if (err instanceof Error && err.message.includes('AuthorizationError')) {
          // F-SEC-M5-009: Sanitize reason field (don't expose internal rules)
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
    // Deferred M5 endpoints: M5.2-M5.4, M5.6
    // ==========================================================================
    
    // M5.2: Profile CRUD
    this.fastify.get('/v1/admin/profiles', async (_request, reply) => {
      reply.status(501).send({
        error: 'Not Implemented',
        message: 'Profile list endpoint - M5.2 deferred to M6',
      });
    });
    
    this.fastify.get('/v1/admin/profiles/:profileId', async (_request, reply) => {
      reply.status(501).send({
        error: 'Not Implemented',
        message: 'Profile get endpoint - M5.2 deferred to M6',
      });
    });
    
    this.fastify.post('/v1/admin/profiles', async (_request, reply) => {
      reply.status(501).send({
        error: 'Not Implemented',
        message: 'Profile create endpoint - M5.2 deferred to M6',
      });
    });
    
    this.fastify.patch('/v1/admin/profiles/:profileId', async (_request, reply) => {
      reply.status(501).send({
        error: 'Not Implemented',
        message: 'Profile update endpoint - M5.2 deferred to M6',
      });
    });
    
    this.fastify.delete('/v1/admin/profiles/:profileId', async (_request, reply) => {
      reply.status(501).send({
        error: 'Not Implemented',
        message: 'Profile delete endpoint - M5.2 deferred to M6',
      });
    });
    
    // M5.3: Kill switch
    this.fastify.post('/v1/admin/kill-switch/:target', async (_request, reply) => {
      reply.status(501).send({
        error: 'Not Implemented',
        message: 'Kill switch endpoint - M5.3 deferred to M6',
      });
    });
    
    // F-SEC-M6-005: Detailed health endpoint (admin only)
    this.fastify.get('/v1/admin/health', async (_request, reply) => {
      // TODO: Add authentication check when AAA pipeline integrated
      reply.send({
        status: 'ok',
        version: '0.1.0',
        mcp_status: this.mcpManager.getStatus(),
      });
    });
    
    // M5.4: Client lifecycle
    this.fastify.patch('/v1/clients/:clientId/status', async (_request, reply) => {
      reply.status(501).send({
        error: 'Not Implemented',
        message: 'Client lifecycle endpoint - M5.4 deferred to M6',
      });
    });
    
    // M5.6: Audit query
    this.fastify.get('/v1/audit/events', async (_request, reply) => {
      reply.status(501).send({
        error: 'Not Implemented',
        message: 'Audit query endpoint - M5.6 deferred to M6',
      });
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
      
      console.log(
        `[Server] Listening on https://${this.config.host}:${this.config.port}`
      );
    } catch (err) {
      console.error('[Server] Failed to start:', err);
      throw err;
    }
  }
  
  /**
   * Stop the server
   */
  async stop(): Promise<void> {
    console.log('[Server] Shutting down...');
    
    // Shutdown providers first (flushes audit buffer)
    if (this.audit) {
      console.log('[Server] Shutting down audit provider...');
      await this.audit!.shutdown();
    }
    
    // Shutdown MCP connections
    await this.mcpManager.shutdown();
    
    // Close database
    if (this.db) {
      console.log('[Server] Closing database...');
      await closeDatabase(this.db);
    }
    
    // Then shutdown HTTP server
    if (this.fastify) {
      await this.fastify.close();
    }
    
    console.log('[Server] Shutdown complete');
  }
  
  /**
   * Get the Fastify instance (for testing)
   */
  getServer(): FastifyInstance {
    if (!this.fastify) {
      throw new Error('Server not initialized');
    }
    return this.fastify;
  }
}
