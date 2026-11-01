// Read-only pre-upgrade report for ADR-025 M2/M4 (TD-037): which ACTIVE subscriptions will stop being served
// once group grants are checked at call time, because the owning user no longer holds the MCP via any group.
// Usage: node scripts/group-grant-loss-report.mjs <path-to-sqlite-copy>   (opened read-only; never writes)
// Prints counts and user/MCP name pairs only — no keys, credentials or tokens. Run it on a COPY of the DB.
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

export const LOSS_SQL = `
  SELECT u.username AS username, c.client_name AS client_name, m.name AS mcp_name,
    CASE WHEN EXISTS (
      SELECT 1 FROM user_groups ug2
      JOIN mcp_group_access a2 ON a2.group_id = ug2.group_id
      WHERE ug2.user_id = c.user_id AND a2.mcp_id = s.mcp_id
    ) THEN 'only_suspended' ELSE 'no_grant' END AS reason
  FROM client_mcp_subscriptions s
  JOIN clients c ON c.client_id = s.client_id
  JOIN users u ON u.user_id = c.user_id
  JOIN mcp_catalog m ON m.mcp_id = s.mcp_id
  WHERE s.status = 'active'
    AND NOT EXISTS (
      SELECT 1 FROM user_groups ug
      JOIN mcp_group_access a ON a.group_id = ug.group_id
      JOIN groups g ON g.group_id = ug.group_id
      WHERE ug.user_id = c.user_id AND a.mcp_id = s.mcp_id AND g.status = 'active'
    )
  ORDER BY u.username, m.name, c.client_name`;

/** Group the raw rows into per-(user, MCP) pairs with the affected client names. */
export function summarize(rows) {
  const pairs = new Map();
  for (const r of rows) {
    const key = `${r.username}\u0000${r.mcp_name}`;
    const p = pairs.get(key) ?? {
      username: r.username,
      mcp: r.mcp_name,
      reason: r.reason ?? 'no_grant',
      clients: [],
    };
    p.clients.push(r.client_name);
    pairs.set(key, p);
  }
  return {
    subscriptions: rows.length,
    pairs: [...pairs.values()],
    users: new Set(rows.map(r => r.username)).size,
  };
}

export function format(s) {
  const lines = [
    `Subscriptions that will no longer be served: ${s.subscriptions}`,
    `Affected user/MCP pairs: ${s.pairs.length} (users: ${s.users})`,
  ];
  for (const p of s.pairs) lines.push(`  ${p.username} -> ${p.mcp} [${p.reason}] (clients: ${p.clients.join(', ')})`);
  return lines.join('\n');
}

export function run(dbPath) {
  const require = createRequire(import.meta.url);
  const Database = require('better-sqlite3');
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    db.pragma('query_only = ON');
    return summarize(db.prepare(LOSS_SQL).all());
  } finally {
    db.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const p = process.argv[2];
  if (!p) {
    console.error('usage: node scripts/group-grant-loss-report.mjs <sqlite-db-copy>');
    process.exit(2);
  }
  console.log(format(run(p)));
}
