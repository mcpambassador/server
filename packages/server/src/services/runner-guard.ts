/**
 * Runner guard (TD-039): rejects MCP configs that redirect the package runner (npx, uvx, node, ...)
 * to another source or make it run attacker-chosen code, through arguments OR environment variables.
 *
 * DEPENDENCY-FREE ON PURPOSE: this file imports nothing, so community-registry's CI can vendor it
 * (compile or copy) and apply the exact rule the server applies at create/update/install/spawn.
 *
 * Reasons returned here are generic and safe to show in a 400: they name the offending option or
 * variable (a short, sanitized token) but never echo a value.
 */

/** Runner families. Anything else (docker, ...) gets only the global option set. */
type Family = 'npx' | 'uv' | 'node' | 'python' | 'pip' | 'deno' | 'bun' | 'other';

interface Rules {
  /** Denied long options, without the leading dashes, lowercase. A trailing `*` is a prefix match. */
  long: readonly string[];
  /** Denied short option letters (also matched inside clusters such as `-pe` and `-pFOO`). */
  short: readonly string[];
  /** Options that take no value (so the next token is a positional, ending the runner-option region). */
  bool: readonly string[];
}

/** Applied to every runner. */
const GLOBAL_LONG = ['config', 'userconfig', 'globalconfig', 'prefix', 'cache', 'cache-dir'];

const RULES: Record<Family, Rules> = {
  npx: {
    long: ['registry', 'call', 'package', 'script-shell', 'node-options'],
    short: ['c', 'p'],
    bool: [
      'y',
      'yes',
      'no',
      'q',
      'quiet',
      'no-install',
      'ignore-existing',
      'prefer-online',
      'prefer-offline',
      'offline',
      'no-fund',
      'no-audit',
      'no-update-notifier',
    ],
  },
  uv: {
    long: [
      'from',
      'index-url',
      'default-index',
      'index',
      'extra-index-url',
      'find-links',
      'with*',
      'constraint',
      'override',
      'config-file',
      'directory',
      'project',
      'python',
      'env-file',
      'keyring-provider',
    ],
    short: ['i', 'f', 'c', 'p'],
    bool: ['isolated', 'no-cache', 'quiet', 'q', 'verbose', 'v', 'offline', 'no-progress'],
  },
  node: {
    long: [
      'print',
      'eval',
      'require',
      'import',
      'loader',
      'experimental-loader',
      'env-file',
      'run',
      'inspect*',
    ],
    short: ['p', 'e', 'r'],
    bool: [
      'enable-source-maps',
      'no-warnings',
      'trace-warnings',
      'trace-deprecation',
      'no-deprecation',
      'harmony',
      'use-strict',
    ],
  },
  python: {
    long: [],
    short: ['c'],
    bool: ['u', 'b', 'bb', 's', 'ss', 'e', 'i', 'o', 'oo', 'q', 'v'],
  },
  pip: {
    long: [
      'index-url',
      'extra-index-url',
      'find-links',
      'constraint',
      'requirement',
      'trusted-host',
    ],
    short: ['c', 'i', 'f', 'r', 't'],
    bool: ['q', 'quiet', 'v', 'verbose', 'no-input', 'user', 'upgrade', 'u'],
  },
  deno: {
    long: ['eval', 'print', 'import-map', 'cert', 'env-file'],
    short: ['c', 'r'],
    bool: ['q', 'quiet', 'no-prompt', 'allow-all', 'a'],
  },
  bun: {
    long: ['eval', 'print', 'preload', 'require', 'env-file', 'cwd'],
    short: ['e', 'p', 'r', 'c'],
    bool: ['bun', 'silent', 'watch', 'hot'],
  },
  other: { long: [], short: [], bool: [] },
};

/** Subcommands that run arbitrary code or fetch from elsewhere, per family. */
const DENIED_SUBCOMMANDS: Partial<Record<Family, readonly string[]>> = {
  deno: ['eval', 'repl'],
};

function familyOf(command: string): Family {
  // Basename, lowercase, no Windows extension: `/usr/bin/NPX.cmd` -> `npx`.
  const base = (command.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.(cmd|exe|bat)$/, '');
  if (['npx', 'npm', 'pnpm', 'yarn', 'bunx', 'pnpx'].includes(base)) return 'npx';
  if (['uvx', 'uv'].includes(base)) return 'uv';
  if (['node', 'nodejs'].includes(base)) return 'node';
  if (/^python[\d.]*$/.test(base)) return 'python';
  if (/^pip[\d.]*$/.test(base)) return 'pip';
  if (base === 'deno') return 'deno';
  if (base === 'bun') return 'bun';
  return 'other';
}

function matches(list: readonly string[], name: string): boolean {
  return list.some(p => (p.endsWith('*') ? name.startsWith(p.slice(0, -1)) : name === p));
}

/** A short token that is safe to put in an error message. */
function safeToken(raw: string): string {
  return raw.replace(/[^\w:@./-]/g, '?').slice(0, 40);
}

/**
 * Check a stdio `command` array. Returns a generic reason, or null when acceptable.
 *
 * The runner-option region is everything up to the first positional (the package, script or
 * subcommand). It is computed conservatively: an unknown option without `=` is assumed to take the
 * next token as its value, so the region can only be LONGER than the runner's own parse, never
 * shorter. Options after the region belong to the launched program and are not inspected.
 */
export function checkRunnerCommand(command: readonly unknown[]): string | null {
  if (!Array.isArray(command) || command.length === 0) return null;
  const first = command[0];
  if (typeof first !== 'string') return null;
  const family = familyOf(first);
  const rules = RULES[family];
  const deniedSub = DENIED_SUBCOMMANDS[family] ?? [];
  let swallowNext = false;

  for (let i = 1; i < command.length; i++) {
    const rawTok = command[i];
    if (typeof rawTok !== 'string') continue;
    // A single element holding "--registry evil" is not an option to the runner, but treat the first
    // word as one: stricter, never looser.
    const tok = rawTok.trim();
    if (tok === '--') return null;

    if (!tok.startsWith('-') || tok === '-') {
      if (swallowNext) {
        swallowNext = false;
        continue;
      }
      if (deniedSub.includes(tok.toLowerCase())) {
        return `runner subcommand not permitted: ${safeToken(tok)}`;
      }
      // pip: `install -c file` puts the options AFTER the subcommand, so keep scanning.
      if (family === 'pip') continue;
      return null; // first positional: the rest belongs to the launched program
    }

    const head = tok.split(/\s/)[0] ?? tok;
    const eq = head.indexOf('=');
    const flag = (eq >= 0 ? head.slice(0, eq) : head).toLowerCase();

    if (flag.startsWith('--')) {
      const name = flag.slice(2);
      // npm scoped registries: --@scope:registry
      if (
        matches(rules.long, name) ||
        matches(GLOBAL_LONG, name) ||
        /^@?[\w-]+:registry$/.test(name)
      ) {
        return `runner option not permitted: ${safeToken(flag)}`;
      }
      swallowNext = eq < 0 && !matches(rules.bool, name);
      continue;
    }

    // Short option or cluster: `-p`, `-pe`, `-pFOO`, `-ihttps://...`
    const letters = flag.slice(1);
    for (const ch of letters) {
      if (rules.short.includes(ch)) return `runner option not permitted: ${safeToken(`-${ch}`)}`;
      // python -m <module> ...: everything after the module name belongs to the module.
      if (family === 'python' && ch === 'm') return null;
    }
    swallowNext = eq < 0 && !(letters.length === 1 && matches(rules.bool, letters));
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Environment variable names
// ---------------------------------------------------------------------------------------------

/** Case-insensitive prefixes: each of these can redirect a runner, interpreter or git. */
const ENV_PREFIXES = [
  'npm_config_',
  'pip_',
  'uv_',
  'python',
  'node_',
  'ld_',
  'dyld_',
  'yarn_',
  'pnpm_',
  'bun_',
  'deno_',
  'git_',
  'xdg_',
];

/** Case-insensitive exact names. */
const ENV_EXACT = ['path', 'pathext', 'home', 'userprofile', 'shell', 'ifs', 'env', 'bash_env'];

/** Exceptions to the prefixes: not a redirect, and widely set by operators. */
const ENV_ALLOWED = ['node_env'];

/** True when `name` may not be set through a catalog config, a credential field or an OAuth binding. */
export function isBlockedEnvName(name: string): boolean {
  const n = name.trim().toLowerCase();
  if (n === '') return false;
  if (ENV_ALLOWED.includes(n)) return false;
  return ENV_EXACT.includes(n) || ENV_PREFIXES.some(p => n.startsWith(p));
}

/** First blocked name in `names`, as a generic reason; null when all are acceptable. */
export function checkEnvNames(names: Iterable<string>, where: string): string | null {
  for (const name of names) {
    if (typeof name === 'string' && isBlockedEnvName(name)) {
      return `${where} uses a reserved environment variable name: ${safeToken(name)}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Whole-entry check (create / update / install / registry CI)
// ---------------------------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Every env var name a credential_schema can bind: the `env_var` of a property, else its key. */
export function credentialEnvNames(schema: unknown): string[] {
  const props = isObj(schema) && isObj(schema['properties']) ? schema['properties'] : null;
  if (!props) return [];
  const out: string[] = [];
  for (const [key, def] of Object.entries(props)) {
    out.push(key);
    if (isObj(def) && typeof def['env_var'] === 'string') out.push(def['env_var']);
  }
  return out;
}

/**
 * Check the parts of a catalog entry that reach a spawned process. Each argument is optional so an
 * update can check only what it changes. Accepts parsed objects (not JSON strings).
 */
export function checkCatalogEntry(input: {
  config?: unknown;
  credential_schema?: unknown;
  oauth_access_token_env_var?: unknown;
}): string | null {
  const { config, credential_schema, oauth_access_token_env_var } = input;
  if (isObj(config)) {
    const cmd = config['command'];
    if (Array.isArray(cmd)) {
      const r = checkRunnerCommand(cmd);
      if (r) return r;
    }
    if (isObj(config['env'])) {
      const r = checkEnvNames(Object.keys(config['env']), 'config.env');
      if (r) return r;
    }
  }
  if (credential_schema !== undefined) {
    const r = checkEnvNames(credentialEnvNames(credential_schema), 'credential_schema');
    if (r) return r;
  }
  if (typeof oauth_access_token_env_var === 'string') {
    const r = checkEnvNames([oauth_access_token_env_var], 'oauth_config.access_token_env_var');
    if (r) return r;
  }
  return null;
}
