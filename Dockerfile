# =============================================================================
# MCP AMBASSADOR SERVER - MULTI-STAGE DOCKERFILE
# =============================================================================
# Security Features:
# - Multi-stage build (build + runtime separation)
# - Non-root user (mcpambassador:1000)
# - Read-only root filesystem (except /data volume)
# - Minimal Debian Slim runtime (reduced attack surface)
# - No unnecessary build tools in final image
#
# Build: docker build -t mcpambassador-server:latest .
# Run:   docker-compose up -d  (see docker-compose.yml for bind mount config)
# =============================================================================

# -----------------------------------------------------------------------------
# STAGE 1: BUILD
# -----------------------------------------------------------------------------
# F-SEC-M7-001 remediation: Node 18 EOL → Node 20 LTS on Debian Slim (supported until April 2026)
# Base image pinned by digest (index of node:20-slim, `docker buildx imagetools inspect node:20-slim`, 2026-11-01)
FROM node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS builder

# Install build tools for native modules (better-sqlite3, argon2)
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*

# Install pnpm
RUN npm install -g pnpm@8.15.0

# Set working directory
WORKDIR /build

# Copy package manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json ./packages/core/
COPY packages/protocol/package.json ./packages/protocol/
COPY packages/authn-ephemeral/package.json ./packages/authn-ephemeral/
COPY packages/authz-local/package.json ./packages/authz-local/
COPY packages/audit-file/package.json ./packages/audit-file/
COPY packages/server/package.json ./packages/server/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/spa/package.json ./packages/spa/

# Install dependencies
# Using --shamefully-hoist to flatten node_modules (npm-style) for Docker compatibility
# This prevents pnpm symlink issues when copying to the runtime stage
RUN pnpm install --frozen-lockfile --shamefully-hoist

# Copy source code
COPY tsconfig.base.json ./
COPY packages/ ./packages/

# Build all packages (server packages use tsc, spa uses vite)
RUN pnpm build

# -----------------------------------------------------------------------------
# STAGE 1a: BUILD SPA (separate for better caching)
# -----------------------------------------------------------------------------
# Already built in stage 1, this comment marks the separation

# -----------------------------------------------------------------------------
# STAGE 2: RUNTIME
# -----------------------------------------------------------------------------
# F-SEC-M7-001 remediation: Node 18 EOL → Node 20 LTS on Debian Slim (supported until April 2026)
FROM node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0

# Install openssl for TLS certificate generation, and the distro python3 so uvx-launched (PyPI)
# MCP servers run on a fixed interpreter instead of downloading a managed Python at runtime.
RUN apt-get update && apt-get install -y --no-install-recommends openssl python3 tini=0.19.0-1+b3 && rm -rf /var/lib/apt/lists/*

# uv/uvx for registry entries that run via `uvx <pkg>==<version>` (e.g. Alpaca).
# Pinned by version AND digest. Digest = the multi-arch image index of ghcr.io/astral-sh/uv:0.13.6,
# read with `docker buildx imagetools inspect ghcr.io/astral-sh/uv:0.13.6` (2026-11-01).
# To bump: pick a release from https://github.com/astral-sh/uv/releases, re-inspect, update both.
COPY --from=ghcr.io/astral-sh/uv:0.13.6@sha256:af22a52f5eafef3d78e551599d405c02df61919d18028f0cea8eda93bc9986d0 /uv /uvx /usr/local/bin/

# Create non-root user (node:20-slim has node:1000 — remove it first)
RUN userdel node 2>/dev/null; groupdel node 2>/dev/null; \
    groupadd -g 1000 mcpambassador && \
    useradd -u 1000 -g mcpambassador -m -s /bin/false mcpambassador

# Set working directory
WORKDIR /app

# Copy built artifacts from builder
# Root node_modules contains all external dependencies (hoisted)
COPY --from=builder --chown=mcpambassador:mcpambassador /build/node_modules ./node_modules

# Copy each workspace package with its dist, package.json, and node_modules
# The node_modules in each package contains symlinks to workspace dependencies
COPY --from=builder --chown=mcpambassador:mcpambassador /build/packages/core/dist ./packages/core/dist
COPY --from=builder --chown=mcpambassador:mcpambassador /build/packages/core/drizzle ./packages/core/drizzle
COPY --from=builder --chown=mcpambassador:mcpambassador /build/packages/core/package.json ./packages/core/
COPY --from=builder --chown=mcpambassador:mcpambassador /build/packages/core/node_modules ./packages/core/node_modules

COPY --from=builder --chown=mcpambassador:mcpambassador /build/packages/protocol/dist ./packages/protocol/dist
COPY --from=builder --chown=mcpambassador:mcpambassador /build/packages/protocol/package.json ./packages/protocol/
COPY --from=builder --chown=mcpambassador:mcpambassador /build/packages/protocol/node_modules ./packages/protocol/node_modules

COPY --from=builder --chown=mcpambassador:mcpambassador /build/packages/authn-ephemeral/dist ./packages/authn-ephemeral/dist
COPY --from=builder --chown=mcpambassador:mcpambassador /build/packages/authn-ephemeral/package.json ./packages/authn-ephemeral/
COPY --from=builder --chown=mcpambassador:mcpambassador /build/packages/authn-ephemeral/node_modules ./packages/authn-ephemeral/node_modules

COPY --from=builder --chown=mcpambassador:mcpambassador /build/packages/authz-local/dist ./packages/authz-local/dist
COPY --from=builder --chown=mcpambassador:mcpambassador /build/packages/authz-local/package.json ./packages/authz-local/
COPY --from=builder --chown=mcpambassador:mcpambassador /build/packages/authz-local/node_modules ./packages/authz-local/node_modules

COPY --from=builder --chown=mcpambassador:mcpambassador /build/packages/audit-file/dist ./packages/audit-file/dist
COPY --from=builder --chown=mcpambassador:mcpambassador /build/packages/audit-file/package.json ./packages/audit-file/
COPY --from=builder --chown=mcpambassador:mcpambassador /build/packages/audit-file/node_modules ./packages/audit-file/node_modules

COPY --from=builder --chown=mcpambassador:mcpambassador /build/packages/contracts/dist ./packages/contracts/dist
COPY --from=builder --chown=mcpambassador:mcpambassador /build/packages/contracts/package.json ./packages/contracts/
COPY --from=builder --chown=mcpambassador:mcpambassador /build/packages/contracts/node_modules ./packages/contracts/node_modules

COPY --from=builder --chown=mcpambassador:mcpambassador /build/packages/server/dist ./packages/server/dist
COPY --from=builder --chown=mcpambassador:mcpambassador /build/packages/server/package.json ./packages/server/
COPY --from=builder --chown=mcpambassador:mcpambassador /build/packages/server/node_modules ./packages/server/node_modules

# M24.9: Copy SPA dist (React app)
COPY --from=builder --chown=mcpambassador:mcpambassador /build/packages/spa/dist /app/public/spa

COPY --from=builder --chown=mcpambassador:mcpambassador /build/package.json ./

# Copy example config to bundled location (Docker default)
# This allows the server to start with pre-configured downstream MCPs
# Users can override by mounting custom config to /data/config/ambassador-server.yaml
RUN mkdir -p ./config
COPY --chown=mcpambassador:mcpambassador config/ambassador-server.example.yaml ./config/ambassador-server.example.yaml

# Create data and config directories with proper permissions
# /data = writable (database, certs, audit logs, secrets)
# /config = read-only mount point for configuration files
RUN mkdir -p /data /config && \
    chown -R mcpambassador:mcpambassador /data /config && \
    chmod 700 /data /config

# Set environment variables
ENV NODE_ENV=production \
    MCP_AMBASSADOR_DATA_DIR=/data \
    MCP_AMBASSADOR_HOST=0.0.0.0 \
    MCP_AMBASSADOR_PORT=8443 \
    MCP_AMBASSADOR_LOG_LEVEL=info

# Configure npm/npx to use writable tmpfs (fixes npx on read-only filesystem)
ENV NPM_CONFIG_CACHE=/tmp/.npm-cache \
    HOME=/tmp

# uv: use the system python3 only (never download one) and keep the package cache under /tmp, the
# writable path the runtime user owns on a read-only rootfs. uvx uses ephemeral envs inside the cache,
# so UV_TOOL_DIR (only for `uv tool install`) is not set. These are forwarded to spawned MCPs by
# stdio-connection (SERVER_CONTROLLED_ENV_VARS), together with NPM_CONFIG_CACHE.
# docker-compose bind-mounts ./cache onto /tmp, so the cache survives container recreates
# (same as the npm cache); /data is deliberately NOT used because it holds the database and secrets.
ENV UV_PYTHON_DOWNLOADS=never \
    UV_PYTHON=/usr/bin/python3 \
    UV_CACHE_DIR=/tmp/.uv-cache

# TD-052/TD-059: unprivileged uids for downstream MCP child processes. Every downstream instance (shared
# MCP, or user x MCP) gets its OWN uid from MCP_AMBASSADOR_CHILD_UID_RANGE and its own 0700 home under
# /tmp/mcp-homes/<uid> (all created by docker/entrypoint.sh); none can read /data or another child's
# environ/home. passwd/group entries are built for the default range so tools that look up the user work
# on the read-only rootfs (a runtime range outside it only logs a warning). uid 1001 (mcpchild) is kept
# for the legacy single-uid mode (MCP_AMBASSADOR_CHILD_UID=1001, home /tmp/mcp-home).
RUN groupadd -g 1001 mcpchild && useradd -u 1001 -g mcpchild -M -d /nonexistent -s /bin/false mcpchild \
 && for u in $(seq 20000 20999); do \
      echo "mcpchild$u:x:$u:$u:mcp child:/nonexistent:/bin/false" >> /etc/passwd; \
      echo "mcpchild$u:x:$u:" >> /etc/group; \
    done
ENV MCP_AMBASSADOR_CHILD_UID_RANGE=20000-20999

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh

# The container starts as root ONLY so the entrypoint can prepare the child sandbox; it then execs the
# server as mcpambassador (uid 1000) with just CAP_SETUID/SETGID/KILL (compose: cap_drop ALL + cap_add
# SETUID SETGID KILL CHOWN). Without those caps (or when started as non-root) child MCPs fail closed.
USER root
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

# Expose ports
EXPOSE 8443
EXPOSE 9443

# Health check
# The server should respond to GET /health with 200 OK
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD setpriv --reuid=1000 --regid=1000 --clear-groups node -e "require('https').get({hostname:'localhost',port:8443,path:'/health',rejectUnauthorized:false},(r)=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

# Volume mount points for bind mounts
VOLUME ["/data", "/config"]

# Start server
CMD ["node", "packages/server/dist/bin/server.js"]
