#!/usr/bin/env bash
#
# LVGL MCP Server - Setup Script (POSIX: Linux / macOS).
# Bash equivalent of scripts/setup.ps1. Validates build tools, initializes
# submodules, builds the simulator and the MCP server, smoke-tests the binary,
# and prints the Claude Code MCP config snippet.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SIM_DIR="$REPO_ROOT/simulator"
BUILD_DIR="$SIM_DIR/build"
MCP_DIR="$REPO_ROOT/mcp-server"

INSTALL_HINT="Install build prerequisites, e.g.:
  sudo apt install build-essential cmake ninja-build
  and Node.js 18+ (https://nodejs.org/)"

echo "=== LVGL MCP Server Setup ==="

# ── Validate tools ───────────────────────────────────────────────────

# Node.js 18+
if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js not found." >&2
  echo "$INSTALL_HINT" >&2
  exit 1
fi
NODE_VER="$(node --version)"           # e.g. v22.22.2
NODE_MAJOR="$(printf '%s' "$NODE_VER" | sed -E 's/^v?([0-9]+).*/\1/')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "[ERROR] Node.js 18+ required, found $NODE_VER." >&2
  exit 1
fi
echo "[OK] Node.js: $NODE_VER"

# CMake
if ! command -v cmake >/dev/null 2>&1; then
  echo "[ERROR] CMake not found." >&2
  echo "$INSTALL_HINT" >&2
  exit 1
fi
echo "[OK] CMake: $(cmake --version | head -n1)"

# Ninja or Make
if command -v ninja >/dev/null 2>&1; then
  echo "[OK] Ninja: $(ninja --version)"
elif command -v make >/dev/null 2>&1; then
  echo "[OK] Make: $(make --version | head -n1) (ninja not found, will use Makefiles)"
else
  echo "[ERROR] Neither ninja nor make found." >&2
  echo "$INSTALL_HINT" >&2
  exit 1
fi

# C compiler
CC_BIN="${CC:-}"
if [ -z "$CC_BIN" ]; then
  if command -v cc >/dev/null 2>&1; then CC_BIN="cc";
  elif command -v gcc >/dev/null 2>&1; then CC_BIN="gcc"; fi
fi
if [ -z "$CC_BIN" ] || ! command -v "$CC_BIN" >/dev/null 2>&1; then
  echo "[ERROR] No C compiler found (looked for \$CC, cc, gcc)." >&2
  echo "$INSTALL_HINT" >&2
  exit 1
fi
echo "[OK] C compiler: $CC_BIN"

# ── Initialize git submodules ────────────────────────────────────────
if [ ! -f "$SIM_DIR/lib/lvgl/CMakeLists.txt" ]; then
  echo "Initializing git submodules..."
  git -C "$REPO_ROOT" submodule update --init --recursive
fi
echo "[OK] LVGL submodule present"

# ── Build simulator (reuse build.sh) ─────────────────────────────────
echo ""
echo "Building simulator..."
bash "$SCRIPT_DIR/build.sh"
SIM_BIN="$BUILD_DIR/lvgl_sim"
if [ ! -x "$SIM_BIN" ]; then
  echo "[ERROR] Simulator binary not found at $SIM_BIN" >&2
  exit 1
fi
echo "[OK] Simulator built: $SIM_BIN"

# ── Build MCP server ─────────────────────────────────────────────────
echo ""
echo "Building MCP server..."
(
  cd "$MCP_DIR"
  npm install
  npm run build
)
echo "[OK] MCP server built: $MCP_DIR/dist/index.js"

# ── Smoke test ───────────────────────────────────────────────────────
echo ""
echo "Running quick test..."
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT
if "$SIM_BIN" --output-png "$TEST_DIR/test.png" --output-json "$TEST_DIR/test.json" >/dev/null 2>&1 \
   && [ -f "$TEST_DIR/test.png" ]; then
  echo "[OK] Test screenshot generated."
else
  echo "[WARN] Test screenshot not generated."
fi

# ── Print MCP config snippet ─────────────────────────────────────────
MCP_ENTRY="$MCP_DIR/dist/index.js"
echo ""
echo "=== Setup Complete ==="
echo ""
echo "Add this to your Claude Code MCP settings:"
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
