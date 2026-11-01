// Tiny stdio MCP used by credential-env e2e tests. It reports whether env vars are PRESENT and,
// given an expected value from the caller, whether they MATCH. It never returns a value.
import readline from 'node:readline';

const send = msg => process.stdout.write(JSON.stringify(msg) + '\n');
const rl = readline.createInterface({ input: process.stdin });

rl.on('line', line => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.id === undefined) return; // notification
  switch (m.method) {
    case 'initialize':
      return send({
        jsonrpc: '2.0',
        id: m.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'env-probe', version: '1.0.0' },
        },
      });
    case 'tools/list':
      return send({
        jsonrpc: '2.0',
        id: m.id,
        result: {
          tools: [
            {
              name: 'env_probe',
              description: 'Report presence/match of env vars (never values)',
              inputSchema: {
                type: 'object',
                properties: { expect: { type: 'object' } },
              },
            },
          ],
        },
      });
    case 'tools/call': {
      const expect = m.params?.arguments?.expect ?? {};
      const report = {};
      for (const [name, expected] of Object.entries(expect)) {
        const actual = process.env[name];
        report[name] = { present: actual !== undefined, matches: actual === expected };
      }
      return send({
        jsonrpc: '2.0',
        id: m.id,
        result: { content: [{ type: 'text', text: JSON.stringify(report) }] },
      });
    }
    default:
      return send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no such method' } });
  }
});
