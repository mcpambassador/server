// Blocking production audit; fails closed. Exit codes: 0 clean, 1 blocking advisory, 2 unusable audit output.
// pnpm 8.15 ignores pnpm.auditConfig.ignoreGhsas, so the ignore list is applied here. Every ignored GHSA must
// be listed in package.json (pnpm.auditConfig.ignoreGhsas) AND in TRACKED below with a TD id and a review-by
// date; an ignore past its review-by date blocks again. Remove the entry when its upgrade PR lands.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const TRACKED = {
  'GHSA-mrhx-c7xc-m3w5': { td: 'TD-020', pkg: 'zod', reviewBy: '2026-12-31' },
};
const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'];
const isObj = v => typeof v === 'object' && v !== null && !Array.isArray(v);

/** @returns {{code: number, lines: string[]}} */
export function evaluate({ stdout, exitCode, ignored, tracked = TRACKED, now = new Date() }) {
  const lines = [];
  const unusable = msg => ({ code: 2, lines: [`AUDIT UNUSABLE: ${msg}`] });

  let j;
  try {
    j = JSON.parse(stdout ?? '');
  } catch {
    return unusable('output is not JSON');
  }
  if (!isObj(j) || !isObj(j.advisories)) return unusable('missing advisories object');
  const vulns = j.metadata?.vulnerabilities;
  if (!isObj(vulns)) return unusable('missing metadata.vulnerabilities');

  for (const [id, t] of Object.entries(tracked)) {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(t?.reviewBy ?? '') ||
      isNaN(new Date(`${t.reviewBy}T00:00:00Z`))
    )
      return unusable(`malformed reviewBy for ${id}: ${t?.reviewBy}`);
  }

  const advisories = Object.values(j.advisories);
  if (exitCode !== 0 && advisories.length === 0)
    return unusable(`pnpm exited ${exitCode} with no advisories`);

  const counted = advisories.filter(a => ['high', 'critical'].includes(a?.severity)).length;
  const reported = (Number(vulns.high) || 0) + (Number(vulns.critical) || 0);
  if (counted !== reported)
    return unusable(`metadata reports ${reported} high+critical but ${counted} advisories parsed`);

  const blocking = [];
  for (const a of advisories) {
    const id = a?.github_advisory_id;
    const label = `${a?.severity} ${id} ${a?.module_name} - ${a?.title}`;
    if (!SEVERITIES.includes(a?.severity)) {
      blocking.push(`unknown severity: ${label}`);
      continue;
    }
    if (!['high', 'critical'].includes(a.severity)) continue;
    if (!ignored.has(id)) {
      blocking.push(label);
      continue;
    }
    const t = tracked[id];
    if (!t) blocking.push(`ignored but not tracked in scripts/audit-prod.mjs: ${label}`);
    else if (now > new Date(`${t.reviewBy}T23:59:59Z`))
      blocking.push(`ignore expired (${t.td}, review-by ${t.reviewBy}): ${label}`);
    else lines.push(`ignored (${t.td}, review by ${t.reviewBy}): ${label}`);
  }
  for (const b of blocking) lines.push(`BLOCKING ${b}`);
  if (blocking.length) return { code: 1, lines };
  lines.push('prod audit clean (high/critical)');
  return { code: 0, lines };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const ignored = new Set(
    JSON.parse(readFileSync('package.json', 'utf8')).pnpm?.auditConfig?.ignoreGhsas ?? []
  );
  const r = spawnSync('pnpm', ['audit', '--prod', '--json'], {
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  });
  const res = r.error
    ? { code: 2, lines: [`AUDIT UNUSABLE: ${r.error.message}`] }
    : evaluate({ stdout: r.stdout, exitCode: r.status, ignored });
  for (const l of res.lines) (res.code ? console.error : console.log)(l);
  process.exit(res.code);
}
