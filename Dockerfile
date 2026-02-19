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
# Run:   docker run -p 8443:8443 -v mcpambassador-data:/data mcpambassador-server
# =============================================================================

# -----------------------------------------------------------------------------
# STAGE 1: BUILD
# -----------------------------------------------------------------------------
# F-SEC-M7-001 remediation: Node 18 EOL → Node 20 LTS on Debian Slim (supported until April 2026)
FROM node:20-slim AS builder

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
FROM node:20-slim

# Install openssl for TLS certificate generation
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

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

COPY --from=builder --chown=mcpambassador:mcpambassador /build/packages/server/dist ./packages/server/dist
COPY --from=builder --chown=mcpambassador:mcpambassador /build/packages/server/package.json ./packages/server/
COPY --from=builder --chown=mcpambassador:mcpambassador /build/packages/server/node_modules ./packages/server/node_modules
COPY --from=builder --chown=mcpambassador:mcpambassador /build/packages/server/views ./packages/server/views
COPY --from=builder --chown=mcpambassador:mcpambassador /build/packages/server/public ./packages/server/public

# M24.9: Copy SPA dist (React app)
COPY --from=builder --chown=mcpambassador:mcpambassador /build/packages/spa/dist /app/public/spa

COPY --from=builder --chown=mcpambassador:mcpambassador /build/package.json ./

# Copy example config to bundled location (Docker default)
# This allows the server to start with pre-configured downstream MCPs
# Users can override by mounting custom config to /data/config/ambassador-server.yaml
RUN mkdir -p ./config
COPY --chown=mcpambassador:mcpambassador config/ambassador-server.example.yaml ./config/ambassador-server.example.yaml

# Create data directory with proper permissions
# This is the ONLY writable directory (for database, certs, audit logs)
RUN mkdir -p /data && \
    chown -R mcpambassador:mcpambassador /data && \
    chmod 700 /data

# Set environment variables
ENV NODE_ENV=production \
    MCP_AMBASSADOR_DATA_DIR=/data \
    MCP_AMBASSADOR_HOST=0.0.0.0 \
    MCP_AMBASSADOR_PORT=8443 \
    MCP_AMBASSADOR_LOG_LEVEL=info

# Configure npm/npx to use writable tmpfs (fixes npx on read-only filesystem)
ENV NPM_CONFIG_CACHE=/tmp/.npm-cache \
    HOME=/tmp

# Switch to non-root user
USER mcpambassador

# Expose ports
EXPOSE 8443
EXPOSE 9443

# Health check
# The server should respond to GET /health with 200 OK
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('https').get({hostname:'localhost',port:8443,path:'/health',rejectUnauthorized:false},(r)=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

# Volume for persistent data
VOLUME ["/data"]

# Start server
CMD ["node", "packages/server/dist/bin/server.js"]
