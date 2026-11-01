/**
 * ADR-020 phase 5: audit lifecycle/failure events carry reasons, and no raw
 * amb_at_/amb_rt_/auth codes/verifiers ever reach audit files, the DB, or logs (hashes only).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import {
  AGENT_MCP_ROUTE,
  AGENT_GRANTS_ROUTE,
  ADMIN_OAUTH_CLIENTS_ROUTE,
  AGENT_AUDIT_ACTIONS,
} from '@mcpambassador/contracts';
import {
  startAgentTestServer,
  stopAgentTestServer,
  agentEndpointOpts,
  createUser,
  loginSession,
  itImpl,
  TEST_RESOURCE_BASE,
  type AgentTestServer,
  type UserSession,
} from './helpers.js';
import {
  registerAdminClient,
  startAuthorize,
  approveAndGetCode,
  exchangeCode,
  refresh,
  revoke,
  pkce,
  boundClientId,
} from './oauth-flow-helpers.js';

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** Raw bytes of every file under the data dir (audit jsonl, sqlite db/wal, etc.). */
function dataDirBytes(dir: string): string {
  return walk(dir)
    .map(f => fs.readFileSync(f).toString('latin1'))
    .join('\n');
}

function auditLines(s: AgentTestServer): string[] {
  const f = path.join(s.dataDir, 'audit', 'audit.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) : [];
}

/** Audit is flushed on an interval; poll until a line containing all needles appears. */
async function waitForAudit(s: AgentTestServer, ...needles: string[]): Promise<string> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const hit = auditLines(s).find(l => needles.every(n => l.includes(n)));
    if (hit) return hit;
    if (Date.now() > deadline) {
      throw new Error(`audit line with ${needles.join(' + ')} not found`);
    }
    await new Promise(r => setTimeout(r, 250));
  }
}

// waitForAudit polls up to 15s; the 5s default would time out before an audit flush lands
vi.setConfig({ testTimeout: 30_000 });

const sha = (t: string): string => createHash('sha256').update(t).digest('hex');

describe('audit: contract action list is well-formed', () => {
  it('every contract action name is unique snake_case', () => {
    expect(new Set(AGENT_AUDIT_ACTIONS).size).toBe(AGENT_AUDIT_ACTIONS.length);
    for (const a of AGENT_AUDIT_ACTIONS) expect(a).toMatch(/^[a-z]+(_[a-z]+)+$/);
  });
});

describe('audit lifecycle events + no token leakage', () => {
  let s: AgentTestServer;
  let alice: UserSession;
  let clientId: string;
  const secrets: string[] = [];
  let logged = '';
  const spies: Array<{ mockRestore(): void }> = [];

  beforeAll(async () => {
    for (const stream of [process.stdout, process.stderr] as const) {
      const orig = stream.write.bind(stream);
      spies.push(
        vi.spyOn(stream, 'write').mockImplementation(((chunk: unknown, ...rest: never[]) => {
          logged += String(chunk);
          return (orig as (c: unknown, ...r: never[]) => boolean)(chunk, ...rest);
        }) as never)
      );
    }
    s = await startAgentTestServer(agentEndpointOpts());
    alice = await loginSession(s, await createUser(s, 'alice'));
    clientId = await registerAdminClient(s);
  });
  afterAll(async () => {
    await stopAgentTestServer(s);
    for (const sp of spies) sp.mockRestore();
  });

  async function issue(): Promise<{ access: string; refreshTok: string }> {
    const { verifier, challenge } = pkce();
    const { requestId } = await startAuthorize(s, alice, {
      client_id: clientId,
      code_challenge: challenge,
    });
    const { code } = await approveAndGetCode(alice, requestId);
    secrets.push(code, verifier);
    const res = await exchangeCode(s, { client_id: clientId, code, verifier });
    const b = JSON.parse(res.body);
    secrets.push(b.access_token, b.refresh_token);
    return { access: b.access_token, refreshTok: b.refresh_token };
  }

  it('client registration, grant + token issue are audited', async () => {
    await issue();
    await waitForAudit(s, 'oauth_client_registered');
    await waitForAudit(s, 'agent_grant_created');
    await waitForAudit(s, 'agent_token_issued');
  });

  it('refresh and revoke are audited', async () => {
    const t = await issue();
    const r = JSON.parse(
      (await refresh(s, { client_id: clientId, refresh_token: t.refreshTok })).body
    );
    secrets.push(r.access_token, r.refresh_token);
    await waitForAudit(s, 'agent_token_refreshed');
    await revoke(s, { client_id: clientId, token: r.refresh_token, hint: 'refresh_token' });
    await waitForAudit(s, 'agent_token_revoked');
  });

  it('refresh-token reuse is audited as agent_refresh_reuse_detected', async () => {
    const t = await issue();
    await refresh(s, { client_id: clientId, refresh_token: t.refreshTok });
    await refresh(s, { client_id: clientId, refresh_token: t.refreshTok });
    await waitForAudit(s, 'agent_refresh_reuse_detected');
  });

  it('grant revoke and client disable are audited', async () => {
    const created = await alice.request({
      method: 'POST',
      url: AGENT_GRANTS_ROUTE,
      payload: {
        bound_client_id: await boundClientId(alice),
        label: 'audit-me',
        scopes: ['mcp:*'],
      },
    });
    const d = JSON.parse(created.body).data;
    secrets.push(d.access_token);
    await alice.request({ method: 'DELETE', url: `${AGENT_GRANTS_ROUTE}/${d.grant_id}` });
    await waitForAudit(s, 'agent_grant_revoked');
    const res = await s.admin.inject({
      method: 'PATCH',
      url: `${ADMIN_OAUTH_CLIENTS_ROUTE}/${clientId}`,
      headers: { 'X-Admin-Key': s.adminKey },
      payload: { disabled: true },
    });
    expect(res.statusCode).toBe(200);
    await waitForAudit(s, 'oauth_client_disabled');
  });

  itImpl.each([
    ['missing_token', {} as Record<string, string>, ''],
    ['bad_token', { authorization: 'Bearer amb_at_' + 'z'.repeat(43) }, ''],
    [
      'bad_origin',
      { authorization: 'Bearer amb_at_' + 'y'.repeat(43), origin: 'https://evil.example' },
      '',
    ],
    ['token_in_query', {}, '?access_token=amb_at_' + 'x'.repeat(43)],
  ])(
    'failed /mcp auth (%s) is audited as agent_auth_failure with the reason',
    async (reason, headers, qs) => {
      await s.api.inject({ method: 'POST', url: AGENT_MCP_ROUTE + qs, headers, payload: '{}' });
      await waitForAudit(s, 'agent_auth_failure', reason);
    }
  );

  itImpl('raw tokens, codes, verifiers never appear in audit, DB files, or logs', async () => {
    await issue();
    // include the garbage tokens used on the failure paths
    const garbage = ['z'.repeat(43), 'y'.repeat(43), 'x'.repeat(43)].map(g => 'amb_at_' + g);
    await waitForAudit(s, 'agent_token_issued');
    await new Promise(r => setTimeout(r, 6000)); // let the next audit flush land
    const bytes = dataDirBytes(s.dataDir);
    const real = secrets.filter(Boolean);
    expect(real.length).toBeGreaterThan(0);
    for (const t of [...real, ...garbage]) {
      expect(bytes.includes(t), `raw secret ${t.slice(0, 10)}… found on disk`).toBe(false);
      expect(logged.includes(t), `raw secret ${t.slice(0, 10)}… found in logs`).toBe(false);
    }
    // the audit trail may only carry a short hash prefix, never the full hash
    for (const t of real.filter(x => x.startsWith('amb_'))) {
      expect(auditLines(s).join('\n').includes(sha(t))).toBe(false);
    }
  });

  itImpl('audit rows for issued tokens carry an 8-char hash prefix', async () => {
    const t = await issue();
    const line = await waitForAudit(s, 'agent_token_issued');
    const prefixes = [sha(t.access).slice(0, 8), sha(t.refreshTok).slice(0, 8)];
    expect(
      prefixes.some(p => line.includes(p)) ||
        auditLines(s).some(l => prefixes.some(p => l.includes(p)))
    ).toBe(true);
  });
});

describe('audit: disabled endpoint emits no agent events', () => {
  let s: AgentTestServer;
  beforeAll(async () => {
    s = await startAgentTestServer();
  });
  afterAll(async () => {
    await stopAgentTestServer(s);
  });

  it('probing /mcp while disabled writes no agent_* audit events', async () => {
    await s.api.inject({
      method: 'POST',
      url: AGENT_MCP_ROUTE,
      headers: { authorization: 'Bearer amb_at_' + 'q'.repeat(43) },
      payload: '{}',
    });
    await new Promise(r => setTimeout(r, 6000));
    const text = auditLines(s).join('\n');
    for (const a of AGENT_AUDIT_ACTIONS) expect(text).not.toContain(a);
    expect(text).not.toContain(TEST_RESOURCE_BASE);
  }, 20_000);
});
