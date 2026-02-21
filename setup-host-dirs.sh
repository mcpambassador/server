#!/bin/bash
# =============================================================================
# MCP AMBASSADOR SERVER - HOST DIRECTORY SETUP
# =============================================================================
# Creates the required host directories for Docker bind mounts
# Run this before `docker-compose up` on first startup
#
# Usage: ./setup-host-dirs.sh
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> Creating MCP Ambassador host directories..."

# Create directories
mkdir -p "$SCRIPT_DIR/data"
mkdir -p "$SCRIPT_DIR/config"
mkdir -p "$SCRIPT_DIR/cache"

# Set permissions (UID 1000 = mcpambassador user in container)
# Note: If your host user is not UID 1000, you may need to run this with sudo
# or adjust ownership after creation
if [ "$(id -u)" -eq 1000 ]; then
  echo "==> Setting ownership to current user (UID 1000)"
  chown -R 1000:1000 "$SCRIPT_DIR/data" "$SCRIPT_DIR/config" "$SCRIPT_DIR/cache"
else
  echo "==> WARNING: Your UID is $(id -u), but container runs as UID 1000"
  echo "    You may need to run: sudo chown -R 1000:1000 ./data ./config ./cache"
  echo "    Or run this script with: sudo -u '#1000' ./setup-host-dirs.sh"
fi

# Set permissions (700 for data/config, 755 for cache)
chmod 700 "$SCRIPT_DIR/data"
chmod 700 "$SCRIPT_DIR/config"
chmod 755 "$SCRIPT_DIR/cache"

echo "==> Done! Directory structure:"
ls -ld "$SCRIPT_DIR/data" "$SCRIPT_DIR/config" "$SCRIPT_DIR/cache"

echo ""
echo "==> Next steps:"
echo "    1. (Optional) Copy config/ambassador-server.example.yaml to ./config/ambassador-server.yaml"
echo "    2. Run: docker-compose up -d"
echo "    3. Monitor logs: docker-compose logs -f"
