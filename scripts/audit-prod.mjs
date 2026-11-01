// Blocking production audit. pnpm 8.15 ignores pnpm.auditConfig.ignoreGhsas, so apply it here.
// Accepted advisories (package.json pnpm.auditConfig.ignoreGhsas): GHSA-gpj5-g38j-94v9 drizzle-orm = TD-019,
// GHSA-mrhx-c7xc-m3w5 zod = TD-020. Remove each entry when its upgrade PR lands.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const ignored = new Set(
  JSON.parse(readFileSync('package.json', 'utf8')).pnpm?.auditConfig?.ignoreGhsas ?? []
);
let out;
try {
  out = execFileSync('pnpm', ['audit', '--prod', '--json'], {
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  });
} catch (err) {
  out = err.stdout; // pnpm exits non-zero when vulnerabilities exist
  if (!out) throw err;
}
const advisories = Object.values(JSON.parse(out).advisories ?? {});
const blocking = advisories.filter(
  a => ['high', 'critical'].includes(a.severity) && !ignored.has(a.github_advisory_id)
);
for (const a of advisories.filter(a => ignored.has(a.github_advisory_id)))
  console.log(`ignored (tracked): ${a.github_advisory_id} ${a.module_name} - ${a.title}`);
for (const a of blocking)
  console.error(`BLOCKING ${a.severity}: ${a.github_advisory_id} ${a.module_name} - ${a.title}`);
if (blocking.length) process.exit(1);
console.log('prod audit clean (high/critical)');
