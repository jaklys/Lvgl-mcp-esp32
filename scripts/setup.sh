#!/usr/bin/env bash
#
# LVGL MCP Server - setup script for Linux (macOS: experimental).
# Bash counterpart of scripts/setup.ps1. Validates the toolchain, initializes
# the LVGL submodule, builds the simulator (scripts/build.sh) and the MCP
# server, smoke-tests the binary and prints the MCP client configuration.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SIM_DIR="$REPO_ROOT/simulator"
BUILD_DIR="$SIM_DIR/build"
MCP_DIR="$REPO_ROOT/mcp-server"

if [ "$(uname -s)" = "Darwin" ]; then
  INSTALL_HINT="Install prerequisites, e.g.:
  xcode-select --install && brew install cmake ninja node"
else
  INSTALL_HINT="Install prerequisites, e.g.:
  sudo apt install build-essential cmake ninja-build git   (Debian/Ubuntu)
  and Node.js 20+ (https://nodejs.org/)"
fi

die() {
  echo "[ERROR] $*" >&2
  echo "$INSTALL_HINT" >&2
  exit 1
}

echo "=== LVGL MCP Server Setup ==="

# ── Validate tools ───────────────────────────────────────────────────
command -v git >/dev/null 2>&1 || die "git not found."
echo "[OK] git: $(git --version)"

command -v node >/dev/null 2>&1 || die "Node.js not found."
NODE_VER="$(node --version)"
NODE_MAJOR="$(printf '%s' "$NODE_VER" | sed -E 's/^v?([0-9]+).*/\1/')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node.js 20+ required, found $NODE_VER."
command -v npm >/dev/null 2>&1 || die "npm not found."
echo "[OK] Node.js: $NODE_VER"

# C/C++ compilers, CMake >= 3.16 and Ninja/Make: same checks as build.sh.
bash "$SCRIPT_DIR/build.sh" --check || die "Toolchain check failed (see above)."
echo "[OK] Build toolchain"

# ── Initialize git submodules ────────────────────────────────────────
if [ ! -f "$SIM_DIR/lib/lvgl/CMakeLists.txt" ]; then
  echo "Initializing git submodules..."
  git -C "$REPO_ROOT" submodule update --init --recursive
fi
echo "[OK] LVGL submodule present"

# ── Build simulator ──────────────────────────────────────────────────
echo ""
echo "Building simulator..."
bash "$SCRIPT_DIR/build.sh"
SIM_BIN="$BUILD_DIR/lvgl_sim"
[ -x "$SIM_BIN" ] || die "Simulator binary not found at $SIM_BIN"
echo "[OK] Simulator built: $SIM_BIN"

# ── Build MCP server ─────────────────────────────────────────────────
# --ignore-scripts: the postinstall download is for npm installs only; in a
# checkout the server must use the simulator built above.
echo ""
echo "Building MCP server..."
(
  cd "$MCP_DIR"
  npm ci --ignore-scripts
  npm run build
)
echo "[OK] MCP server built: $MCP_DIR/dist/index.js"

# ── Smoke test (fails the setup on error) ────────────────────────────
echo ""
echo "Running smoke test..."
node "$SCRIPT_DIR/smoke-test.mjs" "$SIM_BIN" 320 240

# ── Print MCP config ─────────────────────────────────────────────────
MCP_ENTRY="$MCP_DIR/dist/index.js"
echo ""
echo "=== Setup Complete ==="
echo ""
echo "Register the server with Claude Code (run inside your ESP32 project):"
echo "  claude mcp add lvgl-simulator -- node \"$MCP_ENTRY\""
echo ""
echo "or add this to .mcp.json in your project (Cursor/VS Code use the same shape):"
cat <<EOF
{
  "mcpServers": {
    "lvgl-simulator": {
      "command": "node",
      "args": ["$MCP_ENTRY"]
    }
  }
}
EOF
