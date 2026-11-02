/**
 * TD-052: run downstream stdio MCP children as a different, unprivileged uid so they cannot read the
 * server's /data (SQLite DB, credential vault, TLS keys).
 *
 * Mechanism: the server (uid 1000) holds only CAP_SETUID/CAP_SETGID/CAP_KILL as AMBIENT capabilities
 * (granted by docker/entrypoint.sh). Each child is launched through `setpriv`, which switches to the child
 * uid/gid and clears the inheritable + ambient capability sets, so the child ends with no capabilities
 * (and no-new-privileges is set), i.e. it cannot setuid back to the server uid. Node's own spawn({uid})
 * is deliberately NOT used: the child would keep the ambient CAP_SETUID and could re-escalate.
 *
 * Opt-in: unset MCP_AMBASSADOR_CHILD_UID keeps the legacy behavior (children share the server uid).
 * If it is set but cannot be honored, the child is NOT started (fail closed).
 */
import { accessSync, constants, lstatSync, readFileSync } from 'node:fs';

export const SETPRIV_PATH = '/usr/bin/setpriv';
export const DEFAULT_CHILD_HOME = '/tmp/mcp-home';

const CAP_SETGID = 6;
const CAP_SETUID = 7;
const CAP_KILL = 5;

export interface ChildIsolation {
  uid: number;
  gid: number;
  home: string;
  /** TD-059: root-owned parent of a per-uid home (range mode only); verified before every spawn. */
  parent?: string;
}

export const DEFAULT_CHILD_HOMES_ROOT = '/tmp/mcp-homes';
export const DEFAULT_CHILD_UID_MAP = '/data/child-uids.json';
export const MAX_CHILD_UID_RANGE_SIZE = 10000;
export const MIN_CHILD_UID = 10000;

/** TD-059: how child uids are chosen. */
export type ChildIsolationConfig =
  | { kind: 'legacy'; iso: ChildIsolation }
  | {
      kind: 'range';
      min: number;
      max: number;
      homesRoot: string;
      mapPath: string;
    };

const HOME_COMPONENT_RE = /^\/tmp\/(?!\.{1,2}$)[A-Za-z0-9._-]+$/;

/**
 * TD-059: read MCP_AMBASSADOR_CHILD_UID_RANGE ("min-max"). Every downstream instance (shared MCP, or
 * user x MCP) then gets its OWN uid from the range and its own 0700 home under MCP_AMBASSADOR_CHILD_HOMES_ROOT
 * (default /tmp/mcp-homes, created root-owned 0711 with every home pre-created by docker/entrypoint.sh).
 * Falls back to the single shared uid (TD-052, MCP_AMBASSADOR_CHILD_UID) when the range is unset.
 */
export function resolveChildIsolationConfig(
  source: NodeJS.ProcessEnv = process.env,
  serverUid: number | undefined = process.getuid?.(),
  serverGid: number | undefined = process.getgid?.()
): ChildIsolationConfig | null {
  const rawRange = source['MCP_AMBASSADOR_CHILD_UID_RANGE']?.trim();
  if (!rawRange) {
    const iso = resolveChildIsolation(source, serverUid, serverGid);
    return iso ? { kind: 'legacy', iso } : null;
  }
  if (source['MCP_AMBASSADOR_CHILD_UID']?.trim()) {
    throw new Error(
      'MCP_AMBASSADOR_CHILD_UID and MCP_AMBASSADOR_CHILD_UID_RANGE are both set; use only the range'
    );
  }
  const m = /^(\d+)-(\d+)$/.exec(rawRange);
  if (!m) {
    throw new Error(
      `MCP_AMBASSADOR_CHILD_UID_RANGE must look like "20000-20999", got "${rawRange}"`
    );
  }
  const min = parseId('MCP_AMBASSADOR_CHILD_UID_RANGE (min)', m[1]!);
  const max = parseId('MCP_AMBASSADOR_CHILD_UID_RANGE (max)', m[2]!);
  if (min < MIN_CHILD_UID) {
    throw new Error(
      `MCP_AMBASSADOR_CHILD_UID_RANGE must start at ${MIN_CHILD_UID} or higher (system and login uids are off limits), got "${rawRange}"`
    );
  }
  if (max < min || max - min + 1 > MAX_CHILD_UID_RANGE_SIZE) {
    throw new Error(
      `MCP_AMBASSADOR_CHILD_UID_RANGE must have min <= max and at most ${MAX_CHILD_UID_RANGE_SIZE} ids, got "${rawRange}"`
    );
  }
  for (const [name, id] of [
    ['uid', serverUid],
    ['gid', serverGid],
  ] as const) {
    if (id !== undefined && id >= min && id <= max) {
      throw new Error(`MCP_AMBASSADOR_CHILD_UID_RANGE contains the server ${name} (${id})`);
    }
  }
  const homesRoot = source['MCP_AMBASSADOR_CHILD_HOMES_ROOT']?.trim() || DEFAULT_CHILD_HOMES_ROOT;
  if (!HOME_COMPONENT_RE.test(homesRoot)) {
    throw new Error(
      `MCP_AMBASSADOR_CHILD_HOMES_ROOT must be a single path component under /tmp, got "${homesRoot}"`
    );
  }
  const mapPath = source['MCP_AMBASSADOR_CHILD_UID_MAP']?.trim() || DEFAULT_CHILD_UID_MAP;
  if (!mapPath.startsWith('/')) {
    throw new Error('MCP_AMBASSADOR_CHILD_UID_MAP must be an absolute path');
  }
  return { kind: 'range', min, max, homesRoot, mapPath };
}

function parseId(name: string, raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a numeric id, got "${raw}"`);
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0 || n > 4294967294) {
    throw new Error(`${name} must be a non-zero unprivileged id, got "${raw}"`);
  }
  return n;
}

/**
 * Read the isolation settings from the environment. Returns null when isolation is not configured.
 * Throws on invalid values (including a child uid equal to the server's own uid).
 */
export function resolveChildIsolation(
  source: NodeJS.ProcessEnv = process.env,
  serverUid: number | undefined = process.getuid?.(),
  serverGid: number | undefined = process.getgid?.()
): ChildIsolation | null {
  const rawUid = source['MCP_AMBASSADOR_CHILD_UID']?.trim();
  if (!rawUid) return null;
  const uid = parseId('MCP_AMBASSADOR_CHILD_UID', rawUid);
  const rawGid = source['MCP_AMBASSADOR_CHILD_GID']?.trim();
  const gid = rawGid ? parseId('MCP_AMBASSADOR_CHILD_GID', rawGid) : uid;
  const home = source['MCP_AMBASSADOR_CHILD_HOME']?.trim() || DEFAULT_CHILD_HOME;
  // One plain component directly under /tmp (the persistent host cache bind), so no intermediate
  // component can be a symlink planted by an earlier child.
  if (!/^\/tmp\/(?!\.{1,2}$)[A-Za-z0-9._-]+$/.test(home)) {
    throw new Error(
      `MCP_AMBASSADOR_CHILD_HOME must be a single path component under /tmp, got "${home}"`
    );
  }
  if (serverUid !== undefined && uid === serverUid) {
    throw new Error(
      `MCP_AMBASSADOR_CHILD_UID (${uid}) equals the server uid; children would not be isolated`
    );
  }
  if (serverGid !== undefined && gid === serverGid) {
    throw new Error(`MCP_AMBASSADOR_CHILD_GID (${gid}) equals the server gid`);
  }
  return { uid, gid, home };
}

/** Parse the effective capability bitmask out of /proc/self/status content. */
export function parseCapEff(status: string): bigint | null {
  const m = /^CapEff:\s*([0-9a-fA-F]+)$/m.exec(status);
  return m ? BigInt('0x' + m[1]!) : null;
}

/**
 * Verify the process can actually switch uid. Returns an error message, or null when OK.
 * `capEff` and `setprivOk` are injectable for tests.
 */
export function checkIsolationAvailable(
  iso: ChildIsolation,
  deps: {
    capEff?: bigint | null;
    setprivOk?: boolean;
    homeOk?: boolean;
    parentOk?: boolean;
  } = {}
): string | null {
  const capEff =
    deps.capEff !== undefined
      ? deps.capEff
      : (() => {
          try {
            return parseCapEff(readFileSync('/proc/self/status', 'utf8'));
          } catch {
            return null;
          }
        })();
  const setprivOk =
    deps.setprivOk ??
    (() => {
      try {
        accessSync(SETPRIV_PATH, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    })();
  const homeOk =
    deps.homeOk ??
    (() => {
      try {
        // lstat: a symlink (e.g. planted by an earlier child) must never pass
        const st = lstatSync(iso.home);
        return (
          st.isDirectory() && !st.isSymbolicLink() && st.uid === iso.uid && (st.mode & 0o077) === 0
        );
      } catch {
        return false;
      }
    })();

  const parentOk =
    iso.parent === undefined
      ? true
      : (deps.parentOk ??
        (() => {
          try {
            // the parent must be a real root-owned dir nobody else can write: a child can then neither
            // create, rename nor replace any home entry
            const st = lstatSync(iso.parent);
            return (
              st.isDirectory() && !st.isSymbolicLink() && st.uid === 0 && (st.mode & 0o022) === 0
            );
          } catch {
            return false;
          }
        })());

  const hint =
    'Run the container via docker/entrypoint.sh with cap_add SETUID, SETGID, KILL, CHOWN, SETPCAP, or unset MCP_AMBASSADOR_CHILD_UID to disable child isolation (not recommended).';
  if (!setprivOk) {
    return `child isolation (uid ${iso.uid}) requires ${SETPRIV_PATH} (util-linux), which is missing. ${hint}`;
  }
  if (capEff === null) {
    return `child isolation (uid ${iso.uid}) could not read process capabilities. ${hint}`;
  }
  const need = [CAP_SETUID, CAP_SETGID, CAP_KILL];
  const missing = need.filter(c => (capEff & (1n << BigInt(c))) === 0n);
  if (missing.length > 0) {
    return `child isolation (uid ${iso.uid}) requires CAP_SETUID, CAP_SETGID and CAP_KILL; missing cap number(s) ${missing.join(',')}. ${hint}`;
  }
  if (!homeOk) {
    return `child isolation: child home ${iso.home} must be a real directory (not a symlink) owned by uid ${iso.uid} (created by docker/entrypoint.sh). ${hint}`;
  }
  if (!parentOk) {
    return `child isolation: ${iso.parent} must be a real directory owned by root and not writable by others (created by docker/entrypoint.sh). ${hint}`;
  }
  return null;
}

/**
 * Wrap a command so it runs as the child uid/gid with no capabilities.
 * The working directory is entered AFTER the uid switch (`cd` inside the child): node's own `cwd`
 * option would chdir as the server uid, which cannot enter the child's private (0700) home.
 * Spawn the wrapper with cwd '/'.
 */
export function wrapCommandForIsolation(
  cmd: string,
  args: string[],
  iso: ChildIsolation,
  cwd: string = iso.home
): { cmd: string; args: string[] } {
  return {
    cmd: SETPRIV_PATH,
    args: [
      `--reuid=${iso.uid}`,
      `--regid=${iso.gid}`,
      '--clear-groups',
      // No --bounding-set here: lowering it needs CAP_SETPCAP, which the server deliberately lacks. The
      // child inherits the server's bounding set {setuid,setgid,kill} but ends with ZERO permitted/
      // effective/ambient caps (cleared here, plus no-new-privileges), so the bounding set cannot be used.
      '--inh-caps=-all',
      '--ambient-caps=-all',
      '--',
      '/bin/sh',
      '-c',
      'chmod 0700 "$HOME" 2>/dev/null; mkdir -p -m 0700 "$TMPDIR" 2>/dev/null; cd -- "$0" && exec "$@"',
      cwd,
      cmd,
      ...args,
    ],
  };
}
