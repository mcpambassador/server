#!/bin/sh
# TD-052 entrypoint. Starts as root ONLY to prepare the child sandbox, then execs the server as uid 1000
# (no root process remains). The server keeps CAP_SETUID/CAP_SETGID/CAP_KILL as ambient capabilities so
# it can launch downstream MCP children as an unprivileged uid (see packages/server/src/downstream/
# child-isolation.ts). Container needs: cap_drop ALL; cap_add SETUID SETGID KILL CHOWN SETPCAP.
# If not started as root, it just execs the command; with MCP_AMBASSADOR_CHILD_UID set the server then
# refuses to start MCP children (fail closed) and logs why.
# NOTE: `docker exec` defaults to root in this image; use `docker exec -u 1000` for server-side inspection.
set -eu

SERVER_UID="${MCP_AMBASSADOR_SERVER_UID:-1000}"
SERVER_GID="${MCP_AMBASSADOR_SERVER_GID:-1000}"
CHILD_UID="${MCP_AMBASSADOR_CHILD_UID:-}"
CHILD_GID="${MCP_AMBASSADOR_CHILD_GID:-$CHILD_UID}"
CHILD_HOME="${MCP_AMBASSADOR_CHILD_HOME:-/tmp/mcp-home}"

die() { echo "entrypoint: $*" >&2; exit 1; }

if [ "$(id -u)" != "0" ]; then
  exec "$@"
fi

case "$SERVER_UID$SERVER_GID" in *[!0-9]*|'') die "server uid/gid must be numeric" ;; esac
[ "$SERVER_UID" != "0" ] && [ "$SERVER_GID" != "0" ] || die "server uid/gid must not be 0"

as_server() {
  setpriv --reuid="$SERVER_UID" --regid="$SERVER_GID" --clear-groups "$@"
}

if [ -z "$CHILD_UID" ]; then
  # Isolation not configured: legacy behavior, no capabilities at all.
  exec setpriv --reuid="$SERVER_UID" --regid="$SERVER_GID" --clear-groups \
    --inh-caps=-all --ambient-caps=-all --bounding-set=-all "$@"
fi

case "$CHILD_UID$CHILD_GID" in *[!0-9]*) die "MCP_AMBASSADOR_CHILD_UID/GID must be numeric" ;; esac
[ "$CHILD_UID" != "0" ] && [ "$CHILD_GID" != "0" ] || die "child uid/gid must not be 0"
[ "$CHILD_UID" != "$SERVER_UID" ] || die "child uid must differ from the server uid"
[ "$CHILD_GID" != "$SERVER_GID" ] || die "child gid must differ from the server gid"

# The child home must be ONE plain component directly under /tmp: /tmp is the persistent host cache bind
# that earlier (uid 1000) children could write to, so a symlink there must never be followed by root.
case "$CHILD_HOME" in
  /tmp/*/*|/tmp/|/tmp|/tmp/.|/tmp/..) die "MCP_AMBASSADOR_CHILD_HOME must be a single path component under /tmp" ;;
  /tmp/*) ;;
  *) die "MCP_AMBASSADOR_CHILD_HOME must be a single path component under /tmp" ;;
esac
case "${CHILD_HOME#/tmp/}" in *[!A-Za-z0-9._-]*) die "MCP_AMBASSADOR_CHILD_HOME has unsafe characters" ;; esac
if [ -L "$CHILD_HOME" ]; then die "$CHILD_HOME is a symlink; refusing to start (wipe the cache dir)"; fi
if [ -e "$CHILD_HOME" ] && [ ! -d "$CHILD_HOME" ]; then die "$CHILD_HOME exists and is not a directory"; fi

# /data must be private to the server uid even if the host bind directory was created group/world-readable.
as_server chmod 0700 /data
# /tmp (host cache bind) must not be writable by the child uid; server-owned cache dirs are private.
as_server chmod 0755 /tmp
for d in /tmp/.npm-cache /tmp/.uv-cache; do
  if [ -d "$d" ] && [ ! -L "$d" ]; then as_server chmod 0700 "$d"; fi
done
# Child home: created by the server uid (0700, so root needs no DAC override), then handed to the child.
as_server mkdir -p -m 0700 "$CHILD_HOME"
if [ -L "$CHILD_HOME" ] || [ ! -d "$CHILD_HOME" ]; then die "$CHILD_HOME is not a plain directory"; fi
chown -h "$CHILD_UID:$CHILD_GID" "$CHILD_HOME"
[ "$(stat -c %u:%g "$CHILD_HOME")" = "$CHILD_UID:$CHILD_GID" ] || die "could not hand $CHILD_HOME to the child uid"
[ "$(stat -c %u "/data")" = "$SERVER_UID" ] || die "/data is not owned by the server uid $SERVER_UID"

# Drop root for good: exec as the server uid; only these three caps survive (ambient) and nothing else
# stays in the bounding set.
exec setpriv --reuid="$SERVER_UID" --regid="$SERVER_GID" --clear-groups \
  --inh-caps=-all,+setuid,+setgid,+kill --ambient-caps=-all,+setuid,+setgid,+kill \
  --bounding-set=-all,+setuid,+setgid,+kill "$@"
