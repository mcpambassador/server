import path from 'path';
import { fileURLToPath } from 'url';
import type { FastifyInstance } from 'fastify';
import fs from 'fs';

/**
 * M24.10: SPA Handler
 * Serves the React SPA for routes matching /app/*
 */
export async function registerSpaHandler(fastify: FastifyInstance): Promise<void> {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  
  // Look for SPA dist in multiple locations:
  // 1. Development: packages/spa/dist (relative to server package)
  // 2. Production/Docker: /app/public/spa
  const devPath = path.join(__dirname, '..', '..', '..', 'spa', 'dist');
  const prodPath = '/app/public/spa';
  
  let spaDistPath: string | null = null;
  
  if (fs.existsSync(devPath)) {
    spaDistPath = devPath;
    console.log('[SPA] Found SPA dist at:', devPath);
  } else if (fs.existsSync(prodPath)) {
    spaDistPath = prodPath;
    console.log('[SPA] Found SPA dist at:', prodPath);
  } else {
    console.log('[SPA] No SPA dist found, skipping SPA handler');
    return;
  }
  
  // H-2 fix: Add Content-Security-Policy headers for SPA routes
  fastify.addHook('onSend', async (request, reply) => {
    if (request.url.startsWith('/app')) {
      reply.header(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
      );
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('X-Frame-Options', 'DENY');
      reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    }
  });

  // Register static file serving for SPA assets
  const fastifyStatic = (await import('@fastify/static')).default;
  await fastify.register(fastifyStatic, {
    root: spaDistPath,
    prefix: '/app/',
    decorateReply: false, // Avoid conflict with admin server's static
    wildcard: false, // Only serve actual files; fallback handled below
    setHeaders: (res, filepath) => {
      // Cache static assets but not index.html
      if (filepath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      } else if (filepath.includes('/assets/')) {
        // Content-hashed assets are immutable (SPA-002 fix)
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        // Other static assets: 30 days
        res.setHeader('Cache-Control', 'public, max-age=2592000');
      }
    },
  });
  
  // Read index.html once for SPA fallback routing
  const indexHtml = fs.readFileSync(path.join(spaDistPath, 'index.html'), 'utf-8');
  
  // Root redirect to SPA (SPA-001 fix: check auth before redirect)
  fastify.get('/', async (request, reply) => {
    const userId = request.session?.userId;
    return reply.redirect(userId ? '/app/dashboard' : '/app/login');
  });
  
  // SPA fallback for /login route (React Router defines it at root level)
  fastify.get('/login', async (_request, reply) => {
    return reply.type('text/html').header('Cache-Control', 'no-cache').send(indexHtml);
  });
  
  // SPA fallback for all unmatched GET requests (client-side routes)
  // This catches routes like /app/dashboard, /app/admin/users, etc.
  fastify.setNotFoundHandler(async (request, reply) => {
    // Only serve SPA for GET requests that aren't API routes
    if (request.method === 'GET' && !request.url.startsWith('/v1/') && !request.url.startsWith('/health')) {
      return reply.type('text/html').header('Cache-Control', 'no-cache').send(indexHtml);
    }
    // Return proper 404 for API routes and non-GET requests
    return reply.status(404).send({
      error: 'Not Found',
      message: `Route ${request.method}:${request.url} not found`,
      statusCode: 404,
    });
  });
  
  console.log('[SPA] Handler registered with fallback routing');
}
