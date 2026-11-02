#!/bin/sh
# Manual check: an isolated MCP child has NoNewPrivs 1 even when the container runs WITHOUT
# security_opt no-new-privileges. Usage: docker/check-child-no-new-privs.sh [image]   (default: mcpambassador-server:local)
set -eu
IMAGE="${1:-mcpambassador-server:local}"
SCRIPT='
import { spawnSync } from "node:child_process";
const m = await import("/app/packages/server/dist/downstream/child-isolation.js");
const iso = { uid: 20000, gid: 20000, home: "/tmp/mcp-homes/20000" };
const w = m.wrapCommandForIsolation("grep", ["^NoNewPrivs", "/proc/self/status"], iso, "/", 0);
const r = spawnSync(w.cmd, w.args, { encoding: "utf8", env: { HOME: iso.home, TMPDIR: iso.home + "/t", PATH: "/usr/bin:/bin" } });
process.stdout.write(r.stdout);
process.exit(/NoNewPrivs:\s*1/.test(r.stdout) ? 0 : 1);
'
docker run --rm --user 0:0 --cap-drop ALL --cap-add SETUID --cap-add SETGID --cap-add KILL \
  --cap-add CHOWN --cap-add SETPCAP --tmpfs /tmp:uid=1000,gid=1000,mode=0755 \
  "$IMAGE" node --input-type=module -e "$SCRIPT"
echo "OK: child has NoNewPrivs 1 without security_opt"
