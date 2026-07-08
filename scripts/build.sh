#!/usr/bin/env bash
#
# LVGL Simulator build script (POSIX: Linux / macOS).
# Bash equivalent of scripts/build.bat. Uses the system C compiler (cc/gcc),
# CMake, and Ninja if available (otherwise Unix Makefiles).
#
set -euo pipefail

# ── Resolve repo root from this script's location ────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SIM_DIR="$REPO_ROOT/simulator"
BUILD_DIR="$SIM_DIR/build"

INSTALL_HINT="Install build prerequisites, e.g.:
  sudo apt install build-essential cmake ninja-build"

# ── Check tools ──────────────────────────────────────────────────────
if ! command -v cmake >/dev/null 2>&1; then
  echo "ERROR: cmake not found on PATH." >&2
  echo "$INSTALL_HINT" >&2
  exit 1
fi

# Prefer $CC, else cc, else gcc.
CC_BIN="${CC:-}"
if [ -z "$CC_BIN" ]; then
  if command -v cc >/dev/null 2>&1; then
    CC_BIN="cc"
  elif command -v gcc >/dev/null 2>&1; then
    CC_BIN="gcc"
  fi
fi
if [ -z "$CC_BIN" ] || ! command -v "$CC_BIN" >/dev/null 2>&1; then
  echo "ERROR: no C compiler found (looked for \$CC, cc, gcc)." >&2
  echo "$INSTALL_HINT" >&2
  exit 1
fi

# Generator: Ninja if available, else Unix Makefiles (needs make).
if command -v ninja >/dev/null 2>&1; then
  GENERATOR="Ninja"
else
  if ! command -v make >/dev/null 2>&1; then
    echo "ERROR: neither ninja nor make found on PATH." >&2
    echo "$INSTALL_HINT" >&2
    exit 1
  fi
  GENERATOR="Unix Makefiles"
  echo "NOTE: ninja not found; using the 'Unix Makefiles' generator."
fi

echo "Repo root:  $REPO_ROOT"
echo "Compiler:   $CC_BIN"
echo "Generator:  $GENERATOR"

# ── Initialize LVGL submodule if missing ─────────────────────────────
if [ ! -f "$SIM_DIR/lib/lvgl/CMakeLists.txt" ]; then
  echo "Initializing git submodules..."
  git -C "$REPO_ROOT" submodule update --init --recursive
fi

# ── Ensure user_code.c exists ────────────────────────────────────────
# CMakeLists writes build/user_code.c into the target. If it's not present
# yet, seed it from the wrapper template with a trivial demo snippet so a
# fresh checkout builds a runnable binary out of the box.
mkdir -p "$BUILD_DIR"
USER_CODE="$BUILD_DIR/user_code.c"
TEMPLATE="$SIM_DIR/templates/user_code_wrapper.c"
if [ ! -f "$USER_CODE" ] && [ -f "$TEMPLATE" ]; then
  echo "Seeding $USER_CODE from template..."
  SNIPPET_FILE="$(mktemp)"
  trap 'rm -f "$SNIPPET_FILE"' EXIT
  cat > "$SNIPPET_FILE" <<'EOF'
    lv_obj_t *label = lv_label_create(screen);
    lv_label_set_text(label, "LVGL Simulator Ready");
    lv_obj_center(label);
EOF
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      *%USER_CODE%*) cat "$SNIPPET_FILE" ;;
      *) printf '%s\n' "$line" ;;
    esac
  done < "$TEMPLATE" > "$USER_CODE"
fi

# ── Configure ────────────────────────────────────────────────────────
echo "Configuring..."
if [ "$GENERATOR" = "Ninja" ]; then
  cmake -S "$SIM_DIR" -B "$BUILD_DIR" -G Ninja \
    -DCMAKE_C_COMPILER="$CC_BIN"
else
  cmake -S "$SIM_DIR" -B "$BUILD_DIR" -G "Unix Makefiles" \
    -DCMAKE_C_COMPILER="$CC_BIN"
fi

# ── Build ────────────────────────────────────────────────────────────
echo "Building..."
cmake --build "$BUILD_DIR"

echo ""
echo "Build complete: $BUILD_DIR/lvgl_sim"
