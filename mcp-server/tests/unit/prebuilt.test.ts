/**
 * Prebuilt LVGL artifacts: detection, configure args, and the one-time
 * fallback to a source build when the prebuilt library does not link.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildConfigureArgs, SimulatorCompiler, type CompilerConfig } from "../../src/simulator/compiler.js";
import { detectPrebuilt, isPrebuiltFailure, platformId, usePrebuiltLibrary } from "../../src/simulator/prebuilt.js";
import { prebuiltNotes } from "../../src/doctor.js";

test("platformId maps node platform/arch to the release platform ids", () => {
  assert.equal(platformId("linux", "x64"), "linux-x64");
  assert.equal(platformId("win32", "x64"), "windows-x64");
  assert.equal(platformId("darwin", "arm64"), "macos-arm64");
  assert.equal(platformId("darwin", "x64"), "macos-x64");
  assert.equal(platformId("linux", "arm64"), null);
  assert.equal(platformId("freebsd", "x64"), null);
});

test("detectPrebuilt finds liblvgl.a / lvgl.lib and lvgl_sim(.exe)", () => {
  const files = new Set([
    path.join("/sim", "prebuilt", "linux-x64"),
    path.join("/sim", "prebuilt", "linux-x64", "liblvgl.a"),
    path.join("/sim", "prebuilt", "linux-x64", "lvgl_sim"),
    path.join("/sim", "prebuilt", "windows-x64"),
    path.join("/sim", "prebuilt", "windows-x64", "lvgl.lib"),
    path.join("/sim", "prebuilt", "windows-x64", "lvgl_sim.exe"),
    path.join("/sim", "prebuilt", "macos-arm64"),
    path.join("/sim", "prebuilt", "macos-arm64", "lvgl_sim"),
  ]);
  const exists = (p: string) => files.has(p);
  const linux = detectPrebuilt("/sim", "linux", "x64", exists);
  assert.equal(linux.dir, path.join("/sim", "prebuilt", "linux-x64"));
  assert.equal(linux.library, path.join("/sim", "prebuilt", "linux-x64", "liblvgl.a"));
  assert.equal(linux.simulator, path.join("/sim", "prebuilt", "linux-x64", "lvgl_sim"));
  const win = detectPrebuilt("/sim", "win32", "x64", exists);
  assert.equal(win.library, path.join("/sim", "prebuilt", "windows-x64", "lvgl.lib"));
  assert.equal(win.simulator, path.join("/sim", "prebuilt", "windows-x64", "lvgl_sim.exe"));
  const mac = detectPrebuilt("/sim", "darwin", "arm64", exists);
  assert.equal(mac.library, null, "simulator binary without library");
  assert.ok(mac.simulator);
  assert.deepEqual(detectPrebuilt("/sim", "darwin", "x64", exists), { platform: "macos-x64", dir: null, library: null, simulator: null });
  assert.equal(detectPrebuilt("/sim", "linux", "arm64", exists).platform, null);
});

test("usePrebuiltLibrary: present, not disabled, not turned off by LVGL_NO_PREBUILT", () => {
  const info = { platform: "linux-x64" as const, dir: "/p", library: "/p/liblvgl.a", simulator: null };
  assert.equal(usePrebuiltLibrary(info, false, {}), true);
  assert.equal(usePrebuiltLibrary(info, true, {}), false);
  assert.equal(usePrebuiltLibrary(info, false, { LVGL_NO_PREBUILT: "1" }), false);
  assert.equal(usePrebuiltLibrary(info, false, { LVGL_NO_PREBUILT: "0" }), true);
  assert.equal(usePrebuiltLibrary({ ...info, library: null }, false, {}), false);
});

test("isPrebuiltFailure: toolchain mismatches yes, user mistakes no", () => {
  const dir = "/sim/prebuilt/linux-x64";
  const yes = [
    "/usr/bin/ld: /sim/prebuilt/linux-x64/liblvgl.a: error adding symbols: file format not recognized",
    "lvgl.lib(lv_obj.obj) : error LNK2038: mismatch detected for 'RuntimeLibrary': value 'MT_StaticRelease' doesn't match value 'MD_DynamicRelease'",
    "LINK : fatal error LNK1104: cannot open file 'C:\\sim\\prebuilt\\windows-x64\\lvgl.lib'",
    "ld: warning: ignoring file /sim/prebuilt/macos-arm64/liblvgl.a, building for macOS-x86_64 but attempting to link with file built for macOS-arm64",
    "/usr/bin/ld: lv_obj.c.o: relocation R_X86_64_32 against `.rodata' can not be used when making a PIE object; recompile with -fPIE",
    "lto1: fatal error: bytecode stream generated with LTO version 13.0 instead of the expected 14.0\ncollect2: error: ld returned 1 exit status\nlto-wrapper failed",
    "undefined reference to `__isoc23_strtol'",
  ];
  for (const y of yes) assert.equal(isPrebuiltFailure(y, dir), true, y);
  const no = [
    "user_code.c:(.text+0x12): undefined reference to `lv_font_montserrat_13'\ncollect2: error: ld returned 1 exit status",
    "snippet.c:2:1: error: implicit declaration of function 'nope'",
    "user_code.c.obj : error LNK2019: unresolved external symbol my_helper referenced in function create_ui",
    "",
    "all good, [3/3] Linking C executable lvgl_sim (-L/sim/prebuilt/linux-x64)",
    // A compile error in user code: the command line names the prebuilt include dir and -Werror=...
    "[1/16] Building C object CMakeFiles/lvgl_sim_user.dir/user_code.c.o\nFAILED: CMakeFiles/lvgl_sim_user.dir/user_code.c.o \n" +
      "/usr/bin/cc -DLVGL_SIMULATOR=1 -isystem /sim/prebuilt/linux-x64/include -isystem /sim/prebuilt/linux-x64/include/include -O3 -Werror=implicit-function-declaration -o CMakeFiles/lvgl_sim_user.dir/user_code.c.o -c /b/user_code.c\n" +
      "/b/user_code.c:2:23: error: implicit declaration of function 'this_function_does_not_exist' [-Werror=implicit-function-declaration]\nninja: build stopped: subcommand failed.",
  ];
  for (const n of no) assert.equal(isPrebuiltFailure(n, dir), false, n);
});

test("buildConfigureArgs: prebuilt dir set or removed, user sources/include dirs/defines as CMake lists", () => {
  const cfg: CompilerConfig = { cmakePath: "cmake", ninjaPath: "ninja", simulatorDir: "/sim", buildDir: "/sim/build", generator: "Ninja" };
  const withPb = buildConfigureArgs(cfg, {
    prebuiltDir: "C:\\sim\\prebuilt\\windows-x64",
    userSources: ["/p/ui.c", "C:\\p\\screens\\home.c"],
    includeDirs: ["/p", "/p/inc"],
    defines: ["A", "B=2"],
    espShims: true,
  });
  assert.ok(withPb.includes("-DLVGL_PREBUILT_DIR=C:/sim/prebuilt/windows-x64"));
  assert.ok(withPb.includes("-DUSER_EXTRA_SOURCES=/p/ui.c;C:/p/screens/home.c"));
  assert.ok(withPb.includes("-DUSER_INCLUDE_DIRS=/p;/p/inc"));
  assert.ok(withPb.includes("-DUSER_COMPILE_DEFINITIONS=A;B=2"));
  assert.ok(withPb.includes("-DLVGL_SIM_ESP_SHIMS=ON"));
  const without = buildConfigureArgs(cfg, {});
  assert.ok(without.includes("-ULVGL_PREBUILT_DIR"));
  assert.ok(without.includes("-DUSER_EXTRA_SOURCES="), "empty lists clear an earlier project");
  assert.ok(without.includes("-DUSER_INCLUDE_DIRS="));
  assert.ok(without.includes("-DUSER_COMPILE_DEFINITIONS="));
  assert.ok(without.includes("-DLVGL_SIM_ESP_SHIMS=OFF"));
  assert.ok(!buildConfigureArgs(cfg).some((a) => a.includes("USER_EXTRA_SOURCES")), "no options: 2.1.0 arguments");
});

test("doctor notes say whether JSON UI rendering works without a toolchain", () => {
  const yes = prebuiltNotes({ platform: "linux-x64", dir: "/p", library: "/p/liblvgl.a", simulator: "/p/lvgl_sim" });
  assert.ok(yes.some((n) => /^Prebuilt LVGL library: \/p\/liblvgl\.a/.test(n)));
  assert.ok(yes.some((n) => /available without a toolchain: yes/.test(n)));
  const no = prebuiltNotes({ platform: "linux-x64", dir: null, library: null, simulator: null });
  assert.ok(no.some((n) => /available without a toolchain: no \(no prebuilt lvgl_sim for linux-x64/.test(n)));
});

/**
 * A stand-in for cmake (POSIX shell): configure records its arguments and
 * whether LVGL_PREBUILT_DIR was set; the build fails like a prebuilt-library
 * link failure while the prebuilt library is configured (or always, with
 * ALWAYS_FAIL set), else it produces lvgl_sim.
 */
const FAKE_CMAKE = `#!/bin/sh
LOG="$FAKE_CMAKE_LOG"
if [ "$1" = "--build" ]; then
  BUILD="$2"
  echo "build" >> "$LOG"
  if [ -n "$ALWAYS_FAIL" ]; then
    echo "user_code.c:(.text+0x12): undefined reference to \\\`lv_font_montserrat_13'" >&2
    echo "collect2: error: ld returned 1 exit status" >&2
    exit 1
  fi
  if [ "$(cat "$BUILD/pb" 2>/dev/null)" = "1" ]; then
    echo "/usr/bin/ld: $PB_DIR/liblvgl.a: error adding symbols: file format not recognized" >&2
    echo "collect2: error: ld returned 1 exit status" >&2
    exit 1
  fi
  printf '#!/bin/sh\\nexit 0\\n' > "$BUILD/lvgl_sim"; chmod +x "$BUILD/lvgl_sim"
  exit 0
fi
BUILD=""
PB=0
while [ $# -gt 0 ]; do
  case "$1" in
    -B) BUILD="$2"; shift ;;
    -DLVGL_PREBUILT_DIR=*) PB=1 ;;
  esac
  shift
done
echo "configure pb=$PB" >> "$LOG"
mkdir -p "$BUILD"; echo "$PB" > "$BUILD/pb"; echo "CMAKE_HOME_DIRECTORY:INTERNAL=$SIM_DIR" > "$BUILD/CMakeCache.txt"
exit 0
`;

async function fakeToolchain() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lvgl-pb-"));
  const sim = path.join(dir, "sim");
  const pbDir = path.join(sim, "prebuilt", "linux-x64");
  await fs.mkdir(pbDir, { recursive: true });
  await fs.writeFile(path.join(pbDir, "liblvgl.a"), "!<arch>\n");
  const cmake = path.join(dir, "cmake");
  await fs.writeFile(cmake, FAKE_CMAKE, { mode: 0o755 });
  const log = path.join(dir, "log.txt");
  const cfg: CompilerConfig = { cmakePath: cmake, ninjaPath: "ninja", simulatorDir: sim, buildDir: path.join(dir, "build"), generator: "Ninja" };
  const prebuilt = { platform: "linux-x64" as const, dir: pbDir, library: path.join(pbDir, "liblvgl.a"), simulator: null };
  const warnings: string[] = [];
  const compiler = new SimulatorCompiler(cfg, { timeoutMs: 20000, prebuilt, env: {}, log: (m) => warnings.push(m) });
  return { dir, log, pbDir, sim, compiler, warnings };
}

test(
  "compiler: a prebuilt link failure reconfigures without it once and remembers that",
  { skip: process.platform === "win32" ? "POSIX shell stand-in for cmake" : false },
  async () => {
    const t = await fakeToolchain();
    const saved = { ...process.env };
    process.env["FAKE_CMAKE_LOG"] = t.log;
    process.env["PB_DIR"] = t.pbDir;
    process.env["SIM_DIR"] = t.sim;
    try {
      assert.equal(t.compiler.usingPrebuiltLibrary, true);
      const r = await t.compiler.compile('#include "lvgl.h"\nvoid create_ui(void) {}\n', true);
      assert.equal(r.success, true, r.output);
      assert.equal(t.compiler.prebuiltDisabled, true);
      assert.equal(t.compiler.usingPrebuiltLibrary, false);
      assert.match(r.notes?.join("\n") ?? "", /prebuilt LVGL library did not link/);
      assert.ok(t.warnings.some((w) => /Linking failed with the prebuilt LVGL library/.test(w)), t.warnings.join("\n"));
      const log1 = (await fs.readFile(t.log, "utf-8")).trim().split("\n");
      assert.deepEqual(log1, ["configure pb=1", "build", "configure pb=0", "build"]);
      // Remembered: the next compile neither uses nor retries the prebuilt library.
      const r2 = await t.compiler.compile('#include "lvgl.h"\nvoid create_ui(void) { /* 2 */ }\n', true);
      assert.equal(r2.success, true);
      assert.deepEqual(r2.notes, []);
      const log2 = (await fs.readFile(t.log, "utf-8")).trim().split("\n");
      assert.deepEqual(log2.slice(4), ["build"]);
    } finally {
      process.env = saved;
      await fs.rm(t.dir, { recursive: true, force: true });
    }
  }
);

test(
  "compiler: user link errors do not trigger the prebuilt fallback",
  { skip: process.platform === "win32" ? "POSIX shell stand-in for cmake" : false },
  async () => {
    const t = await fakeToolchain();
    const saved = { ...process.env };
    process.env["FAKE_CMAKE_LOG"] = t.log;
    process.env["PB_DIR"] = t.pbDir;
    process.env["SIM_DIR"] = t.sim;
    process.env["ALWAYS_FAIL"] = "1";
    try {
      const r = await t.compiler.compile('#include "lvgl.h"\nvoid create_ui(void) { }\n', true);
      assert.equal(r.success, false);
      assert.equal(t.compiler.prebuiltDisabled, false);
      assert.ok(r.diagnostics.some((d) => /lv_font_montserrat_13/.test(d.message)));
      const log = (await fs.readFile(t.log, "utf-8")).trim().split("\n");
      assert.deepEqual(log, ["configure pb=1", "build"]);
    } finally {
      process.env = saved;
      await fs.rm(t.dir, { recursive: true, force: true });
    }
  }
);

test(
  "compiler: changing project sources/defines reconfigures; identical ones do not",
  { skip: process.platform === "win32" ? "POSIX shell stand-in for cmake" : false },
  async () => {
    const t = await fakeToolchain();
    const saved = { ...process.env };
    process.env["FAKE_CMAKE_LOG"] = t.log;
    process.env["PB_DIR"] = t.pbDir;
    process.env["SIM_DIR"] = t.sim;
    process.env["LVGL_NO_PREBUILT"] = "1";
    try {
      const c = new SimulatorCompiler(t.compiler.config, { timeoutMs: 20000, prebuilt: t.compiler.prebuilt, env: { LVGL_NO_PREBUILT: "1" }, log: () => {} });
      const unit = { source: "void create_ui(void){}", snippet: null, fullFile: true, sources: ["/p/a.c"], defines: ["X=1"], cacheable: false };
      assert.equal((await c.compileUnit(unit)).success, true);
      assert.equal((await c.compileUnit(unit)).success, true);
      assert.equal((await c.compileUnit({ ...unit, defines: ["X=2"] })).success, true);
      const log = (await fs.readFile(t.log, "utf-8")).trim().split("\n");
      assert.deepEqual(log, ["configure pb=0", "build", "build", "configure pb=0", "build"]);
    } finally {
      process.env = saved;
      await fs.rm(t.dir, { recursive: true, force: true });
    }
  }
);
