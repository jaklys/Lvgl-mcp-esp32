/**
 * 2.2.0 parameter -> simulator CLI mapping, board presets, exit codes 5/6,
 * JSON format_version 3 parsing and capture collection.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildSimArgs,
  chooseUiBinary,
  collectCaptures,
  mapRunFailure,
  needsOutputDir,
  normalizeFontName,
  parseSimJson,
  SimulatorManager,
} from "../../src/simulator/manager.js";
import type { RunResult } from "../../src/simulator/process.js";
import type { ResolvedRenderParams } from "../../src/simulator/types.js";
import { solidPng } from "../helpers/fake-backend.js";

const base: ResolvedRenderParams = {
  full: false,
  mode: "snippet",
  width: 320,
  height: 240,
  timeMs: 330,
  settle: false,
  rotation: 0,
  theme: "light",
  dpi: 130,
  assetsDir: "/assets",
  annotate: false,
  espShims: false,
};

function run(partial: Partial<RunResult>): RunResult {
  return { stdout: "", stderr: "", code: 0, signal: null, timedOut: false, aborted: false, truncated: false, ...partial };
}

function manager(env: NodeJS.ProcessEnv = {}): SimulatorManager {
  return new SimulatorManager({
    simulatorDir: "/nonexistent",
    compilerConfig: { cmakePath: "cmake", ninjaPath: "ninja", simulatorDir: "/nonexistent", buildDir: "/nonexistent/build", generator: "Ninja" },
    doctor: async () => ({ ok: true, problems: [], notes: [] }),
    prebuilt: { platform: "linux-x64", dir: null, library: null, simulator: null },
    env,
  });
}

test("buildSimArgs: plain renders pass no 2.2.0 flags (works with a 2.1.0 binary)", () => {
  const args = buildSimArgs(base, "/t/s.png", "/t/t.json");
  for (const f of ["--output-dir", "--actions", "--frames", "--annotate", "--scale", "--color-format", "--fonts", "--mem-budget-kb", "--ui"]) {
    assert.ok(!args.includes(f), f);
  }
});

test("buildSimArgs: every 2.2.0 flag", () => {
  const p: ResolvedRenderParams = {
    ...base,
    mode: "ui",
    annotate: true,
    frames: [0, 100, 300],
    scale: 2,
    colorFormat: "rgb565",
    fonts: ["montserrat_14", "montserrat_20"],
    memBudgetKb: 48,
  };
  const args = buildSimArgs(p, "/t/s.png", "/t/t.json", { outputDir: "/t", actionsPath: "/t/actions.json", uiPath: "/t/ui.json" });
  const get = (flag: string) => args[args.indexOf(flag) + 1];
  assert.equal(get("--output-dir"), "/t");
  assert.equal(get("--actions"), "/t/actions.json");
  assert.equal(get("--frames"), "0,100,300");
  assert.ok(args.includes("--annotate"));
  assert.equal(get("--scale"), "2");
  assert.equal(get("--color-format"), "rgb565");
  assert.equal(get("--fonts"), "montserrat_14,montserrat_20");
  assert.equal(get("--mem-budget-kb"), "48");
  assert.equal(get("--ui"), "/t/ui.json");
  assert.equal(get("--output-png"), "/t/s.png", "--output-png still names the final capture");
  assert.ok(!buildSimArgs({ ...p, scale: 1 }, "a", "b").includes("--scale"), "scale 1 is the default");
});

test("needsOutputDir: annotate, frames or actions", () => {
  assert.equal(needsOutputDir(base), false);
  assert.equal(needsOutputDir({ ...base, annotate: true }), true);
  assert.equal(needsOutputDir({ ...base, frames: [0] }), true);
  assert.equal(needsOutputDir({ ...base, actions: [{ wait: 1 }] }), true);
});

test("normalizeFontName accepts lv_font_ prefixes", () => {
  assert.equal(normalizeFontName("lv_font_montserrat_14"), "montserrat_14");
  assert.equal(normalizeFontName("&lv_font_unscii_8"), "unscii_8");
  assert.equal(normalizeFontName("montserrat_20"), "montserrat_20");
});

test("resolveParams: board defaults, explicit params override, session defaults below the board", () => {
  const m = manager();
  m.setDefaults(480, 320);
  const b = m.resolveParams({ code: "", full: false, board: "esp32-2432s028r" });
  assert.deepEqual([b.width, b.height, b.colorFormat, b.dpi, b.rotation, b.memBudgetKb], [320, 240, "rgb565", 143, 0, 48]);
  const o = m.resolveParams({
    code: "",
    full: false,
    board: "esp32-2432s028r",
    width: 240,
    height: 320,
    colorFormat: "xrgb8888",
    dpi: 100,
    rotation: 90,
    memBudgetKb: 64,
  });
  assert.deepEqual([o.width, o.height, o.colorFormat, o.dpi, o.rotation, o.memBudgetKb], [240, 320, "xrgb8888", 100, 90, 64]);
  const none = m.resolveParams({ code: "", full: false });
  assert.deepEqual([none.width, none.height, none.colorFormat, none.memBudgetKb, none.dpi], [480, 320, undefined, undefined, 130]);
  assert.throws(() => m.resolveParams({ code: "", full: false, board: "nope" }), /Unknown board "nope"/);
  assert.deepEqual(m.resolveParams({ code: "", full: false, fonts: ["lv_font_montserrat_14", "montserrat_14"] }).fonts, ["montserrat_14"]);
});

test("resolveParams: modes, esp_shims default per mode, frames+actions rejected", () => {
  const m = manager();
  assert.equal(m.resolveParams({ code: "", full: true }).mode, "full");
  assert.equal(m.resolveParams({ code: "", full: false }).mode, "snippet");
  const proj = m.resolveParams({ code: "", full: false, mode: "project", project: { root: "/some/root", entry: "ui_init" } });
  assert.equal(proj.espShims, true);
  assert.equal(proj.assetsDir, path.resolve("/some/root"), "project root is the default assets dir");
  assert.equal(m.resolveParams({ code: "", full: false, mode: "project", espShims: false, project: { entry: "x" } }).espShims, false);
  assert.equal(m.resolveParams({ code: "", full: false }).espShims, false);
  assert.throws(() => m.resolveParams({ code: "", full: false, frames: [0], actions: [{ wait: 1 }] }), /either frames or actions/);
});

test("exit 5: JSON UI errors list every ui: line verbatim", () => {
  const e = mapRunFailure(
    run({
      code: 5,
      stderr:
        '[sim] phase=ui\nui: children[0].styles.radius: expected integer\nui: children[2].type: unknown widget "lv_meter" (known: lv_obj, lv_label)\n',
    }),
    15000
  );
  assert.equal(e.kind, "ui");
  assert.match(e.message, /^The JSON UI document was rejected \(2 problems\):\nui: children\[0\]\.styles\.radius: expected integer\nui: children\[2\]\.type: unknown widget "lv_meter" \(known: lv_obj, lv_label\)\n/);
  assert.match(e.message, /lvgl_docs topic "ui-json"/);
});

test("exit 6: action errors carry the message and the known names", () => {
  const e = mapRunFailure(
    run({ code: 6, stderr: "[sim] phase=actions\n[sim] action 2: object \"okk_btn\" not found\nknown names: ok_btn, title, wifi_sw\n" }),
    15000
  );
  assert.equal(e.kind, "action");
  assert.match(e.message, /^Action script error while running the action script:/);
  assert.match(e.message, /known names: ok_btn, title, wifi_sw/);
  assert.match(e.message, /lv_obj_set_name/);
});

test("exit 6: the simulator's own '[sim] actions[i]' lines are shown", () => {
  const e = mapRunFailure(
    run({
      code: 6,
      stderr:
        "[sim] phase=actions\n[sim] action 0: click at 330 ms\n" +
        '[sim] actions[0] (click): no object named "wifi_switch" on the active screen or its layers. Known names/paths (1 named objects): "wifi_sw", "lv_obj#0"\n',
    }),
    15000
  );
  assert.equal(e.kind, "action");
  assert.match(e.message, /actions\[0\] \(click\): no object named "wifi_switch".*"wifi_sw"/);
  assert.doesNotMatch(e.message, /no details on stderr|click at 330 ms/);
  const parse = mapRunFailure(run({ code: 6, stderr: "[sim] actions[2]: unknown action \"tap\" (known: wait, click)\n" }), 15000);
  assert.match(parse.message, /actions\[2\]: unknown action "tap"/);
});

test("exit 1 with an unknown 2.2.0 flag explains the version mismatch", () => {
  const e = mapRunFailure(run({ code: 1, stderr: "Unknown argument: --annotate\nUsage: ..." }), 15000);
  assert.equal(e.kind, "args");
  assert.match(e.message, /does not support --annotate - it is older than this server/);
});

test("parseSimJson: format_version 3 fields; malformed optional fields are dropped", () => {
  const v3 = parseSimJson(
    JSON.stringify({
      format_version: 3,
      lvgl_version: "9.6.0",
      display: { width: 320, height: 240, scale: 2, color_format: "RGB565" },
      elapsed_ms: 330,
      anims_running: 0,
      logs: [],
      screen: { type: "lv_obj", x: 0, y: 0, w: 320, h: 240 },
      captures: [{ n: 1, label: "final", elapsed_ms: 330, png: "capture-1-final.png" }, { bogus: true }],
      mem: { peak_bytes: 71234, budget_bytes: 65536, over_budget: true },
      fonts_used: ["montserrat_14"],
      diagnostics: [{ code: "LOW_CONTRAST", severity: "warn", message: "ratio 1.9" }, "junk"],
      input: { pointer: true, keypad: true, focused: "ok_btn" },
      events: [{ t_ms: 93, name: "ok_btn", event: "clicked" }],
    }),
    { width: 1, height: 1 }
  );
  assert.equal(v3.format_version, 3);
  assert.equal(v3.captures?.length, 1);
  assert.equal(v3.mem?.peak_bytes, 71234);
  assert.deepEqual(v3.fonts_used, ["montserrat_14"]);
  assert.equal(v3.diagnostics?.length, 1);
  assert.equal(v3.input?.focused, "ok_btn");
  assert.equal(v3.events?.[0]?.event, "clicked");
  assert.equal(v3.display.scale, 2);
  const bad = parseSimJson(
    JSON.stringify({ format_version: 3, screen: { type: "lv_obj", x: 0, y: 0, w: 1, h: 1 }, mem: "x", captures: "y" }),
    { width: 1, height: 1 }
  );
  assert.equal(bad.mem, undefined);
  assert.equal(bad.captures, undefined);
  const v2 = parseSimJson(JSON.stringify({ format_version: 2, lvgl_version: "9.6.0", screen: { type: "lv_obj", x: 0, y: 0, w: 1, h: 1 } }), {
    width: 1,
    height: 1,
  });
  assert.equal(v2.format_version, 2);
  assert.equal(v2.diagnostics, undefined);
});

test("collectCaptures: reads captures[] (plain + annotated), falls back to the final PNG", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lvgl-caps-"));
  try {
    const p1 = solidPng(2, 2, [255, 0, 0]);
    const p2 = solidPng(2, 2, [0, 255, 0]);
    const a2 = solidPng(2, 2, [0, 0, 255]);
    await fs.writeFile(path.join(dir, "capture-1-t0.png"), p1);
    await fs.writeFile(path.join(dir, "capture-2-final.png"), p2);
    await fs.writeFile(path.join(dir, "annotated-2-final.png"), a2);
    const out = parseSimJson(
      JSON.stringify({
        format_version: 3,
        screen: { type: "lv_obj", x: 0, y: 0, w: 2, h: 2 },
        captures: [
          { n: 1, label: "t0", elapsed_ms: 0, png: "capture-1-t0.png", annotated: "annotated-1-t0.png" },
          { n: 2, label: "final", elapsed_ms: 330, png: "../../capture-2-final.png", annotated: "annotated-2-final.png" },
        ],
      }),
      { width: 2, height: 2 }
    );
    const { captures, missing } = await collectCaptures(out, dir, p2);
    assert.deepEqual(captures.map((c) => c.label), ["t0", "final"]);
    assert.ok(captures[0]!.png.equals(p1));
    assert.equal(captures[0]!.annotated, undefined);
    assert.deepEqual(missing, ["annotated-1-t0.png"]);
    assert.ok(captures[1]!.png.equals(p2), "path components are stripped: files stay inside the output dir");
    assert.ok(captures[1]!.annotated?.equals(a2));

    const legacy = parseSimJson(JSON.stringify({ format_version: 2, elapsed_ms: 330, screen: { type: "lv_obj", x: 0, y: 0, w: 2, h: 2 } }), {
      width: 2,
      height: 2,
    });
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "lvgl-caps-"));
    const fb = await collectCaptures(legacy, empty, p1);
    assert.equal(fb.captures.length, 1);
    assert.equal(fb.captures[0]!.label, "final");
    assert.ok(fb.captures[0]!.png.equals(p1));
    await fs.rm(empty, { recursive: true, force: true });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("chooseUiBinary: prebuilt without toolchain, current build preferred", () => {
  const c = (s: Partial<Parameters<typeof chooseUiBinary>[0]>) =>
    chooseUiBinary({ builtThisSession: false, hasBuiltBinary: false, hasPrebuiltSim: false, toolchainOk: false, ...s });
  assert.equal(c({ hasPrebuiltSim: true }), "prebuilt", "fresh install, no toolchain");
  assert.equal(c({ hasPrebuiltSim: true, toolchainOk: true }), "prebuilt", "no user binary yet: no compile needed");
  assert.equal(c({ builtThisSession: true, hasBuiltBinary: true, hasPrebuiltSim: true }), "built");
  assert.equal(c({ hasBuiltBinary: true, hasPrebuiltSim: true, toolchainOk: true }), "build-then-built", "stale build dir is rebuilt");
  assert.equal(c({ hasBuiltBinary: true, hasPrebuiltSim: true }), "prebuilt", "toolchain broken: prebuilt");
  assert.equal(c({ hasBuiltBinary: true }), "built");
  assert.equal(c({ toolchainOk: true }), "build-then-built");
  assert.equal(c({}), "none");
});

test("UI mode without prebuilt binary and without toolchain is a setup error", async () => {
  const m = new SimulatorManager({
    simulatorDir: "/nonexistent",
    compilerConfig: { cmakePath: "cmake", ninjaPath: "ninja", simulatorDir: "/nonexistent", buildDir: "/nonexistent/build", generator: "Ninja" },
    doctor: async () => ({ ok: false, problems: ["CMake not found"], notes: [] }),
    prebuilt: { platform: "linux-x64", dir: null, library: null, simulator: null },
  });
  await assert.rejects(m.render({ code: "", full: false, mode: "ui", ui: { type: "lv_obj" }, assetsDir: process.cwd() }), (err: Error & { kind?: string }) => {
    assert.equal(err.kind, "setup");
    assert.match(err.message, /prebuilt simulator/);
    assert.match(err.message, /CMake not found/);
    return true;
  });
});

test("getConfig reports prebuilt artifacts and UI-without-toolchain", () => {
  const m = new SimulatorManager({
    simulatorDir: "/sim",
    compilerConfig: { cmakePath: "cmake", ninjaPath: "ninja", simulatorDir: "/sim", buildDir: "/sim/build", generator: "Ninja" },
    prebuilt: { platform: "linux-x64", dir: "/sim/prebuilt/linux-x64", library: "/sim/prebuilt/linux-x64/liblvgl.a", simulator: "/sim/prebuilt/linux-x64/lvgl_sim" },
  });
  const c = m.getConfig();
  assert.equal(c.platform_id, "linux-x64");
  assert.equal(c.ui_without_toolchain, true);
  assert.equal(c.prebuilt?.disabled, false);
  assert.deepEqual(c.color_formats, ["xrgb8888", "rgb565"]);
});
