import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSimArgs,
  mapRunFailure,
  parseSimJson,
  simulatorEnv,
  splitStderr,
  SimulatorManager,
} from "../../src/simulator/manager.js";
import type { RunResult } from "../../src/simulator/process.js";
import type { ResolvedRenderParams } from "../../src/simulator/types.js";

const params: ResolvedRenderParams = {
  full: false,
  mode: "snippet",
  annotate: false,
  espShims: false,
  width: 320,
  height: 240,
  timeMs: 500,
  settle: true,
  rotation: 90,
  theme: "dark",
  dpi: 160,
  assetsDir: "/assets",
};

function run(partial: Partial<RunResult>): RunResult {
  return {
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    truncated: false,
    ...partial,
  };
}

test("buildSimArgs follows the contract CLI", () => {
  const args = buildSimArgs(params, "/tmp/x/s.png", "/tmp/x/t.json");
  const get = (flag: string) => args[args.indexOf(flag) + 1];
  assert.equal(get("--width"), "320");
  assert.equal(get("--height"), "240");
  assert.equal(get("--output-png"), "/tmp/x/s.png");
  assert.equal(get("--output-json"), "/tmp/x/t.json");
  assert.equal(get("--time-ms"), "500");
  assert.equal(get("--rotation"), "90");
  assert.equal(get("--theme"), "dark");
  assert.equal(get("--dpi"), "160");
  assert.equal(get("--assets-dir"), "/assets");
  assert.ok(args.includes("--settle"));
  assert.ok(!args.includes("--ticks"));
  assert.ok(!buildSimArgs({ ...params, settle: false }, "a", "b").includes("--settle"));
});

test("simulatorEnv is an allow-list", () => {
  const src = { PATH: "/bin", HOME: "/h", SECRET_TOKEN: "x", TEMP: "/t", AWS_KEY: "k", Path: "ignored" };
  const env = simulatorEnv(src, false);
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "LANG", "PATH", "TEMP"]);
  assert.equal(env["LANG"], "C");
  const win = simulatorEnv({ Path: "C:\\bin", SystemRoot: "C:\\Windows", windir: "C:\\Windows", ComSpec: "cmd", USERPROFILE: "u", LOCALAPPDATA: "l", GITHUB_TOKEN: "t" }, true);
  assert.equal(win["PATH"], "C:\\bin");
  assert.equal(win["GITHUB_TOKEN"], undefined);
  assert.equal(win["ComSpec"], "cmd");
  assert.equal(win["LOCALAPPDATA"], "l");
});

test("splitStderr separates phase markers from LVGL logs", () => {
  const s = splitStderr("[sim] phase=create_ui\n[Warn]\t(0.001, +1)\t lv_fs_open: bad\n[sim] phase=advance\nother\n");
  assert.equal(s.phase, "advance");
  assert.deepEqual(s.logs, ["[Warn]\t(0.001, +1)\t lv_fs_open: bad"]);
  assert.deepEqual(s.other, ["other"]);
});

test("timeout maps to 'timed out after N s (infinite loop?)'", () => {
  const e = mapRunFailure(run({ timedOut: true, code: null, signal: "SIGKILL", stderr: "[sim] phase=create_ui\n" }), 15000);
  assert.equal(e.kind, "timeout");
  assert.match(e.message, /^Simulator timed out after 15 s \(infinite loop\?\) while running create_ui\(\)/);
});

test("exit 3 maps to LVGL assertion with the last stderr lines", () => {
  const e = mapRunFailure(
    run({ code: 3, stderr: "[sim] phase=create_ui\n[Error]\t(0.000, +0)\t lv_obj_set_width: Asserted at expression: obj != NULL (NULL pointer)\n" }),
    15000
  );
  assert.equal(e.kind, "assertion");
  assert.match(e.message, /^LVGL assertion failed/);
  assert.match(e.message, /obj != NULL/);
});

test("signals and Windows NTSTATUS codes map to crashes with the phase", () => {
  const segv = mapRunFailure(run({ code: null, signal: "SIGSEGV", stderr: "[sim] phase=advance\n" }), 15000);
  assert.equal(segv.kind, "crash");
  assert.match(segv.message, /crashed with SIGSEGV \(NULL or deleted object\?\) while advancing simulated time/);
  const abrt = mapRunFailure(run({ code: null, signal: "SIGABRT" }), 15000);
  assert.match(abrt.message, /crashed with SIGABRT/);
  for (const code of [0xc0000005, -1073741819]) {
    const av = mapRunFailure(run({ code, stderr: "[sim] phase=create_ui" }), 15000);
    assert.equal(av.kind, "crash");
    assert.match(av.message, /ACCESS_VIOLATION \(0xC0000005\).*create_ui/);
  }
});

test("exit 2 / exit 1 / other codes", () => {
  assert.equal(mapRunFailure(run({ code: 2 }), 1000).kind, "output");
  assert.equal(mapRunFailure(run({ code: 1, stderr: "Unknown argument: --foo" }), 1000).kind, "args");
  const other = mapRunFailure(run({ code: 42, stdout: "hello from printf\n" }), 1000);
  assert.equal(other.kind, "runtime");
  assert.match(other.message, /exited with code 42/);
  assert.match(other.message, /printf output:\nhello from printf/);
});

test("runtime errors are followed by the LVGL log tail", () => {
  const stderr = Array.from({ length: 30 }, (_, i) => `[Warn]\t(0.0, +0)\t line ${i}`).join("\n");
  const e = mapRunFailure(run({ code: null, signal: "SIGSEGV", stderr }), 1000);
  assert.match(e.message, /LVGL log \/ stderr \(last 20 of 30\):/);
  assert.match(e.message, /line 29$/m);
  assert.doesNotMatch(e.message, /line 9$/m);
});

test("parseSimJson: format_version 2 and legacy v1", () => {
  const v2 = parseSimJson(
    JSON.stringify({
      format_version: 2,
      lvgl_version: "9.6.0",
      display: { width: 800, height: 480, rotation: 0, dpi: 130, color_format: "XRGB8888", theme: "light" },
      elapsed_ms: 330,
      anims_running: 1,
      logs: ["[Warn] x"],
      screen: { type: "lv_obj", x: 0, y: 0, w: 800, h: 480 },
    }),
    { width: 1, height: 1 }
  );
  assert.equal(v2.lvgl_version, "9.6.0");
  assert.equal(v2.anims_running, 1);
  assert.deepEqual(v2.logs, ["[Warn] x"]);
  const v1 = parseSimJson(JSON.stringify({ type: "lv_obj", x: 0, y: 0, w: 320, h: 240 }), { width: 320, height: 240 });
  assert.equal(v1.format_version, 1);
  assert.equal(v1.screen.w, 320);
  assert.equal(v1.lvgl_version, "unknown");
  assert.throws(() => parseSimJson("{}", { width: 1, height: 1 }));
});

test("per-call width/height never change the defaults", () => {
  const m = new SimulatorManager({
    simulatorDir: "/nonexistent",
    compilerConfig: { cmakePath: "cmake", ninjaPath: "ninja", simulatorDir: "/nonexistent", buildDir: "/nonexistent/build", generator: "Ninja" },
    doctor: async () => ({ ok: true, problems: [], notes: [] }),
  });
  const p = m.resolveParams({ code: "", full: false, width: 320, height: 240 });
  assert.equal(p.width, 320);
  assert.deepEqual(m.getDefaults(), { width: 800, height: 480 });
  const q = m.resolveParams({ code: "", full: false });
  assert.deepEqual([q.width, q.height, q.timeMs, q.settle, q.rotation, q.theme, q.dpi], [800, 480, 330, false, 0, "light", 130]);
  m.setDefaults(480, 320);
  assert.equal(m.resolveParams({ code: "", full: false }).width, 480);
  assert.equal(m.getConfig().lvgl_version, "unknown until first render");
  assert.equal(m.getConfig().default_width, 480);
});

test("timeouts come from env with sane defaults", () => {
  const cfg = { cmakePath: "cmake", ninjaPath: "ninja", simulatorDir: "/x", buildDir: "/x/b", generator: "Ninja" };
  const d = new SimulatorManager({ simulatorDir: "/x", compilerConfig: cfg, env: {} });
  assert.equal(d.compileTimeoutMs, 180000);
  assert.equal(d.runTimeoutMs, 15000);
  const e = new SimulatorManager({
    simulatorDir: "/x",
    compilerConfig: cfg,
    env: { LVGL_COMPILE_TIMEOUT_MS: "5000", LVGL_RUN_TIMEOUT_MS: "garbage" },
  });
  assert.equal(e.compileTimeoutMs, 5000);
  assert.equal(e.runTimeoutMs, 15000);
});

test("doctor failure is reported as an actionable setup error", async () => {
  const m = new SimulatorManager({
    simulatorDir: "/x",
    compilerConfig: { cmakePath: "cmake", ninjaPath: "ninja", simulatorDir: "/x", buildDir: "/x/b", generator: "Ninja" },
    doctor: async () => ({ ok: false, problems: ["CMake not found (cmake). Install CMake"], notes: [] }),
  });
  await assert.rejects(m.render({ code: "x", full: false, assetsDir: process.cwd() }), (err: Error & { kind?: string }) => {
    assert.equal(err.kind, "setup");
    assert.match(err.message, /cannot build on this machine[\s\S]*CMake not found/);
    return true;
  });
});
