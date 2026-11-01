#!/usr/bin/env node
// Fake downstream MCP for ADR-020 tests. Plain Node 20, no deps. Newline-delimited JSON-RPC on stdio.
//
// Env:
//   FAKE_MCP_TOOLS   comma-separated tool names (default "echo"). Each tool takes any object.
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
const ok = (id, result) => send({ jsonrpc: '2.0', id, result });
const err = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

const toolDefs = [...tools, '__env'].map(name => ({
  name,
  description: `fake tool ${name}`,
  inputSchema: { type: 'object', properties: {}, additionalProperties: true },
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
      return ok(id, { tools: toolDefs });
    case 'tools/call': {
      const name = params?.name;
      if (name === '__env') {
        return ok(id, { content: [{ type: 'text', text: JSON.stringify(process.env) }] });
      }
      if (!tools.includes(name)) return err(id, -32602, `unknown tool ${name}`);
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
