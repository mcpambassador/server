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

  const hint =
    'Run the container via docker/entrypoint.sh with cap_add SETUID, SETGID, KILL, CHOWN, or unset MCP_AMBASSADOR_CHILD_UID to disable child isolation (not recommended).';
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
      '--inh-caps=-all',
      '--ambient-caps=-all',
      '--',
      '/bin/sh',
      '-c',
      'mkdir -p -m 0700 "$TMPDIR" 2>/dev/null; cd "$0" && exec "$@"',
      cwd,
      cmd,
      ...args,
    ],
  };
}
