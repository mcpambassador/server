/** M1 (#119): one CatalogReloader shared across both listeners serializes concurrent applies. */
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { registerAdminCatalogReloadRoutes } from '../../src/admin/catalog-reload-routes.js';
import type { CatalogReloader } from '../../src/services/catalog-reloader.js';
import { CatalogReloadConflictError } from '../../src/services/catalog-reloader.js';

describe('shared CatalogReloader across listeners', () => {
  it('a concurrent apply via the second listener gets 409 while the first runs', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    let busy = false;
    const reloader = {
      previewChanges: () => Promise.resolve({}),
      applyChanges: async () => {
        if (busy) throw new CatalogReloadConflictError();
        busy = true;
        try {
          await gate;
          return { summary: { failed: 0 } };
        } finally {
          busy = false;
        }
      },
    } as unknown as CatalogReloader;

    const mk = async () => {
      const app = Fastify();
      await app.register(registerAdminCatalogReloadRoutes, {
        db: {} as never,
        mcpManager: {} as never,
        userPool: {} as never,
        reloader,
      });
      return app;
    };
    const [a, b] = [await mk(), await mk()]; // stand-ins for the 8443 and 9443 registrations
    const first = a.inject({ method: 'POST', url: '/v1/admin/catalog/apply' });
    await new Promise(r => setTimeout(r, 10));
    const second = await b.inject({ method: 'POST', url: '/v1/admin/catalog/apply' });
    expect(second.statusCode).toBe(409);
    release();
    expect((await first).statusCode).toBe(200);
    await a.close();
    await b.close();
  });
});
