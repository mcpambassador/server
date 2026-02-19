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
  
  // Register static file serving for SPA assets
  const fastifyStatic = (await import('@fastify/static')).default;
  await fastify.register(fastifyStatic, {
    root: spaDistPath,
    prefix: '/app/',
    decorateReply: false, // Avoid conflict with admin server's static
    setHeaders: (res, filepath) => {
      // Cache static assets but not index.html
      if (filepath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      } else {
        res.setHeader('Cache-Control', 'public, max-age=31536000');
      }
    },
  });
  
  // SPA catch-all: /app/* → index.html
  // This must come AFTER all API routes so it doesn't intercept API calls
  fastify.get('/app/*', async (_request, reply) => {
    return reply.sendFile('index.html');
  });
  
  // Root redirect to SPA
  fastify.get('/', async (_request, reply) => {
    return reply.redirect('/app/dashboard');
  });
  
  console.log('[SPA] Handler registered');
}
