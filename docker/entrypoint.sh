#!/bin/sh
# TD-052 entrypoint. Starts as root ONLY to prepare the child sandbox, then execs the server as uid 1000
# (no root process remains). The server keeps CAP_SETUID/CAP_SETGID/CAP_KILL as ambient capabilities so
# it can launch downstream MCP children as an unprivileged uid (see packages/server/src/downstream/
# child-isolation.ts). Container needs: cap_drop ALL; cap_add SETUID SETGID KILL CHOWN SETPCAP.
# TD-059: MCP_AMBASSADOR_CHILD_UID_RANGE=min-max gives every downstream instance its own uid and 0700 home
# (/tmp/mcp-homes/<uid>, root-owned 0711 parent, all homes pre-created here).
# If not started as root, it just execs the command; with MCP_AMBASSADOR_CHILD_UID set the server then
# refuses to start MCP children (fail closed) and logs why.
# NOTE: `docker exec` defaults to root in this image; use `docker exec -u 1000` for server-side inspection.
set -eu

SERVER_UID="${MCP_AMBASSADOR_SERVER_UID:-1000}"
SERVER_GID="${MCP_AMBASSADOR_SERVER_GID:-1000}"
CHILD_UID="${MCP_AMBASSADOR_CHILD_UID:-}"
CHILD_RANGE="${MCP_AMBASSADOR_CHILD_UID_RANGE:-}"
HOMES_ROOT="${MCP_AMBASSADOR_CHILD_HOMES_ROOT:-/tmp/mcp-homes}"
CHILD_GID="${MCP_AMBASSADOR_CHILD_GID:-$CHILD_UID}"
CHILD_HOME="${MCP_AMBASSADOR_CHILD_HOME:-/tmp/mcp-home}"

die() { echo "entrypoint: $*" >&2; exit 1; }

if [ "$(id -u)" != "0" ]; then
  exec "$@"
fi

case "$SERVER_UID$SERVER_GID" in *[!0-9]*|'') die "server uid/gid must be numeric" ;; esac
[ "$SERVER_UID" != "0" ] && [ "$SERVER_GID" != "0" ] || die "server uid/gid must not be 0"

umask 077 # anything the server creates after boot (caches, temp dirs) is private to the server uid

as_server() {
  setpriv --reuid="$SERVER_UID" --regid="$SERVER_GID" --clear-groups "$@"
}

if [ -z "$CHILD_UID" ] && [ -z "$CHILD_RANGE" ]; then
  # Isolation not configured: legacy behavior, no capabilities at all.
  exec setpriv --reuid="$SERVER_UID" --regid="$SERVER_GID" --clear-groups \
    --inh-caps=-all --ambient-caps=-all --bounding-set=-all "$@"
fi

if [ -n "$CHILD_RANGE" ]; then
  # TD-059: one uid (and gid) and one 0700 home per downstream instance, from a range.
  [ -z "$CHILD_UID" ] || die "MCP_AMBASSADOR_CHILD_UID and MCP_AMBASSADOR_CHILD_UID_RANGE are both set; use only the range"
  case "$CHILD_RANGE" in
    [0-9]*-[0-9]*) ;;
    *) die "MCP_AMBASSADOR_CHILD_UID_RANGE must look like 20000-20999" ;;
  esac
  RANGE_MIN="${CHILD_RANGE%-*}"
  RANGE_MAX="${CHILD_RANGE#*-}"
  case "$RANGE_MIN$RANGE_MAX" in *[!0-9]*) die "MCP_AMBASSADOR_CHILD_UID_RANGE must be numeric" ;; esac
  [ "$RANGE_MIN" -ge 1 ] && [ "$RANGE_MAX" -ge "$RANGE_MIN" ] || die "MCP_AMBASSADOR_CHILD_UID_RANGE must have 1 <= min <= max"
  [ $((RANGE_MAX - RANGE_MIN + 1)) -le 10000 ] || die "MCP_AMBASSADOR_CHILD_UID_RANGE may hold at most 10000 ids"
  for id in "$SERVER_UID" "$SERVER_GID"; do
    if [ "$id" -ge "$RANGE_MIN" ] && [ "$id" -le "$RANGE_MAX" ]; then die "MCP_AMBASSADOR_CHILD_UID_RANGE contains the server uid/gid $id"; fi
  done
  # Same rules as the legacy home: ONE plain component under /tmp (the persistent host cache bind that
  # earlier children could write to), so root never follows a planted symlink.
  case "$HOMES_ROOT" in
    /tmp/*/*|/tmp/|/tmp|/tmp/.|/tmp/..) die "MCP_AMBASSADOR_CHILD_HOMES_ROOT must be a single path component under /tmp" ;;
    /tmp/*) ;;
    *) die "MCP_AMBASSADOR_CHILD_HOMES_ROOT must be a single path component under /tmp" ;;
  esac
  case "${HOMES_ROOT#/tmp/}" in *[!A-Za-z0-9._-]*) die "MCP_AMBASSADOR_CHILD_HOMES_ROOT has unsafe characters" ;; esac
  if [ -L "$HOMES_ROOT" ]; then die "$HOMES_ROOT is a symlink; refusing to start (wipe the cache dir)"; fi
  if [ -e "$HOMES_ROOT" ] && [ ! -d "$HOMES_ROOT" ]; then die "$HOMES_ROOT exists and is not a directory"; fi

  as_server chmod 0700 /data
  as_server chmod 0755 /tmp
  for d in /tmp/.npm-cache /tmp/.uv-cache; do
    if [ -d "$d" ] && [ ! -L "$d" ]; then as_server chmod 0700 "$d"; fi
  done

  # Parent: root-owned 0711. Children can traverse to their own home but cannot list, create, rename or
  # delete any entry, so a child can neither squat on nor replace another uid's home. Only real dirs are
  # ever re-owned or re-moded (symlinks and non-directories were refused above/below).
  # (root has no CAP_DAC_OVERRIDE and /tmp is server-owned, so the server uid creates it and root takes it over)
  [ -d "$HOMES_ROOT" ] || as_server mkdir -m 0711 "$HOMES_ROOT"
  [ -d "$HOMES_ROOT" ] && [ ! -L "$HOMES_ROOT" ] || die "$HOMES_ROOT is not a plain directory"
  chown -h 0:0 "$HOMES_ROOT"
  chmod 0711 "$HOMES_ROOT"

  # Homes: pre-created here (root has CAP_CHOWN; the server never does), re-applied on every boot so a
  # chmod'ed or re-owned home heals instead of locking the instance out.
  nopasswd=0
  uid="$RANGE_MIN"
  while [ "$uid" -le "$RANGE_MAX" ]; do
    h="$HOMES_ROOT/$uid"
    if [ -L "$h" ]; then die "$h is a symlink; refusing to start (wipe the cache dir)"; fi
    if [ -e "$h" ] && [ ! -d "$h" ]; then die "$h exists and is not a directory"; fi
    [ -d "$h" ] || mkdir -m 0700 "$h"
    if [ -L "$h" ] || [ ! -d "$h" ]; then die "$h is not a plain directory"; fi
    if [ "$(stat -c %u:%g:%a "$h")" != "$uid:$uid:700" ]; then
      chown -h "$uid:$uid" "$h"
      # root has no CAP_FOWNER: the mode of a home it no longer owns is fixed as that uid
      setpriv --reuid="$uid" --regid="$uid" --clear-groups chmod 0700 "$h"
    fi
    if ! grep -q "^[^:]*:[^:]*:$uid:" /etc/passwd 2>/dev/null; then nopasswd=$((nopasswd + 1)); fi
    uid=$((uid + 1))
  done
  if [ "$nopasswd" -gt 0 ]; then
    echo "entrypoint: WARNING: $nopasswd uid(s) in $CHILD_RANGE have no /etc/passwd entry (the image only builds entries for its default range); tools that look up the user may fail" >&2
  fi
  [ "$(stat -c %u "/data")" = "$SERVER_UID" ] || die "/data is not owned by the server uid $SERVER_UID"

  exec setpriv --reuid="$SERVER_UID" --regid="$SERVER_GID" --clear-groups \
    --inh-caps=-all,+setuid,+setgid,+kill --ambient-caps=-all,+setuid,+setgid,+kill \
    --bounding-set=-all,+setuid,+setgid,+kill "$@"
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
[ "$(stat -c %u:%g:%a "$CHILD_HOME")" = "$CHILD_UID:$CHILD_GID:700" ] || die "$CHILD_HOME must be owned by the child uid with mode 0700"
[ "$(stat -c %u "/data")" = "$SERVER_UID" ] || die "/data is not owned by the server uid $SERVER_UID"

# Anything the server creates after boot (caches, temp dirs) is private to the server uid.
# Drop root for good: exec as the server uid; only these three caps survive (ambient) and nothing else
# stays in the bounding set.
exec setpriv --reuid="$SERVER_UID" --regid="$SERVER_GID" --clear-groups \
  --inh-caps=-all,+setuid,+setgid,+kill --ambient-caps=-all,+setuid,+setgid,+kill \
  --bounding-set=-all,+setuid,+setgid,+kill "$@"
