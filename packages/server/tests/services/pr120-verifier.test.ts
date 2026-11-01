/** PR #120 verifier: the real server refuses to start on a tampered migration record, and an untracked DB boots twice. */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  startAgentTestServer,
  stopAgentTestServer,
  restartAgentTestServer,
  agentEndpointOpts,
  createUser,
  type AgentTestServer,
} from '../agent-endpoint/helpers.js';

let s: AgentTestServer | null = null;
afterEach(async () => {
  await stopAgentTestServer(s);
  s = null;
});

const open = (dir: string): Database.Database => new Database(path.join(dir, 'ambassador.db'));

describe('server boot with tracked migrations', () => {
  it('untracked (pre-TD-032) DB boots twice, keeps its data, records migrations once', async () => {
    const opts = agentEndpointOpts();
    s = await startAgentTestServer(opts);
    const u = await createUser(s, 'live');
    await s.stop();
    const db = open(s.dataDir);
    db.exec('DROP TABLE schema_migrations'); // make it look like the videl DB
    db.close();

    s = await restartAgentTestServer(s, opts);
    const a = open(s.dataDir);
    const first = a.prepare('SELECT * FROM schema_migrations ORDER BY filename').all();
    a.close();
    expect(first.length).toBeGreaterThanOrEqual(4);

    s = await restartAgentTestServer(s, opts);
    const b = open(s.dataDir);
    expect(b.prepare('SELECT * FROM schema_migrations ORDER BY filename').all()).toEqual(first);
    expect(b.prepare('SELECT user_id FROM users WHERE user_id=?').all(u.userId)).toHaveLength(1);
    b.close();
  });

  it('a tampered migration hash makes startup fail', async () => {
    const opts = agentEndpointOpts();
    s = await startAgentTestServer(opts);
    await s.stop();
    const db = open(s.dataDir);
    db.prepare("UPDATE schema_migrations SET sha256='deadbeef' WHERE filename LIKE '0002%'").run();
    db.close();
    await expect(restartAgentTestServer(s, opts)).rejects.toThrow(/modified after it was applied/);
  });
});
