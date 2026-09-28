/**
 * Platform-specific behavior that CI can only partly exercise: macOS tool
 * lookup and hints, the Make parallelism, signal mapping and the release
 * asset map used by postinstall.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildBuildArgs, findPosixTool, DARWIN_TOOL_DIRS, type CompilerConfig } from "../../src/simulator/compiler.js";
import { installHint, runDoctor } from "../../src/doctor.js";
import { mapRunFailure } from "../../src/simulator/manager.js";
import { cleanBuildOutput, diagnosticHints, parseDiagnostics } from "../../src/simulator/diagnostics.js";
import type { RunResult } from "../../src/simulator/process.js";
import { platformId } from "../../src/simulator/prebuilt.js";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const noPath: NodeJS.ProcessEnv = { PATH: "" };

test("findPosixTool: macOS falls back to Homebrew/MacPorts/CMake.app when PATH lacks the tool", () => {
  const brewArm = (p: string) => p === "/opt/homebrew/bin/cmake";
  assert.equal(findPosixTool("cmake", noPath, "darwin", brewArm), "/opt/homebrew/bin/cmake");
  const brewIntel = (p: string) => p === "/usr/local/bin/ninja";
  assert.equal(findPosixTool("ninja", noPath, "darwin", brewIntel), "/usr/local/bin/ninja");
  const app = (p: string) => p === "/Applications/CMake.app/Contents/bin/cmake";
  assert.equal(findPosixTool("cmake", noPath, "darwin", app), "/Applications/CMake.app/Contents/bin/cmake");
  assert.equal(DARWIN_TOOL_DIRS[0], "/opt/homebrew/bin", "Apple Silicon Homebrew is searched first");
});

test("findPosixTool: bare name when nothing is found, and never probes extra dirs on Linux", () => {
  const probed: string[] = [];
  const none = (p: string) => (probed.push(p), false);
  assert.equal(findPosixTool("ninja", noPath, "darwin", none), "ninja");
  assert.ok(probed.length >= 3);
  probed.length = 0;
  assert.equal(findPosixTool("ninja", noPath, "linux", none), "ninja");
  assert.deepEqual(probed, []);
});

test("findPosixTool: a tool on PATH wins (bare name, resolved at run time)", () => {
  const env = { PATH: path.dirname(process.execPath) };
  const name = path.basename(process.execPath);
  assert.equal(findPosixTool(name, env, "darwin", () => true), name);
});

test("build args: Make gets an explicit --parallel, Ninja parallelizes itself", () => {
  const cfg: CompilerConfig = { cmakePath: "cmake", ninjaPath: "ninja", simulatorDir: "/s", buildDir: "/s/build", generator: "Ninja" };
  assert.deepEqual(buildBuildArgs(cfg, 8), ["--build", "/s/build"]);
  assert.deepEqual(buildBuildArgs({ ...cfg, generator: "Unix Makefiles" }, 8), ["--build", "/s/build", "--parallel", "8"]);
  assert.deepEqual(buildBuildArgs({ ...cfg, generator: "Unix Makefiles" }, 0), ["--build", "/s/build", "--parallel", "1"]);
  const auto = buildBuildArgs({ ...cfg, generator: "Unix Makefiles" });
  assert.ok(Number(auto[3]) >= 1);
});

test("installHint: platform-specific install commands", () => {
  assert.match(installHint("cmake", "darwin"), /brew install cmake/);
  assert.match(installHint("ninja", "darwin"), /brew install ninja/);
  assert.match(installHint("cc", "darwin"), /xcode-select --install/);
  assert.match(installHint("cmake", "linux"), /apt install cmake/);
  assert.match(installHint("ninja", "linux"), /ninja-build/);
  assert.match(installHint("cmake", "win32"), /winget/);
});

test(
  "doctor: a cc that fails with the xcrun error (macOS without Command Line Tools) is fatal",
  { skip: process.platform === "win32" ? "POSIX shell script stand-in for /usr/bin/cc" : false },
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lvgl-mcp-doctor-"));
    try {
      const cc = path.join(dir, "cc");
      await fs.writeFile(
        cc,
        '#!/bin/sh\necho "xcrun: error: invalid active developer path (/Library/Developer/CommandLineTools), missing xcrun at: /Library/Developer/CommandLineTools/usr/bin/xcrun" >&2\nexit 1\n',
        { mode: 0o755 }
      );
      const cfg: CompilerConfig = {
        cmakePath: "cmake",
        ninjaPath: "ninja",
        compilerPath: cc,
        simulatorDir: dir,
        buildDir: path.join(dir, "build"),
        generator: "Ninja",
      };
      const r = await runDoctor(cfg);
      assert.equal(r.ok, false);
      assert.ok(
        r.problems.some((p) => /does not work \(xcrun: error: invalid active developer path/.test(p) && /xcode-select --install/.test(p)),
        r.problems.join("\n")
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
);

function run(over: Partial<RunResult>): RunResult {
  return { stdout: "", stderr: "", code: null, signal: null, timedOut: false, aborted: false, truncated: false, ...over };
}

test("SIGBUS (macOS) maps to a crash like SIGSEGV", () => {
  const e = mapRunFailure(run({ signal: "SIGBUS", stderr: "[sim] phase=create_ui\n" }), 15000);
  assert.equal(e.kind, "crash");
  assert.match(e.message, /crashed with SIGBUS \(invalid memory access: NULL or deleted object\?\) while running create_ui\(\)/);
  const trap = mapRunFailure(run({ signal: "SIGTRAP" }), 15000);
  assert.equal(trap.kind, "crash");
  assert.match(trap.message, /crashed with SIGTRAP \(trap instruction/);
});

test("Apple ld (macOS): undefined symbols become errors with the referencing file and hints", () => {
  const raw = readFileSync(path.join(packageDir, "tests", "fixtures", "ninja-appleclang-link.txt"), "utf-8");
  const out = cleanBuildOutput(raw, { buildDir: "/Users/dev/sim/build", simulatorDir: "/Users/dev/sim" });
  assert.doesNotMatch(out, /-search_paths_first/);
  assert.match(out, /Undefined symbols for architecture arm64/);
  const d = parseDiagnostics(out);
  assert.deepEqual(
    d.filter((x) => x.message.startsWith("undefined symbol")),
    [
      { file: "user_code.c", line: 0, severity: "error", message: "undefined symbol 'lv_font_montserrat_13' referenced from create_ui" },
      { file: "user_code.c", line: 0, severity: "error", message: "undefined symbol 'my_helper' referenced from create_ui" },
    ]
  );
  const hints = diagnosticHints(d, false).join("\n");
  assert.match(hints, /Montserrat sizes 8\.\.48/);
  assert.match(hints, /`my_helper` is not declared\/defined/);
  const missingUi = parseDiagnostics(
    'Undefined symbols for architecture x86_64:\n  "_create_ui", referenced from:\n      _main in main.c.o\nld: symbol(s) not found for architecture x86_64'
  );
  assert.equal(missingUi.length, 1);
  assert.equal(missingUi[0]?.file, "main.c");
  assert.match(diagnosticHints(missingUi, true).join("\n"), /requires a global `void create_ui\(void\)`/);
});

test("postinstall: every supported platform maps to an asset the release workflow publishes", async () => {
  const mod = (await import(pathToFileURL(path.join(packageDir, "scripts", "postinstall.mjs")).href)) as {
    ASSETS: Record<string, string>;
    UNTESTED_PLATFORMS: Set<string>;
    PREBUILT_IDS: Record<string, string>;
  };
  assert.equal(mod.ASSETS["darwin-arm64"], "lvgl-mcp-esp32-macos-arm64.tar.gz");
  assert.equal(mod.ASSETS["darwin-x64"], "lvgl-mcp-esp32-macos-x64.tar.gz");
  assert.equal(mod.ASSETS["linux-x64"], "lvgl-mcp-esp32-linux-x64.tar.gz");
  assert.equal(mod.ASSETS["linux-arm64"], "lvgl-mcp-esp32-linux-x64.tar.gz");
  assert.equal(mod.ASSETS["win32-x64"], "lvgl-mcp-esp32-windows-x64.zip");
  assert.ok(mod.UNTESTED_PLATFORMS.has("linux-arm64"));
  assert.ok(!mod.UNTESTED_PLATFORMS.has("darwin-arm64"));
  // postinstall and the server agree on simulator/prebuilt/<id> directories
  assert.deepEqual(mod.PREBUILT_IDS, {
    "win32-x64": "windows-x64",
    "linux-x64": "linux-x64",
    "darwin-arm64": "macos-arm64",
    "darwin-x64": "macos-x64",
  });
  for (const [key, id] of Object.entries(mod.PREBUILT_IDS)) {
    const [platform, arch] = key.split("-") as [NodeJS.Platform, string];
    assert.equal(platformId(platform, arch), id, key);
  }
  assert.equal(platformId("linux", "arm64"), null);

  const release = readFileSync(path.join(packageDir, "..", ".github", "workflows", "release.yml"), "utf-8");
  const sums = /^\s*assets=\((?<list>[^)]*)\)/m.exec(release)?.groups?.["list"]?.split(/\s+/) ?? [];
  for (const asset of new Set(Object.values(mod.ASSETS))) {
    assert.ok(release.split("\n").some((l) => l.trim() === `asset: ${asset}`), `release.yml builds ${asset}`);
    assert.ok(sums.includes(asset), `${asset} is in SHA256SUMS.txt`);
    const uses = release.split(`dist-assets/${asset}`).length - 1;
    assert.ok(uses >= 2, `${asset} is attested and attached to the release`);
  }
});
