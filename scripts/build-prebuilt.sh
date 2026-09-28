#!/usr/bin/env bash
#
# Builds the prebuilt LVGL artifacts for this machine (Linux, macOS):
#
#   simulator/prebuilt/<platform>/
#     liblvgl.a        LVGL, Release, static, compiled with simulator/lv_conf.h
#     include/         LVGL headers in the lib/lvgl layout (lvgl.h,
#                      lv_version.h, lvgl_private.h, include/**, src/**.h)
#     lv_conf.sha256   SHA-256 of simulator/lv_conf.h (CR bytes removed)
#     lvgl_sim         the simulator built from the same tree (XML mode and a
#                      first render work without a toolchain)
#     BUILD-INFO.txt   platform, LVGL version, compiler, commit
#
# simulator/CMakeLists.txt links liblvgl.a when configured with
# -DLVGL_PREBUILT_DIR=<that dir> and falls back to compiling LVGL when
# lv_conf.h no longer matches lv_conf.sha256. Windows: scripts/build-prebuilt.ps1.
#
#   scripts/build-prebuilt.sh [--platform ID] [--out DIR] [--build-dir DIR]
#                             [--no-static] [--verify]
#
#   --platform ID    linux-x64, linux-arm64, macos-arm64 or macos-x64
#                    (default: this machine)
#   --out DIR        default: simulator/prebuilt/<platform>
#   --build-dir DIR  default: simulator/build-prebuilt/<platform> (wiped first)
#   --no-static      Linux: link lvgl_sim dynamically (default: fully static,
#                    so it runs on older glibc versions than the build host's)
#   --verify         then build the simulator against the prebuilt library,
#                    require byte-identical PNGs from both binaries, and check
#                    that a modified lv_conf.h makes CMake fall back to source
#
# Honors CC/CXX. macOS: MACOSX_DEPLOYMENT_TARGET (default 11.0).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SIM_DIR="$REPO_ROOT/simulator"
LVGL_DIR="$SIM_DIR/lib/lvgl"

die() { echo "ERROR: $*" >&2; exit 1; }
log() { echo "[build-prebuilt] $*"; }

# ── Arguments ────────────────────────────────────────────────────────
PLATFORM=""
OUT_DIR=""
BUILD_DIR=""
STATIC=1
VERIFY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --platform) [ $# -ge 2 ] || die "--platform needs a value"; PLATFORM="$2"; shift 2 ;;
    --out) [ $# -ge 2 ] || die "--out needs a value"; OUT_DIR="$2"; shift 2 ;;
    --build-dir) [ $# -ge 2 ] || die "--build-dir needs a value"; BUILD_DIR="$2"; shift 2 ;;
    --no-static) STATIC=0; shift ;;
    --verify) VERIFY=1; shift ;;
    -h|--help) sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

OS="$(uname -s)"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) ARCH_ID=x64 ;;
  arm64|aarch64) ARCH_ID=arm64 ;;
  *) ARCH_ID="$ARCH" ;;
esac
case "$OS" in
  Linux) HOST_PLATFORM="linux-$ARCH_ID" ;;
  Darwin) HOST_PLATFORM="macos-$ARCH_ID"; STATIC=0 ;; # no static libSystem on macOS
  *) die "unsupported OS '$OS' (Windows: scripts/build-prebuilt.ps1)" ;;
esac
[ -n "$PLATFORM" ] || PLATFORM="$HOST_PLATFORM"
[ "$PLATFORM" = "$HOST_PLATFORM" ] \
  || die "--platform $PLATFORM does not match this machine ($HOST_PLATFORM); cross builds are not supported"

abspath() { # absolute path of a (possibly not yet existing) path
  case "$1" in
    /*) printf '%s' "$1" ;;
    *) printf '%s/%s' "$(pwd -P)" "$1" ;;
  esac
}
OUT_DIR="$(abspath "${OUT_DIR:-$SIM_DIR/prebuilt/$PLATFORM}")"
BUILD_DIR="$(abspath "${BUILD_DIR:-$SIM_DIR/build-prebuilt/$PLATFORM}")"

command -v cmake >/dev/null 2>&1 || die "cmake not found on PATH."
[ -f "$LVGL_DIR/CMakeLists.txt" ] \
  || die "LVGL sources missing in $LVGL_DIR (run: git submodule update --init --recursive)"

if command -v ninja >/dev/null 2>&1; then
  GENERATOR="Ninja"
else
  GENERATOR="Unix Makefiles"
fi
JOBS="$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)"

sha256_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi | cut -d' ' -f1
}
# Must match _lvgl_text_sha256 in simulator/lib/lvgl_prebuilt.cmake.
text_sha256() { tr -d '\r' < "$1" | sha256_stdin; }

# ── Static link probe (Linux) ────────────────────────────────────────
EXTRA_ARGS=()
if [ "$OS" = "Darwin" ]; then
  EXTRA_ARGS+=("-DCMAKE_OSX_DEPLOYMENT_TARGET=${MACOSX_DEPLOYMENT_TARGET:-11.0}")
fi
if [ "$STATIC" -eq 1 ]; then
  probe_dir="$(mktemp -d)"
  printf 'int main(void){return 0;}\n' > "$probe_dir/p.c"
  if "${CC:-cc}" -static "$probe_dir/p.c" -o "$probe_dir/p" -lm >/dev/null 2>&1; then
    EXTRA_ARGS+=("-DCMAKE_EXE_LINKER_FLAGS=-static")
  else
    log "WARNING: static linking is not available (glibc static libraries missing?); lvgl_sim is linked dynamically."
    STATIC=0
  fi
  rm -rf "$probe_dir"
fi

log "Platform:   $PLATFORM"
log "Output:     $OUT_DIR"
log "Build dir:  $BUILD_DIR"
log "Generator:  $GENERATOR"

# ── Build LVGL + lvgl_sim from source ───────────────────────────────
rm -rf "$BUILD_DIR"
# -DLVGL_PREBUILT_DIR= : always compile LVGL here, whatever a cache says.
cmake -S "$SIM_DIR" -B "$BUILD_DIR" -G "$GENERATOR" \
  -DCMAKE_BUILD_TYPE=Release \
  -DLVGL_PREBUILT_DIR= \
  ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}
cmake --build "$BUILD_DIR" --parallel "$JOBS" --target lvgl_sim

LIB="$BUILD_DIR/lib/lvgl/liblvgl.a"
if [ ! -f "$LIB" ]; then
  LIB="$(find "$BUILD_DIR" -name liblvgl.a -type f | head -n1)"
fi
if [ -z "$LIB" ] || [ ! -f "$LIB" ]; then die "liblvgl.a not found in $BUILD_DIR"; fi
SIM_BIN="$BUILD_DIR/lvgl_sim"
[ -x "$SIM_BIN" ] || die "lvgl_sim not found in $BUILD_DIR"

# ── Assemble the output directory ────────────────────────────────────
STAGE="$OUT_DIR.tmp"
rm -rf "$STAGE"
mkdir -p "$STAGE/include"
cp "$LIB" "$STAGE/liblvgl.a"
cp "$SIM_BIN" "$STAGE/lvgl_sim"
chmod 755 "$STAGE/lvgl_sim"

# Headers with the same layout as lib/lvgl, so "lvgl.h", "src/..." and
# "lvgl/..." resolve exactly as they do against the source tree.
LIST="$BUILD_DIR/prebuilt-headers.txt"
(
  cd "$LVGL_DIR"
  for f in lvgl.h lv_version.h lvgl_private.h; do
    [ -f "$f" ] && printf '%s\n' "$f"
  done
  find src include -type f \( -name '*.h' -o -name '*.hpp' \) | LC_ALL=C sort
) > "$LIST"
COPYFILE_DISABLE=1 tar -C "$LVGL_DIR" -cf - -T "$LIST" | tar -C "$STAGE/include" -xf -

CONF_SHA="$(text_sha256 "$SIM_DIR/lv_conf.h")"
printf '%s  lv_conf.h\n' "$CONF_SHA" > "$STAGE/lv_conf.sha256"

ver_field() { sed -n "s/^#define LVGL_VERSION_$1[[:space:]]*\\([0-9]*\\).*/\\1/p" "$LVGL_DIR/include/lvgl/lv_version.h" | head -n1; }
LVGL_VERSION="$(ver_field MAJOR).$(ver_field MINOR).$(ver_field PATCH)"
CC_PATH="$(sed -n 's/^CMAKE_C_COMPILER:[A-Z]*=//p' "$BUILD_DIR/CMakeCache.txt" | head -n1)"
CC_VERSION="$("${CC_PATH:-cc}" --version 2>/dev/null | head -n1 || true)"
COMMIT="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
{
  echo "platform: $PLATFORM"
  echo "lvgl: $LVGL_VERSION"
  echo "compiler: ${CC_VERSION:-unknown}"
  echo "generator: $GENERATOR"
  echo "static lvgl_sim: $([ "$STATIC" -eq 1 ] && echo yes || echo no)"
  [ "$OS" = "Darwin" ] && echo "macos deployment target: ${MACOSX_DEPLOYMENT_TARGET:-11.0}"
  echo "commit: $COMMIT"
  echo "lv_conf.h sha256: $CONF_SHA"
  echo "built: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$STAGE/BUILD-INFO.txt"

rm -rf "$OUT_DIR"
mkdir -p "$(dirname "$OUT_DIR")"
mv "$STAGE" "$OUT_DIR"

log "LVGL $LVGL_VERSION prebuilt for $PLATFORM:"
ls -l "$OUT_DIR"
log "$(find "$OUT_DIR/include" -type f | wc -l | tr -d ' ') headers"

[ "$VERIFY" -eq 1 ] || exit 0

# ── Verify ───────────────────────────────────────────────────────────
VDIR="$BUILD_DIR-verify"
rm -rf "$VDIR"
mkdir -p "$VDIR"
log "Verify: configure + build against the prebuilt library in $VDIR/build"
cmake -S "$SIM_DIR" -B "$VDIR/build" -G "$GENERATOR" -DCMAKE_BUILD_TYPE=Release \
  -DLVGL_PREBUILT_DIR="$OUT_DIR" > "$VDIR/configure.log" 2>&1 \
  || { cat "$VDIR/configure.log"; die "configure with LVGL_PREBUILT_DIR failed"; }
grep -q "LVGL_PREBUILT: using" "$VDIR/configure.log" \
  || { cat "$VDIR/configure.log"; die "configure did not use the prebuilt library"; }
cmake --build "$VDIR/build" --parallel "$JOBS" --target lvgl_sim
if find "$VDIR/build" -name '*.o' -path '*lib/lvgl*' | grep -q .; then
  die "the verify build compiled LVGL sources although the prebuilt library was selected"
fi

render() { # $1 = binary, $2 = output prefix
  "$1" --width 320 --height 240 --time-ms 330 --output-png "$2.png" --output-json "$2.json"
}
render "$SIM_BIN" "$VDIR/source"
render "$VDIR/build/lvgl_sim" "$VDIR/prebuilt"
render "$OUT_DIR/lvgl_sim" "$VDIR/shipped"
cmp "$VDIR/source.png" "$VDIR/prebuilt.png" \
  || die "PNG from the prebuilt-linked simulator differs from the source build"
cmp "$VDIR/source.png" "$VDIR/shipped.png" \
  || die "PNG from the shipped lvgl_sim differs from the source build"
log "Verify: source build, prebuilt link and shipped lvgl_sim render identical PNGs"

log "Verify: a modified lv_conf.h must fall back to the source build"
cp "$SIM_DIR/lv_conf.h" "$VDIR/lv_conf.h"
printf '\n/* modified by build-prebuilt.sh --verify */\n' >> "$VDIR/lv_conf.h"
cmake -S "$SIM_DIR" -B "$VDIR/fallback" -G "$GENERATOR" -DCMAKE_BUILD_TYPE=Release \
  -DLVGL_PREBUILT_DIR="$OUT_DIR" -DLV_BUILD_CONF_PATH="$VDIR/lv_conf.h" > "$VDIR/fallback.log" 2>&1 \
  || { cat "$VDIR/fallback.log"; die "configure with a modified lv_conf.h failed"; }
grep -q "LVGL_PREBUILT: not using" "$VDIR/fallback.log" \
  || { cat "$VDIR/fallback.log"; die "a modified lv_conf.h did not trigger the fallback"; }
log "Verify: OK"
rm -rf "$VDIR"
