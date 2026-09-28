#!/usr/bin/env bash
#
# LVGL simulator build script for Linux (macOS: experimental).
# Bash counterpart of scripts/build.bat. Uses the system C and C++ compilers
# ($CC/$CXX, else cc/c++), CMake >= 3.16 and Ninja if available (otherwise
# Unix Makefiles). Builds simulator/build in Release mode.
#
#   scripts/build.sh           check tools, configure and build
#   scripts/build.sh --check   only check the toolchain (used by setup.sh)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SIM_DIR="$REPO_ROOT/simulator"
BUILD_DIR="$SIM_DIR/build"

if [ "$(uname -s)" = "Darwin" ]; then
  INSTALL_HINT="Install build prerequisites, e.g.:
  xcode-select --install && brew install cmake ninja"
else
  INSTALL_HINT="Install build prerequisites, e.g.:
  sudo apt install build-essential cmake ninja-build git   (Debian/Ubuntu)
  sudo dnf install gcc gcc-c++ cmake ninja-build git       (Fedora)"
fi

die() {
  echo "ERROR: $*" >&2
  echo "$INSTALL_HINT" >&2
  exit 1
}

# ── Check tools ──────────────────────────────────────────────────────
command -v cmake >/dev/null 2>&1 || die "cmake not found on PATH."
CMAKE_VER="$(cmake --version | head -n1 | sed -E 's/[^0-9]*([0-9]+\.[0-9]+(\.[0-9]+)?).*/\1/')"
CMAKE_MAJOR="${CMAKE_VER%%.*}"
CMAKE_MINOR="$(printf '%s' "$CMAKE_VER" | cut -d. -f2)"
if [ "$CMAKE_MAJOR" -lt 3 ] || { [ "$CMAKE_MAJOR" -eq 3 ] && [ "$CMAKE_MINOR" -lt 16 ]; }; then
  die "CMake >= 3.16 required, found $CMAKE_VER."
fi

pick_compiler() { # $1 = env override, rest = candidates
  local override="$1"; shift
  if [ -n "$override" ]; then
    command -v "$override" >/dev/null 2>&1 && { printf '%s' "$override"; return 0; }
    return 1
  fi
  local c
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 && { printf '%s' "$c"; return 0; }
  done
  return 1
}
CC_BIN="$(pick_compiler "${CC:-}" cc gcc clang)" || die "no C compiler found (looked for \$CC, cc, gcc, clang)."
CXX_BIN="$(pick_compiler "${CXX:-}" c++ g++ clang++)" || die "no C++ compiler found (looked for \$CXX, c++, g++, clang++). LVGL 9.6 needs one."

if command -v ninja >/dev/null 2>&1; then
  GENERATOR="Ninja"
elif command -v make >/dev/null 2>&1; then
  GENERATOR="Unix Makefiles"
  echo "NOTE: ninja not found; using the 'Unix Makefiles' generator."
else
  die "neither ninja nor make found on PATH."
fi

echo "Repo root:  $REPO_ROOT"
echo "CMake:      $CMAKE_VER"
echo "Compilers:  $CC_BIN / $CXX_BIN"
echo "Generator:  $GENERATOR"

if [ "${1:-}" = "--check" ]; then
  exit 0
fi

# ── Initialize LVGL submodule if missing ─────────────────────────────
if [ ! -f "$SIM_DIR/lib/lvgl/CMakeLists.txt" ]; then
  command -v git >/dev/null 2>&1 || die "git not found (needed to fetch the LVGL submodule)."
  echo "Initializing git submodules..."
  git -C "$REPO_ROOT" submodule update --init --recursive
fi

# ── Discard a stale CMake cache ──────────────────────────────────────
# A cache created by a different checkout path (moved/copied repo) or with a
# different generator makes CMake refuse to configure.
CACHE="$BUILD_DIR/CMakeCache.txt"
if [ -f "$CACHE" ]; then
  cached_home="$(sed -n 's/^CMAKE_HOME_DIRECTORY:INTERNAL=//p' "$CACHE")"
  cached_gen="$(sed -n 's/^CMAKE_GENERATOR:INTERNAL=//p' "$CACHE")"
  # Resolve the cached source dir; an empty/missing/unreadable one resolves to
  # "" and therefore never matches, so the cache is wiped.
  real_home=""
  if [ -n "$cached_home" ] && [ -d "$cached_home" ]; then
    if ! real_home="$(cd "$cached_home" 2>/dev/null && pwd -P)"; then
      real_home=""
    fi
  fi
  if [ "$real_home" != "$(cd "$SIM_DIR" && pwd -P)" ] || [ "$cached_gen" != "$GENERATOR" ]; then
    echo "Stale CMake cache (source '$cached_home', generator '$cached_gen'); wiping $BUILD_DIR"
    rm -rf "$BUILD_DIR"
  fi
fi

# ── Reset the user code ──────────────────────────────────────────────
# The MCP server writes the last rendered code into build/user_code.c. It may
# not compile (or may crash the smoke test); configure regenerates the default
# placeholder when the file is missing. The server rewrites it on every render.
rm -f "$BUILD_DIR/user_code.c" "$BUILD_DIR/snippet.c"

configure() {
  cmake -S "$SIM_DIR" -B "$BUILD_DIR" -G "$GENERATOR" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_C_COMPILER="$CC_BIN" \
    -DCMAKE_CXX_COMPILER="$CXX_BIN"
}

# ── Configure (retry once from scratch on a cache mismatch) ──────────
echo "Configuring..."
LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT
if ! configure 2>&1 | tee "$LOG"; then
  if grep -qE "is different|does not match the generator|Does not match the platform" "$LOG"; then
    echo "CMake cache mismatch; wiping $BUILD_DIR and reconfiguring..."
    rm -rf "$BUILD_DIR"
    configure
  else
    echo "ERROR: CMake configure failed." >&2
    exit 1
  fi
fi

# ── Build ────────────────────────────────────────────────────────────
echo "Building..."
cmake --build "$BUILD_DIR" --parallel

echo ""
echo "Build complete: $BUILD_DIR/lvgl_sim"
