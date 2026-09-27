/**
 * End-to-end tests against the real simulator (CMake + C compiler required).
 * Enabled with LVGL_E2E=1. The simulator directory is resolved like the
 * server does (LVGL_SIM_PATH > LVGL_PROJECT_ROOT > ../simulator); set
 * LVGL_BUILD_DIR to build somewhere else than <simulator>/build.
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "../../src/server.js";
import { resolveSimulatorDir } from "../../src/paths.js";
import { SimulatorManager } from "../../src/simulator/manager.js";
import { pngSize } from "../../src/simulator/png.js";
import { formatDoctorReport } from "../../src/doctor.js";

const E2E = process.env["LVGL_E2E"] === "1";
const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

type Structured = Record<string, unknown>;

function text(r: CallToolResult): string {
  return r.content
    .filter((c) => c.type === "text")
    .map((c) => (c as { text: string }).text)
    .join("\n");
}

function png(r: CallToolResult): Buffer {
  const img = r.content.find((c) => c.type === "image") as { data: string; mimeType: string } | undefined;
  assert.ok(img, `expected an image, got: ${text(r).slice(0, 2000)}`);
  assert.equal(img.mimeType, "image/png");
  return Buffer.from(img.data, "base64");
}

describe("e2e: real simulator", { skip: E2E ? false : "set LVGL_E2E=1 to run end-to-end tests", timeout: 30 * 60_000 }, () => {
  const client = new Client({ name: "e2e", version: "0.0.0" });
  let manager: SimulatorManager;

  before(async () => {
    const { simulatorDir } = resolveSimulatorDir(packageDir);
    manager = new SimulatorManager({ simulatorDir, serverVersion: "e2e", runTimeoutMs: 8000 });
    const report = await manager.doctor();
    assert.ok(report.ok, formatDoctorReport(report));
    const server = createServer({ backend: manager, version: "e2e" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
  });

  after(async () => {
    await client.close();
  });

  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args }, undefined, { timeout: 20 * 60_000 })) as CallToolResult;

  test("render: PNG magic + IHDR size, LVGL 9.6, tree contains the label text", async () => {
    const r = await call("lvgl_render", {
      code: 'lv_obj_t *l = lv_label_create(screen);\nlv_label_set_text(l, "Hello E2E costs $5 $& $1");\nlv_obj_set_name(l, "greeting");\nlv_obj_center(l);',
      width: 320,
      height: 240,
    });
    assert.notEqual(r.isError, true, text(r));
    const buf = png(r);
    assert.deepEqual(buf.subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    assert.deepEqual(pngSize(buf), { width: 320, height: 240 });
    const sc = r.structuredContent as Structured;
    assert.match(String(sc["lvgl_version"]), /^9\.6\./);
    assert.equal(sc["width"], 320);

    const inspect = await call("lvgl_inspect", {});
    const t = text(inspect);
    assert.match(t, /format_version 2/);
    assert.ok(t.includes("Hello E2E costs $5 $& $1"), "label text (with $-patterns) present in the tree");
    assert.match(t, /"name":"greeting"/);
    assert.match(t, /"abs":\{"x1":/);
    const last = manager.getLastResult();
    assert.equal(last?.output.format_version, 2);
    assert.equal(last?.output.display.width, 320);
  });

  test("compile error reports snippet line 2", async () => {
    const r = await call("lvgl_render", {
      code: "lv_obj_t *l = lv_label_create(screen);\nthis_function_does_not_exist(l);",
    });
    assert.equal(r.isError, true);
    const t = text(r);
    assert.match(t, /snippet\.c[:(]2\b/);
    assert.doesNotMatch(t, /ninja: build stopped|FAILED:|\[\d+\/\d+\]/);
    assert.doesNotMatch(t, new RegExp(manager.compilerConfig.buildDir.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")));

    const check = await call("lvgl_check", { code: "int ok = 1;\nundefined_thing();" });
    const sc = check.structuredContent as { ok: boolean; diagnostics: Array<{ file: string; line: number; severity: string }> };
    assert.equal(sc.ok, false);
    assert.ok(sc.diagnostics.some((d) => d.file === "snippet.c" && d.line === 2 && d.severity === "error"));

    const full = await call("lvgl_check", { code: '#include "lvgl.h"\nvoid create_ui(void) {\n  nope();\n}\n', full: true });
    const fsc = full.structuredContent as { ok: boolean; diagnostics: Array<{ file: string; line: number }> };
    assert.equal(fsc.ok, false);
    assert.ok(fsc.diagnostics.some((d) => d.file === "user_code.c" && d.line === 3));
  });

  test("two parallel renders both succeed and are distinct", async () => {
    const mk = (label: string) =>
      `lv_obj_t *l = lv_label_create(screen);\nlv_label_set_text(l, "${label}");\nlv_obj_set_style_text_font(l, &lv_font_montserrat_32, 0);\nlv_obj_center(l);`;
    const [a, b] = await Promise.all([
      call("lvgl_render", { code: mk("Alpha one"), width: 400, height: 200 }),
      call("lvgl_render", { code: mk("Bravo two"), width: 200, height: 400 }),
    ]);
    assert.notEqual(a.isError, true, text(a));
    assert.notEqual(b.isError, true, text(b));
    assert.deepEqual(pngSize(png(a)), { width: 400, height: 200 });
    assert.deepEqual(pngSize(png(b)), { width: 200, height: 400 });
    assert.ok(!png(a).equals(png(b)));
    assert.match(text(a), /"Alpha one"/);
    assert.match(text(b), /"Bravo two"/);
  });

  test("infinite loop returns 'timed out' within 20 s", async () => {
    await call("lvgl_check", { code: "volatile int spin = 1;\nwhile (spin) { }" }); // warm the build
    const t0 = Date.now();
    const r = await call("lvgl_render", { code: "volatile int spin = 1;\nwhile (spin) { }" });
    const dt = Date.now() - t0;
    assert.equal(r.isError, true);
    assert.match(text(r), /timed out after \d+ s \(infinite loop\?\)/);
    assert.ok(dt < 20_000, `took ${dt} ms`);
  });

  test("NULL object reports an LVGL assertion quickly", async () => {
    const code = "lv_obj_t *o = NULL;\nlv_obj_set_width(o, 10);";
    await call("lvgl_check", { code });
    const t0 = Date.now();
    const r = await call("lvgl_render", { code });
    const dt = Date.now() - t0;
    assert.equal(r.isError, true);
    assert.match(text(r), /LVGL assertion failed/);
    assert.ok(dt < 5000, `took ${dt} ms`);
  });

  test("segfault in user code is reported as a crash", async () => {
    const r = await call("lvgl_render", { code: "volatile int *p = NULL;\n*p = 42;" });
    assert.equal(r.isError, true);
    assert.match(text(r), /crashed with (SIGSEGV|ACCESS_VIOLATION)/);
  });

  test("width/height are per call, not sticky", async () => {
    const small = await call("lvgl_render", { code: "lv_label_create(screen);", width: 160, height: 120 });
    assert.deepEqual(pngSize(png(small)), { width: 160, height: 120 });
    const dflt = await call("lvgl_render", { code: "lv_label_create(screen);" });
    assert.deepEqual(pngSize(png(dflt)), { width: 800, height: 480 });
  });

  test("rotation 90 swaps the PNG size", async () => {
    const r = await call("lvgl_render", { code: "lv_label_create(screen);", width: 320, height: 240, rotation: 90 });
    assert.notEqual(r.isError, true, text(r));
    assert.deepEqual(pngSize(png(r)), { width: 240, height: 320 });
  });
});
