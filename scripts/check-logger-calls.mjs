#!/usr/bin/env node
/**
 * TD-026 guard: pino treats `logger.error('msg:', err)` as printf-style and silently DROPS the
 * extra arguments (the error's message and stack never reach the log). Use the pino form
 * `logger.error({ err }, 'msg')` instead. Fails on any `<logger>.<level>(<string literal>, ...)`
 * with 2+ arguments and no printf specifier in the literal.
 *
 * Usage: node scripts/check-logger-calls.mjs [dir ...]   (default: core, server, authn-ephemeral,
 * authz-local, audit-file `src`)
 *
 * Limitation: this is a syntactic check on call shape only. It does NOT catch an error stringified
 * into the message, such as logger.error(`failed: ${String(e)}`) or `${e.message}`. That text skips
 * the pino err serializer (only the global string redaction in the message is missing), so prefer
 * logger.error({ err }, 'failed') there too. Calls whose receiver is not named logger/log are not seen.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
const roots = process.argv.slice(2);
if (roots.length === 0)
  roots.push(
    'packages/core/src',
    'packages/server/src',
    'packages/authn-ephemeral/src',
    'packages/authz-local/src',
    'packages/audit-file/src'
  );

const violations = [];

function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const f = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules' && e.name !== 'dist') walk(f);
    } else if (/\.ts$/.test(e.name) && !/\.d\.ts$/.test(e.name)) {
      scan(f);
    }
  }
}

function scan(file) {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  (function visit(n) {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      LEVELS.has(n.expression.name.text) &&
      /(^|\.)(logger|log)$/i.test(n.expression.expression.getText(sf))
    ) {
      const [first, ...rest] = n.arguments;
      if (
        rest.length > 0 &&
        first &&
        (ts.isStringLiteralLike(first) || ts.isTemplateExpression(first)) &&
        !/%[sdijoOf%]/.test(first.getText(sf))
      ) {
        const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
        violations.push(
          `${relative(process.cwd(), file)}:${line + 1}  ${n.getText(sf).split('\n')[0]}`
        );
      }
    }
    ts.forEachChild(n, visit);
  })(sf);
}

for (const r of roots) walk(r);

if (violations.length > 0) {
  console.error(
    `lint:logger — ${violations.length} call(s) pass extra arguments after a string message; pino drops them.\n` +
      "Use logger.<level>({ err }, 'message') (or { detail }):\n" +
      violations.map(v => '  ' + v).join('\n')
  );
  process.exit(1);
}
console.log('lint:logger — ok');
