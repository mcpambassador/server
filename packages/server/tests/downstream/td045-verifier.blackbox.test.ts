/**
 * TD-045 black-box (verifier): oversized stdio results fail fast with a bounded error, a flood does not
 * leave the shared MCP dead, a killed shared MCP respawns, and a normal 900KB result still passes.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AGENT_GRANTS_ROUTE } from '@mcpambassador/contracts';
import {
  startAgentTestServer,
  stopAgentTestServer,
  agentEndpointOpts,
  createUser,
  loginSession,
  type AgentTestServer,
} from '../agent-endpoint/helpers.js';
import {
  allowFakeMcpCommand,
  createFakeMcp,
  grantUserAccess,
  applyCatalog,
  createClientWithKey,
  subscribe,
  stdioSession,
  stdioInvoke,
  rpc,
} from '../agent-endpoint/fake-mcp-world.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 90_000 });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td045v-'));
const MB = 1024 * 1024;
const big = (bytes: number): string =>
  JSON.stringify({ content: [{ type: 'image', data: 'A'.repeat(bytes), mimeType: 'image/png' }] });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** pid of the live fake-mcp process serving `tool` (matched by its FAKE_MCP_TOOLS env), Linux only. */
function pidFor(tool: string): number | undefined {
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const env = fs.readFileSync(`/proc/${d}/environ`, 'utf8').split('\0');
      const cmd = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8');
      if (cmd.includes('fake-mcp') && env.includes(`FAKE_MCP_TOOLS=${tool}`)) return Number(d);
    } catch {
      /* process vanished or not readable */
    }
  }
  return undefined;
}

describe('TD-045 stdio size limits and respawn', () => {
  let s: AgentTestServer;
  let restoreEnv: () => void;
  let tok: string;
  let stdioTok: string;
  const call = (name: string) => rpc(s, tok, 'tools/call', { name, arguments: {} });

  beforeAll(async () => {
    restoreEnv = allowFakeMcpCommand();
    s = await startAgentTestServer(agentEndpointOpts());
    const au = await createUser(s, 'alice');
    const alice = await loginSession(s, au);
    const results: Record<string, string> = {
      big12: big(12 * MB),
      big5: big(5 * MB),
      big12b: big(12 * MB),
      img12: big(1.2 * MB),
      ok900: big(900 * 1024),
      killme: JSON.stringify({ content: [{ type: 'text', text: 'alive-after-kill' }] }),
      after: JSON.stringify({ content: [{ type: 'text', text: 'still-alive' }] }),
    };
    const ids: string[] = [];
    for (const [t, body] of Object.entries(results)) {
      const f = path.join(dir, `${t}.json`);
      fs.writeFileSync(f, body);
      const m = await createFakeMcp(s, { name: `v-${t}`, tools: [t], env: { FAKE_MCP_RESULT_FILE: f } });
      await grantUserAccess(s, au.userId, m.mcpId);
      ids.push(m.mcpId);
    }
    await applyCatalog(s);
    const client = await createClientWithKey(alice, 'c');
    for (const id of ids) await subscribe(alice, client.clientId, id);
    const g = await alice.request({
      method: 'POST',
      url: AGENT_GRANTS_ROUTE,
      payload: { bound_client_id: client.clientId, label: 'g', scopes: ['mcp:*'] },
    });
    tok = JSON.parse(g.body).data.access_token as string;
    stdioTok = await stdioSession(s, client.key);
  });
  afterAll(async () => {
    await stopAgentTestServer(s);
    restoreEnv();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a normal 900KB result still passes on /mcp and invoke', async () => {
    const r = await call('ok900');
    expect(r.json?.error).toBeUndefined();
    expect(r.json.result.content[0].data.length).toBe(900 * 1024);
    const i = await stdioInvoke(s, stdioTok, 'ok900');
    expect(i.statusCode).toBe(200);
    expect(JSON.parse(i.body).result[0].data.length).toBe(900 * 1024);
  });

  for (const t of ['img12', 'big5']) {
    it(`${t}: fails fast (<10s) with "Response too large" on /mcp and invoke, and the MCP serves the next call`, async () => {
      let t0 = Date.now();
      const r = await call(t);
      expect(Date.now() - t0, `/mcp ${t}`).toBeLessThan(10_000);
      const text = JSON.stringify(r.json);
      expect(text).toContain('Response too large');
      expect(text.length).toBeLessThan(64 * 1024);
      expect(text).not.toContain('AAAAAAAAAA');
      t0 = Date.now();
      const i = await stdioInvoke(s, stdioTok, t);
      expect(Date.now() - t0, `invoke ${t}`).toBeLessThan(10_000);
      expect(i.body).toContain('Response too large');
      expect(i.body).not.toContain('AAAAAAAAAA');
      // same MCP serves again (a normal-size call is not possible on this tool, so a repeat must fail fast again)
      t0 = Date.now();
      expect(JSON.stringify((await call(t)).json)).toContain('Response too large');
      expect(Date.now() - t0).toBeLessThan(10_000);
      expect(JSON.stringify((await call('after')).json)).toContain('still-alive');
    });
  }

  it('a 12MB result does not leave the shared MCP dead: fails bounded, and the tool answers again within 30s', async () => {
    const t0 = Date.now();
    const r = await call('big12');
    expect(Date.now() - t0).toBeLessThan(15_000);
    const text = JSON.stringify(r.json);
    expect(text).toContain('Response too large');
    expect(text.length).toBeLessThan(64 * 1024);
    const i = await stdioInvoke(s, stdioTok, 'big12b');
    expect(i.body).toContain('Response too large');
    // availability: the MCP is not "unavailable / not subscribed" afterwards (it answers, even if with the same bounded error)
    const deadline = Date.now() + 30_000;
    let last = '';
    for (;;) {
      last = JSON.stringify((await call('big12')).json);
      if (last.includes('Response too large')) break;
      if (Date.now() > deadline) throw new Error(`still unavailable after 30s: ${last.slice(0, 200)}`);
      await sleep(1000);
    }
    expect(JSON.stringify((await call('after')).json)).toContain('still-alive');
  });

  it('a shared MCP killed externally respawns', async () => {
    expect(JSON.stringify((await call('killme')).json)).toContain('alive-after-kill');
    const pid = pidFor('killme');
    expect(pid, 'found fake-mcp pid for killme').toBeTruthy();
    process.kill(pid!, 'SIGKILL');
    const deadline = Date.now() + 45_000;
    let last = '';
    const t0 = Date.now();
    for (;;) {
      last = JSON.stringify((await call('killme')).json);
      if (last.includes('alive-after-kill')) break;
      if (Date.now() > deadline) throw new Error(`no respawn within 45s: ${last.slice(0, 200)}`);
      await sleep(1000);
    }
    const took = Date.now() - t0;
    expect(took).toBeLessThan(45_000);
    const pid2 = pidFor('killme');
    expect(pid2).toBeTruthy();
    expect(pid2).not.toBe(pid);
  });
});
