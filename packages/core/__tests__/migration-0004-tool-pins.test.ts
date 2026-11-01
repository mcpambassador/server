import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { runMigrations } from '../src/db/client.js';
import type { DatabaseClient } from '../src/db/client.js';

describe('migration 0004 (tool_pins)', () => {
  it('creates tool_pins, pin_policy default review, and a NULL-safe unique scope index', async () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    await runMigrations(drizzle(sqlite) as unknown as DatabaseClient);
    sqlite.exec(
      "INSERT INTO mcp_catalog (mcp_id,name,display_name,transport_type,config,created_at,updated_at) VALUES ('m1','m','M','stdio','{}','t','t')"
    );
    expect(sqlite.prepare("SELECT pin_policy FROM mcp_catalog WHERE mcp_id='m1'").get()).toEqual({
      pin_policy: 'review',
    });
    const ins = (): void =>
      void sqlite.exec(
        "INSERT INTO tool_pins (pin_id,mcp_id,scope_user_id,tool_name,status,first_seen_at,updated_at) VALUES (lower(hex(randomblob(8))),'m1',NULL,'t','pending_review','t','t')"
      );
    ins();
    expect(ins).toThrow(/UNIQUE/); // NULL scope is still unique per (mcp, tool)
    sqlite.exec("DELETE FROM mcp_catalog WHERE mcp_id='m1'");
    expect(sqlite.prepare('SELECT count(*) AS n FROM tool_pins').get()).toEqual({ n: 0 }); // cascade
  });
});
