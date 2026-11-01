#!/bin/sh
# TD-052 entrypoint. Starts as root ONLY to prepare the child sandbox, then execs the server as uid 1000
# (no root process remains). The server keeps CAP_SETUID/CAP_SETGID/CAP_KILL as ambient capabilities so
# it can launch downstream MCP children as an unprivileged uid (see packages/server/src/downstream/
# child-isolation.ts). Container needs: cap_drop ALL; cap_add SETUID SETGID KILL CHOWN.
# If not started as root (legacy deploys), it just execs the command; with MCP_AMBASSADOR_CHILD_UID set
# the server then refuses to start MCP children (fail closed) and logs why.
set -eu

SERVER_UID="${MCP_AMBASSADOR_SERVER_UID:-1000}"
SERVER_GID="${MCP_AMBASSADOR_SERVER_GID:-1000}"
CHILD_UID="${MCP_AMBASSADOR_CHILD_UID:-}"
CHILD_GID="${MCP_AMBASSADOR_CHILD_GID:-$CHILD_UID}"
CHILD_HOME="${MCP_AMBASSADOR_CHILD_HOME:-/tmp/mcp-home}"

if [ "$(id -u)" != "0" ]; then
  exec "$@"
fi

as_server() {
  setpriv --reuid="$SERVER_UID" --regid="$SERVER_GID" --clear-groups "$@"
}

if [ -n "$CHILD_UID" ]; then
  if [ "$CHILD_UID" = "$SERVER_UID" ] || [ "$CHILD_UID" = "0" ]; then
    echo "entrypoint: MCP_AMBASSADOR_CHILD_UID must differ from the server uid and not be 0" >&2
    exit 1
  fi
  # /data must be private to the server uid even if the host bind directory was created group/world-readable.
  as_server chmod 0700 /data
  # /tmp (host cache bind) must not be writable by the child uid; server-owned cache dirs are private.
  as_server chmod 0755 /tmp
  for d in /tmp/.npm-cache /tmp/.uv-cache; do
    if [ -d "$d" ]; then as_server chmod 0700 "$d"; fi
  done
  # Child home: created by the server uid (0700, so root needs no DAC override), then handed to the child.
  as_server mkdir -p -m 0700 "$CHILD_HOME"
  chown "$CHILD_UID:$CHILD_GID" "$CHILD_HOME"
fi

# Drop root for good: exec as the server uid; only these three caps survive (ambient).
exec setpriv --reuid="$SERVER_UID" --regid="$SERVER_GID" --clear-groups \
  --inh-caps=-all,+setuid,+setgid,+kill --ambient-caps=-all,+setuid,+setgid,+kill "$@"
