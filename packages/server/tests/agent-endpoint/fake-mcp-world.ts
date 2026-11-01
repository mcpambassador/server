/**
 * Helpers that stand up a REAL downstream MCP (tests/fixtures/fake-mcp.mjs) behind the
 * server: catalog entry -> group access -> client subscription -> stdio session.
 * Lets /mcp tests assert against real tools instead of the empty catalog.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import type { AgentTestServer, UserSession } from './helpers.js';

export const FAKE_MCP_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/fake-mcp.mjs'
);

/** node is in the default allowlist; set explicitly like catalog-reload.test.ts. Returns a restore fn. */
export function allowFakeMcpCommand(): () => void {
  const prev = process.env['MCP_ALLOWED_COMMANDS'];
  process.env['MCP_ALLOWED_COMMANDS'] = 'node';
  return () => {
    if (prev === undefined) delete process.env['MCP_ALLOWED_COMMANDS'];
    else process.env['MCP_ALLOWED_COMMANDS'] = prev;
  };
}

const adminHeaders = (s: AgentTestServer) => ({ 'X-Admin-Key': s.adminKey });

export interface FakeMcp {
  mcpId: string;
  name: string;
  tools: string[];
}

/** Create + validate + publish a catalog MCP backed by fake-mcp.mjs. */
export async function createFakeMcp(
  s: AgentTestServer,
  o: {
    name: string;
    isolation?: 'shared' | 'per_user';
    tools?: string[];
    env?: Record<string, string>;
  }
): Promise<FakeMcp> {
  const tools = o.tools ?? ['echo'];
  const res = await s.admin.inject({
    method: 'POST',
    url: '/v1/admin/mcps',
    headers: adminHeaders(s),
    payload: {
      name: o.name,
      display_name: o.name,
      transport_type: 'stdio',
      isolation_mode: o.isolation ?? 'shared',
      config: {
        command: ['node', FAKE_MCP_PATH],
        env: { FAKE_MCP_TOOLS: tools.join(','), ...(o.env ?? {}) },
      },
    },
  });
  if (res.statusCode !== 201) throw new Error(`createFakeMcp: ${res.statusCode} ${res.body}`);
  const mcpId = JSON.parse(res.body).data.mcp_id as string;
  for (const step of ['validate', 'publish']) {
    const r = await s.admin.inject({
      method: 'POST',
      url: `/v1/admin/mcps/${mcpId}/${step}`,
      headers: adminHeaders(s),
    });
    if (r.statusCode !== 200) throw new Error(`fake mcp ${step}: ${r.statusCode} ${r.body}`);
  }
  return { mcpId, name: o.name, tools };
}

/** Put the user in a new group that has access to the MCP. */
export async function grantUserAccess(
  s: AgentTestServer,
  userId: string,
  mcpId: string
): Promise<string> {
  const post = async (url: string, payload: unknown) => {
    const r = await s.admin.inject({
      method: 'POST',
      url,
      headers: adminHeaders(s),
      payload: payload as never,
    });
    if (r.statusCode !== 201) throw new Error(`POST ${url}: ${r.statusCode} ${r.body}`);
    return JSON.parse(r.body).data;
  };
  const g = await post('/v1/admin/groups', {
    name: `g-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    description: 'fake-mcp access',
    status: 'active',
  });
  await post(`/v1/admin/groups/${g.group_id}/members`, { user_id: userId });
  await post(`/v1/admin/groups/${g.group_id}/mcps`, { mcp_id: mcpId });
  return g.group_id as string;
}

/** Apply catalog changes so shared MCPs start. */
export async function applyCatalog(s: AgentTestServer): Promise<void> {
  const r = await s.admin.inject({
    method: 'POST',
    url: '/v1/admin/catalog/apply',
    headers: adminHeaders(s),
  });
  if (r.statusCode !== 200) throw new Error(`catalog apply: ${r.statusCode} ${r.body}`);
}

/** Create a client for the user; returns its id and the one-time preshared key. */
export async function createClientWithKey(
  sess: UserSession,
  name: string
): Promise<{ clientId: string; key: string }> {
  const res = await sess.request({
    method: 'POST',
    url: '/v1/users/me/clients',
    payload: { client_name: name },
  });
  if (res.statusCode !== 201) throw new Error(`createClientWithKey: ${res.statusCode} ${res.body}`);
  const d = JSON.parse(res.body).data;
  return { clientId: d.client.id as string, key: d.plaintext_key as string };
}

export async function subscribe(
  sess: UserSession,
  clientId: string,
  mcpId: string,
  selectedTools?: string[]
): Promise<string> {
  const res = await sess.request({
    method: 'POST',
    url: `/v1/users/me/clients/${clientId}/subscriptions`,
    payload: { mcp_id: mcpId, ...(selectedTools ? { selected_tools: selectedTools } : {}) },
  });
  if (res.statusCode !== 201) throw new Error(`subscribe: ${res.statusCode} ${res.body}`);
  return JSON.parse(res.body).data.id as string;
}

/** Register a stdio-style session on the client listener; returns the X-Session-Token. */
export async function stdioSession(
  s: AgentTestServer,
  key: string,
  _userId?: string
): Promise<string> {
  const res = await s.api.inject({
    method: 'POST',
    url: '/v1/sessions/register',
    payload: { preshared_key: key, friendly_name: 'verifier-stdio', host_tool: 'vscode' },
  });
  if (res.statusCode !== 200 && res.statusCode !== 201)
    throw new Error(`stdioSession: ${res.statusCode} ${res.body}`);
  return JSON.parse(res.body).session_token as string;
}

export const stdioTools = async (s: AgentTestServer, tok: string) =>
  s.api.inject({ method: 'GET', url: '/v1/tools', headers: { 'X-Session-Token': tok } });

export const stdioInvoke = async (
  s: AgentTestServer,
  tok: string,
  tool: string,
  args: Record<string, unknown> = {}
) =>
  s.api.inject({
    method: 'POST',
    url: '/v1/tools/invoke',
    headers: { 'X-Session-Token': tok, 'content-type': 'application/json' },
    payload: { tool, arguments: args },
  });

// ---------------------------------------------------------------------------------------------
// /mcp JSON-RPC client + audit helpers
// ---------------------------------------------------------------------------------------------
import fs from 'fs';
import { AGENT_MCP_ROUTE } from '@mcpambassador/contracts';

export const MCP_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  'mcp-protocol-version': '2025-06-18',
};

/** Body is plain JSON or a single SSE `data:` frame. */
export function parseRpc(body: string): any {
  const t = body.trim();
  if (t.startsWith('{')) return JSON.parse(t);
  const m = /^data: (.*)$/m.exec(t);
  return m ? JSON.parse(m[1]!) : null;
}

export interface RpcReply {
  status: number;
  headers: Record<string, unknown>;
  body: string;
  json: any;
}

let rpcId = 100;
export async function rpc(
  s: AgentTestServer,
  token: string,
  method: string,
  params?: unknown,
  extraHeaders: Record<string, string> = {}
): Promise<RpcReply> {
  const res = await s.api.inject({
    method: 'POST',
    url: AGENT_MCP_ROUTE,
    headers: { ...MCP_HEADERS, authorization: `Bearer ${token}`, ...extraHeaders },
    payload: { jsonrpc: '2.0', id: ++rpcId, method, params } as never,
  });
  let json: any = null;
  try {
    json = parseRpc(res.body);
  } catch {
    /* non-JSON body */
  }
  return { status: res.statusCode, headers: res.headers, body: res.body, json };
}

export const mcpToolNames = async (s: AgentTestServer, token: string): Promise<string[]> => {
  const r = await rpc(s, token, 'tools/list', {});
  return ((r.json?.result?.tools ?? []) as { name: string }[]).map(t => t.name).sort();
};

/** True when the reply is a denial: HTTP 4xx, JSON-RPC error, or an isError tool result. */
export const isDenied = (r: RpcReply): boolean =>
  r.status >= 400 || !!r.json?.error || !!r.json?.result?.isError;

export const auditPath = (s: AgentTestServer): string => `${s.dataDir}/audit/audit.jsonl`;

export function auditLines(s: AgentTestServer): string[] {
  const f = auditPath(s);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) : [];
}

/** Audit is flushed on an interval; poll until a line containing all needles appears. */
export async function waitForAudit(s: AgentTestServer, ...needles: string[]): Promise<string> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const hit = auditLines(s).find(l => needles.every(n => l.includes(n)));
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`audit line with ${needles.join(' + ')} not found`);
    await new Promise(r => setTimeout(r, 250));
  }
}
