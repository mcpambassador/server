/**
 * Runner guard (TD-039): rejects MCP configs that redirect the package runner (npx, uvx, node, ...)
 * to another source or make it run attacker-chosen code, through arguments OR environment variables.
 *
 * DEPENDENCY-FREE ON PURPOSE: this file imports nothing, so community-registry's CI can vendor it
 * (compile or copy) and apply the exact rule the server applies at create/update/install/spawn.
 *
 * Reasons returned here are generic and safe to show in a 400: they name the offending option or
 * variable (a short, sanitized token) but never echo a value.
 *
 * Two strategies:
 *  - STRICT (npx/npm/pnpm/yarn/bunx, uvx/uv): DEFAULT-DENY. Before the package, only a short list of
 *    boolean options is accepted; any other option is rejected (this also covers npm's option
 *    abbreviations such as `--reg=`, and every config-style option such as `--cafile` or
 *    `--https-proxy`).
 *  - DENYLIST (node, python, pip, deno, bun, others): known dangerous options are rejected.
 *    For CLIs with subcommands the scan continues past the subcommand up to the package or script.
 */

/** Runner families. Anything else gets only the global option set. */
type Family = 'npx' | 'uv' | 'node' | 'python' | 'pip' | 'deno' | 'bun' | 'other';

interface Rules {
  /** Denied long options, without the leading dashes, lowercase. A trailing `*` is a prefix match. */
  long: readonly string[];
  /** Denied short option letters (also matched inside clusters such as `-pe` and `-pFOO`). */
  short: readonly string[];
  /** Options that take no value (so the next token is a positional, ending the runner-option region). */
  bool: readonly string[];
}

/** Applied to every denylist runner. */
const GLOBAL_LONG = ['config', 'userconfig', 'globalconfig', 'prefix', 'cache', 'cache-dir'];

/** STRICT families: the ONLY options accepted before the package (no `=value` forms). */
const STRICT_ALLOWED: Partial<
  Record<Family, { long: readonly string[]; short: readonly string[] }>
> = {
  npx: {
    long: [
      'yes',
      'no',
      'quiet',
      'prefer-offline',
      'prefer-online',
      'offline',
      'no-fund',
      'no-audit',
      'no-update-notifier',
      'ignore-existing',
    ],
    short: ['y', 'q'],
  },
  uv: {
    long: ['quiet', 'offline', 'no-cache', 'isolated', 'no-progress', 'no-config'],
    short: ['q'],
  },
  // pip (optparse) accepts unambiguous abbreviations (`--extra-index=`), so a denylist cannot work.
  pip: {
    long: [
      'quiet',
      'verbose',
      'no-input',
      'upgrade',
      'no-deps',
      'no-cache-dir',
      'user',
      'disable-pip-version-check',
    ],
    short: ['q', 'v', 'U'],
  },
};

/** Subcommand words skipped (not treated as the package) while scanning, per family. */
const SUBCOMMANDS: Partial<Record<Family, readonly string[]>> = {
  uv: ['tool', 'run', 'pip', 'install', 'uninstall', 'x', 'exec'],
  deno: [
    'run',
    'task',
    'install',
    'test',
    'bench',
    'check',
    'compile',
    'cache',
    'serve',
    'add',
    'x',
  ],
  bun: ['run', 'x', 'exec', 'install', 'add', 'create', 'test', 'update'],
};

const RULES: Record<Family, Rules> = {
  npx: { long: [], short: [], bool: [] },
  uv: { long: [], short: [], bool: [] },
  node: {
    long: [
      'print',
      'eval',
      'require',
      'import',
      'loader',
      'experimental-loader',
      'env-file*',
      'openssl-config',
      'experimental-config-file',
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
      'index',
      'proxy',
      'cert',
      'client-cert',
      'editable',
      'target',
      'root',
      'src',
      'no-index',
    ],
    short: ['c', 'i', 'f', 'r', 't', 'e'],
    bool: ['q', 'quiet', 'v', 'verbose', 'no-input', 'user', 'upgrade', 'u'],
  },
  deno: {
    long: [
      'eval',
      'print',
      'import-map',
      'cert',
      'env-file*',
      'preload',
      'lock',
      'reload',
      'location',
      'v8-flags',
    ],
    short: ['c', 'r', 'e'],
    bool: ['q', 'quiet', 'no-prompt', 'allow-all', 'a', 'no-check', 'no-remote', 'no-npm'],
  },
  bun: {
    long: [
      'eval',
      'print',
      'preload',
      'require',
      'import',
      'env-file',
      'cwd',
      'config',
      'tsconfig-override',
      'registry',
      'cafile',
    ],
    short: ['e', 'p', 'r', 'c'],
    bool: ['bun', 'silent', 'watch', 'hot', 'no-install'],
  },
  other: { long: [], short: [], bool: [] },
};

/** Subcommands that run arbitrary code or fetch from elsewhere, per family. */
const DENIED_SUBCOMMANDS: Partial<Record<Family, readonly string[]>> = {
  deno: ['eval', 'repl'],
  bun: ['repl'],
};

/** CLIs that share docker's `run` option grammar; all go through the default-deny docker check. */
const DOCKER_FAMILY = ['docker', 'podman', 'nerdctl', 'finch', 'podman-remote'];
/** Low-level runtimes with no safe `run` subset; refused outright. */
const REFUSED_RUNNERS = [
  'ctr',
  'crictl',
  'kubectl',
  'buildah',
  'runc',
  'crun',
  'nsenter',
  'unshare',
  'systemd-nspawn',
  'bwrap',
  'lxc-execute',
  'chroot',
];

function isDockerFamily(base: string): boolean {
  return DOCKER_FAMILY.includes(base);
}

function baseOf(command: string): string {
  // Basename, lowercase, no Windows extension: `/usr/bin/NPX.cmd` -> `npx`.
  return (command.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.(cmd|exe|bat)$/, '');
}

/** True for CLIs whose first positional is a subcommand (npm exec, pnpm dlx, yarn dlx ...). */
function isPackageManagerCli(base: string): boolean {
  return ['npm', 'pnpm', 'yarn'].includes(base);
}

function familyOf(base: string): Family {
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
 * The runner-option region is everything up to the package or script positional (subcommands such as
 * `exec`, `dlx`, `tool run`, `run` are skipped). Options after the region belong to the launched
 * program and are not inspected.
 */
export function checkRunnerCommand(command: readonly unknown[]): string | null {
  if (!Array.isArray(command) || command.length === 0) return null;
  const first = command[0];
  if (typeof first !== 'string') return null;
  const base = baseOf(first);
  if (REFUSED_RUNNERS.includes(base)) return 'container runner not permitted';
  if (isDockerFamily(base)) return checkDockerRun(command);
  return scan(base, command, 1);
}

// ---------------------------------------------------------------------------------------------
// docker / podman (TD-042). DEFAULT-DENY: only `run` with a short list of confinement-preserving
// options. `docker` is NOT in the default command allowlist; this guards operators who add it via
// MCP_ALLOWED_COMMANDS. Enabling docker at all needs the Docker socket, which is host-root
// equivalent: unsupported for untrusted MCPs, whatever this guard accepts.
// ---------------------------------------------------------------------------------------------

/** Boolean options (no value, no `=value`). Short ones may be clustered (`-iq`). */
const DOCKER_BOOL_LONG = ['rm', 'interactive', 'init', 'read-only', 'quiet'];
const DOCKER_BOOL_SHORT = ['i', 'q'];

const DOCKER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const DOCKER_IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/;

function dockerUserOk(v: string): boolean {
  const parts = v.split(':');
  if (parts.length > 2) return false;
  // Numeric, non-zero only. A user NAME is resolved through the image's own /etc/passwd, which the
  // image controls, so any name (not just "root") can map to uid 0 and defeat the check.
  return parts.every(p => /^\d{1,10}$/.test(p) && Number(p) > 0);
}

/** Value validators by canonical option name. Return true when the value is acceptable. */
const DOCKER_VALUE_RULES: Record<string, (v: string) => boolean> = {
  pull: v => ['always', 'missing', 'never'].includes(v),
  network: v => v === 'none' || v === 'bridge',
  memory: v => /^[1-9]\d{0,12}[bkmg]?$/i.test(v),
  cpus: v => /^(?:\d{1,3})(?:\.\d{1,3})?$/.test(v) && Number(v) > 0,
  'pids-limit': v => /^[1-9]\d{0,6}$/.test(v),
  user: dockerUserOk,
  'cap-drop': v => v.toLowerCase() === 'all',
  'security-opt': v => /^no-new-privileges(?:[=:]true)?$/.test(v),
  name: v => DOCKER_NAME_RE.test(v),
  workdir: v => /^\/[A-Za-z0-9_./-]{0,255}$/.test(v) && !v.split('/').includes('..'),
};

const DOCKER_LONG_ALIASES: Record<string, string> = { net: 'network' };
const DOCKER_SHORT_VALUE: Record<string, string> = { m: 'memory', u: 'user', w: 'workdir' };

interface DockerParse {
  error: string | null;
  image: string | null;
}

function parseDockerRun(command: readonly unknown[]): DockerParse {
  const r = parseDockerRunInner(command);
  return typeof r === 'string' ? { error: r, image: null } : { error: null, image: r.image };
}

export function checkDockerRun(command: readonly unknown[]): string | null {
  return parseDockerRun(command).error;
}

function parseDockerRunInner(command: readonly unknown[]): string | { image: string } {
  const sub = typeof command[1] === 'string' ? command[1].trim().toLowerCase() : '';
  // Options before the subcommand (-H, --context, --config, --host ...) redirect the daemon.
  if (sub !== 'run') {
    return `docker subcommand not permitted: ${safeToken(typeof command[1] === 'string' ? command[1] : '')} (only 'run')`;
  }
  const take = (flag: string, name: string, value: string | undefined): string | null => {
    const rule = DOCKER_VALUE_RULES[name];
    if (!rule) return `docker option not permitted: ${safeToken(flag)}`;
    if (value === undefined || !rule(value)) {
      return `docker option value not permitted: ${safeToken(flag)}`;
    }
    return null;
  };
  for (let i = 2; i < command.length; i++) {
    const raw = command[i];
    if (typeof raw !== 'string') return 'docker argument must be a string';
    const tok = raw.trim();
    if (tok === '--') return 'docker option not permitted: --';
    if (!tok.startsWith('-') || tok === '-') {
      if (!DOCKER_IMAGE_RE.test(tok)) return 'docker image reference not permitted';
      return { image: tok }; // the rest belongs to the container
    }
    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=');
      const flag = (eq >= 0 ? tok.slice(0, eq) : tok).toLowerCase();
      const name0 = flag.slice(2);
      const name = DOCKER_LONG_ALIASES[name0] ?? name0;
      if (DOCKER_BOOL_LONG.includes(name)) {
        if (eq >= 0) return `docker option not permitted: ${safeToken(flag)}`;
        continue;
      }
      let value: string | undefined;
      if (eq >= 0) value = tok.slice(eq + 1);
      else {
        const next = command[i + 1];
        value = typeof next === 'string' ? next.trim() : undefined;
        i++;
      }
      const r = take(flag, name, value);
      if (r) return r;
      continue;
    }
    // Short option or cluster: -i, -iq, -m512m, -u1000, -w /app
    const letters = tok.slice(1);
    for (let k = 0; k < letters.length; k++) {
      const ch = (letters[k] as string).toLowerCase();
      if (DOCKER_BOOL_SHORT.includes(ch)) continue;
      const name = DOCKER_SHORT_VALUE[ch];
      if (!name) return `docker option not permitted: ${safeToken(`-${ch}`)}`;
      let value = letters.slice(k + 1);
      if (value.startsWith('=')) value = value.slice(1);
      if (value === '') {
        const next = command[i + 1];
        value = typeof next === 'string' ? next.trim() : '';
        i++;
      }
      const r = take(`-${ch}`, name, value);
      if (r) return r;
      break;
    }
  }
  return 'docker image reference missing';
}

/**
 * Non-fatal advice for a docker/podman command that passed {@link checkRunnerCommand}: an image
 * without a digest is mutable. Prefer `name@sha256:...`. Returns null when fine or not docker.
 */
export function runnerWarning(command: readonly unknown[]): string | null {
  if (!Array.isArray(command) || typeof command[0] !== 'string') return null;
  const base = baseOf(command[0]);
  if (!isDockerFamily(base)) return null;
  const { error, image } = parseDockerRun(command);
  if (error) return null;
  if (!image || image.includes('@sha256:')) return null;
  return image.split('/').pop()?.includes(':') && !/:latest$/.test(image)
    ? 'docker image is pinned by tag only; prefer a @sha256 digest'
    : 'docker image has no pinned version or digest; prefer a @sha256 digest';
}

function scan(base: string, command: readonly unknown[], start: number): string | null {
  const family = familyOf(base);
  const rules = RULES[family];
  const strict = STRICT_ALLOWED[family];
  const deniedSub = DENIED_SUBCOMMANDS[family] ?? [];
  // `uvx tool` runs a package named "tool"; only `uv` has subcommands.
  const subcommands = family === 'uv' && base !== 'uv' ? [] : (SUBCOMMANDS[family] ?? []);
  const pm = isPackageManagerCli(base);
  let swallowNext = false;
  let subSeen = false;

  for (let i = start; i < command.length; i++) {
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
      const low = tok.toLowerCase();
      if (deniedSub.includes(low)) return `runner subcommand not permitted: ${safeToken(tok)}`;
      // pip: `install -c file` puts options AFTER the subcommand, so keep scanning.
      if (family === 'pip') continue;
      // npm/pnpm/yarn: the first positional is a subcommand (exec, dlx, ...); the package follows it.
      if (pm && !subSeen) {
        subSeen = true;
        continue;
      }
      // uv / deno / bun: skip known subcommand words, the next positional is the tool or script.
      if (subcommands.includes(low)) continue;
      return null; // package / script: the rest belongs to the launched program
    }

    const head = tok.split(/\s/)[0] ?? tok;
    const eq = head.indexOf('=');
    const flag = (eq >= 0 ? head.slice(0, eq) : head).toLowerCase();

    if (strict) {
      // DEFAULT-DENY: only the listed boolean options, with no `=value`.
      if (eq >= 0) return `runner option not permitted: ${safeToken(flag)}`;
      if (flag.startsWith('--')) {
        if (!strict.long.includes(flag.slice(2))) {
          return `runner option not permitted: ${safeToken(flag)}`;
        }
      } else {
        for (const ch of flag.slice(1)) {
          if (!strict.short.includes(ch))
            return `runner option not permitted: ${safeToken(`-${ch}`)}`;
        }
      }
      continue;
    }

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
    for (let k = 0; k < letters.length; k++) {
      const ch = letters[k] as string;
      if (rules.short.includes(ch)) return `runner option not permitted: ${safeToken(`-${ch}`)}`;
      // python -m <module> ...: `pip` and `uv` get their own rules; any other module owns the rest.
      if (family === 'python' && ch === 'm') {
        const attached = letters.slice(k + 1);
        const moduleName = (attached || (command[i + 1] as string | undefined) || '').toLowerCase();
        const rest = attached ? i + 1 : i + 2;
        if (moduleName === 'pip' || moduleName === 'uv') return scan(moduleName, command, rest);
        return null;
      }
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
  'docker_',
  'container_',
  'containers_', // CONTAINERS_CONF, CONTAINERS_REGISTRIES_CONF, CONTAINERS_STORAGE_CONF ...
  'bun_',
  'deno_',
  'git_',
  'xdg_',
  'java_',
  'perl5',
  'ruby',
];

/** Case-insensitive suffixes: `HTTP_PROXY`, `https_proxy`, `NO_PROXY`, `ALL_PROXY`. */
const ENV_SUFFIXES = ['_proxy'];

/** Case-insensitive exact names. */
const ENV_EXACT = [
  'registry_auth_file',
  'storage_driver',
  'storage_opts',
  'path',
  'pathext',
  'home',
  'userprofile',
  'shell',
  'ifs',
  'env',
  'bash_env',
  'ssl_cert_file',
  'ssl_cert_dir',
  'requests_ca_bundle',
  'curl_ca_bundle',
  'java_tool_options',
  '_java_options',
  'gconv_path',
  'classpath',
];

/** Exceptions to the prefixes: not a redirect, and widely set by operators. */
const ENV_ALLOWED = ['node_env'];

/**
 * SECURITY (TD-052): this blocklist is load-bearing. Child MCPs are launched through `setpriv`, which runs
 * with the server's ambient CAP_SETUID/SETGID/KILL and the child's env, so loader/runtime redirects
 * (LD_*, GCONV_PATH, ...) must never reach it from config.env.
 */
/** True when `name` may not be set through a catalog config, a credential field or an OAuth binding. */
export function isBlockedEnvName(name: string): boolean {
  const n = name.trim().toLowerCase();
  if (n === '') return false;
  if (ENV_ALLOWED.includes(n)) return false;
  return (
    ENV_EXACT.includes(n) ||
    ENV_PREFIXES.some(p => n.startsWith(p)) ||
    ENV_SUFFIXES.some(x => n.endsWith(x))
  );
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
