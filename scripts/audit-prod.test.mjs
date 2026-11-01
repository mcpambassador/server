import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from './audit-prod.mjs';

const adv = (id, severity) => ({
  github_advisory_id: id,
  severity,
  module_name: 'm',
  title: 't',
});
const out = (advisories, v = {}) =>
  JSON.stringify({
    advisories,
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, ...v } },
  });
const base = { ignored: new Set(), now: new Date('2026-11-01') };
const TD = 'GHSA-gpj5-g38j-94v9';

test('fails closed on {}', () =>
  assert.notEqual(evaluate({ ...base, stdout: '{}', exitCode: 0 }).code, 0));
test('fails closed on error object', () =>
  assert.notEqual(
    evaluate({
      ...base,
      stdout: JSON.stringify({ error: { code: 'ERR_PNPM_AUDIT_BAD_RESPONSE' } }),
      exitCode: 1,
    }).code,
    0
  ));
test('fails closed on non-JSON', () =>
  assert.equal(evaluate({ ...base, stdout: 'oops', exitCode: 0 }).code, 2));
test('bad severity blocks', () =>
  assert.equal(
    evaluate({ ...base, stdout: out({ 1: adv('GHSA-x', 'weird') }), exitCode: 1 }).code,
    1
  ));
test('non-zero exit with no advisories is unusable', () =>
  assert.equal(evaluate({ ...base, stdout: out({}), exitCode: 1 }).code, 2));
test('metadata mismatch is unusable', () =>
  assert.equal(evaluate({ ...base, stdout: out({}, { high: 1 }), exitCode: 0 }).code, 2));
test('untracked high blocks', () =>
  assert.equal(
    evaluate({ ...base, stdout: out({ 1: adv('GHSA-x', 'high') }, { high: 1 }), exitCode: 1 }).code,
    1
  ));
test('tracked ignore passes before review-by, blocks after', () => {
  const stdout = out({ 1: adv(TD, 'high') }, { high: 1 });
  const ignored = new Set([TD]);
  assert.equal(evaluate({ stdout, exitCode: 1, ignored, now: new Date('2026-11-01') }).code, 0);
  assert.equal(evaluate({ stdout, exitCode: 1, ignored, now: new Date('2027-01-02') }).code, 1);
});
test('ignored but untracked id blocks', () =>
  assert.equal(
    evaluate({
      stdout: out({ 1: adv('GHSA-x', 'high') }, { high: 1 }),
      exitCode: 1,
      ignored: new Set(['GHSA-x']),
      now: base.now,
    }).code,
    1
  ));
test('clean passes', () =>
  assert.equal(evaluate({ ...base, stdout: out({}), exitCode: 0 }).code, 0));
