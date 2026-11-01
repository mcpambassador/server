#!/usr/bin/env node
// Fake downstream MCP for ADR-020 tests. Plain Node 20, no deps. Newline-delimited JSON-RPC on stdio.
//
// Env:
//   FAKE_MCP_TOOLS   comma-separated tool names (default "echo"). Each tool takes any object.
//   FAKE_MCP_DESC / FAKE_MCP_DESC_FILE  tool description text (see descFor)
//   FAKE_MCP_RESULT  optional JSON: returned verbatim as the tools/call result of every listed tool
//                    (lets tests make a downstream forge `_meta` / structuredContent)
//   FAKE_MCP_LOG     optional file path; every request line and the env snapshot are appended as JSON lines.
//
// Built-in extra tool (always listed): "__env" returns the env this process received
// (JSON), so tests can assert no agent token (amb_at_/amb_rt_) leaked downstream.
// tools/call for any other tool echoes {tool, args, pid} as text content.
import fs from 'node:fs';
import readline from 'node:readline';

const tools = (process.env.FAKE_MCP_TOOLS ?? 'echo')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const logPath = process.env.FAKE_MCP_LOG;
const log = o => {
  if (!logPath) return;
  try {
    fs.appendFileSync(logPath, JSON.stringify(o) + '\n');
  } catch {
    /* ignore */
  }
};
log({ kind: 'start', pid: process.pid, env: process.env });

const send = o => process.stdout.write(JSON.stringify(o) + '\n');

// FAKE_MCP_DESC_FILE changes => notifications/tools/list_changed (what a real server does on a definition change).
if (process.env.FAKE_MCP_DESC_FILE) {
  fs.watchFile(process.env.FAKE_MCP_DESC_FILE, { interval: 100 }, (cur, prev) => {
    if (cur.mtimeMs !== prev.mtimeMs)
      send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
  }).unref();
}
const ok = (id, result) => send({ jsonrpc: '2.0', id, result });
const err = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

// FAKE_MCP_DESC: description text for every tool. FAKE_MCP_DESC_FILE: if set and readable, its content
// wins and is re-read on each tools/list (lets a test change a definition after discovery/publish).
const descFor = name => {
  const f = process.env.FAKE_MCP_DESC_FILE;
  if (f) {
    try {
      return fs.readFileSync(f, 'utf8').trim();
    } catch {
      /* fall through */
    }
  }
  return process.env.FAKE_MCP_DESC ?? `fake tool ${name}`;
};
const mkDefs = () =>
  [...tools, '__env'].map(name => ({
    name,
    description: descFor(name),
    inputSchema: process.env.FAKE_MCP_SCHEMA
      ? JSON.parse(process.env.FAKE_MCP_SCHEMA)
      : { type: 'object', properties: {}, additionalProperties: true },
  }));

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  log({ kind: 'req', msg });
  const { id, method, params } = msg;
  if (id === undefined) return; // notification (e.g. notifications/initialized)
  switch (method) {
    case 'initialize':
      return ok(id, {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'fake-mcp', version: '0.0.0' },
      });
    case 'ping':
      return ok(id, {});
    case 'tools/list':
      return ok(id, { tools: mkDefs() });
    case 'tools/call': {
      const name = params?.name;
      if (name === '__env') {
        return ok(id, { content: [{ type: 'text', text: JSON.stringify(process.env) }] });
      }
      if (!tools.includes(name)) return err(id, -32602, `unknown tool ${name}`);
      if (process.env.FAKE_MCP_RESULT) return ok(id, JSON.parse(process.env.FAKE_MCP_RESULT));
      return ok(id, {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ tool: name, args: params?.arguments ?? {}, pid: process.pid }),
          },
        ],
      });
    }
    default:
      return err(id, -32601, `method not found: ${method}`);
  }
});
rl.on('close', () => process.exit(0));
