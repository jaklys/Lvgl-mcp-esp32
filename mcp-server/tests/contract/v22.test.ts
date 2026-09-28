/**
 * Contract tests for the 2.2.0 tools and result format (fake backend).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "../../src/server.js";
import { FakeBackend } from "../helpers/fake-backend.js";

const backend = new FakeBackend();
const client = new Client({ name: "contract-v22", version: "0.0.0" });

before(async () => {
  const server = createServer({ backend, version: "2.2.0-test" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
});

after(async () => {
  await client.close();
});

async function call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}
const text = (r: CallToolResult) =>
  r.content
    .filter((c) => c.type === "text")
    .map((c) => (c as { text: string }).text)
    .join("\n");
const images = (r: CallToolResult) => r.content.filter((c) => c.type === "image");
const sc = (r: CallToolResult) => r.structuredContent as Record<string, unknown>;

test("actions: one image per capture + final, events in text and structuredContent", async () => {
  backend.calls = [];
  const r = await call("lvgl_render", {
    code: "x",
    actions: [{ capture: "before" }, { click: { name: "ok_btn" } }, { wait: 100 }],
  });
  assert.notEqual(r.isError, true, text(r));
  assert.equal(images(r).length, 2);
  const t = text(r);
  assert.match(t, /Images in order \(2\): #1 before @ \d+ ms, #2 final/);
  assert.match(t, /Events \(1\):\n {2}t=93 ms ok_btn clicked/);
  assert.deepEqual(backend.calls[0]!.actions, [{ capture: "before" }, { click: { name: "ok_btn" } }, { wait: 100 }]);
  const caps = sc(r)["captures"] as Array<{ label: string }>;
  assert.deepEqual(caps.map((c) => c.label), ["before", "final"]);
});

test("annotate adds the annotated image right after each plain image", async () => {
  const r = await call("lvgl_render", { code: "x", annotate: true });
  assert.equal(images(r).length, 2);
  assert.match(text(r), /#1 final @ \d+ ms, #2 final \(annotated\)/);
});

test("frames produce one image per frame plus the final state", async () => {
  backend.calls = [];
  const r = await call("lvgl_render", { code: "x", frames: [0, 100, 300] });
  assert.equal(images(r).length, 4);
  assert.deepEqual(backend.calls[0]!.frames, [0, 100, 300]);
});

test("invalid actions / frames are rejected by the schema", async () => {
  for (const args of [
    { code: "x", actions: [{ click: { name: "a" }, wait: 3 }] },
    { code: "x", actions: [{ jump: 1 }] },
    { code: "x", actions: [{ key: "ENTERR" }] },
    { code: "x", actions: [{ capture: "has space" }] },
    { code: "x", actions: [] },
    { code: "x", frames: [100, 50] },
    { code: "x", scale: 5 },
    { code: "x", board: "no-such-board" },
    { code: "x", fonts: ["Montserrat 14"] },
  ]) {
    const r = await call("lvgl_render", args);
    assert.equal(r.isError, true, JSON.stringify(args));
  }
});

test("frames and actions together are rejected with guidance", async () => {
  const r = await call("lvgl_render", { code: "x", frames: [0], actions: [{ wait: 1 }] });
  assert.equal(r.isError, true);
  assert.match(text(r), /either frames or actions/);
});

test("UI diagnostics are grouped by severity; mem and fonts lines", async () => {
  const r = await call("lvgl_render", { code: "DIAG", mem_budget_kb: 64 });
  const t = text(r);
  assert.match(t, /UI diagnostics \(1 error\(s\), 1 warning\(s\), 1 info\):\nErrors:\n {2}- MISSING_GLYPH "title" lv_label#0: char U\+010D/);
  assert.match(t, /Warnings:\n {2}- LABEL_CLIPPED "title" lv_label#0 @ 10,10 100x20: label text/);
  assert.match(t, /Info:\n {2}- OVERLAP lv_button#0: overlaps/);
  assert.match(t, /LVGL heap peak 71 KB \/ budget 64 KB - OVER BUDGET/);
  assert.match(t, /Fonts used: montserrat_14/);
  const d = sc(r)["diagnostics"] as Array<{ code: string }>;
  assert.equal(d.length, 3);
  const clean = await call("lvgl_render", { code: "x", board: "esp32-2432s028r" });
  assert.match(text(clean), /UI diagnostics: none/);
});

test("common params are forwarded to the backend", async () => {
  backend.calls = [];
  await call("lvgl_render_full", {
    code: "x",
    board: "esp32-2432s028r",
    color_format: "rgb565",
    scale: 2,
    fonts: ["montserrat_14", "lv_font_montserrat_20"],
    mem_budget_kb: 48,
    annotate: true,
    esp_shims: true,
  });
  const req = backend.calls[0]!;
  assert.equal(req.mode, "full");
  assert.equal(req.board, "esp32-2432s028r");
  assert.equal(req.colorFormat, "rgb565");
  assert.equal(req.scale, 2);
  assert.deepEqual(req.fonts, ["montserrat_14", "lv_font_montserrat_20"]);
  assert.equal(req.memBudgetKb, 48);
  assert.equal(req.annotate, true);
  assert.equal(req.espShims, true);
  assert.equal(req.rotation, undefined, "rotation left to the board/defaults");
  assert.equal(req.dpi, undefined);
});

test("lvgl_render_ui sends the document; UI errors are isError with the ui: lines", async () => {
  backend.calls = [];
  const ui = { type: "lv_obj", children: [{ type: "lv_label", name: "t", text: "Hi" }] };
  const r = await call("lvgl_render_ui", { ui, width: 320, height: 240 });
  assert.notEqual(r.isError, true, text(r));
  assert.equal(backend.calls[0]!.mode, "ui");
  assert.deepEqual(backend.calls[0]!.ui, ui);
  assert.match(text(r), /JSON UI mode/);
  assert.equal(sc(r)["mode"], "ui");
  const bad = await call("lvgl_render_ui", { ui: { type: "lv_obj", name: "BAD" } });
  assert.equal(bad.isError, true);
  assert.match(text(bad), /^The JSON UI document was rejected[\s\S]*ui: children\[0\]\.type: unknown widget/);
});

test("action errors (exit 6) are isError with the known names", async () => {
  const r = await call("lvgl_render", { code: "x", actions: [{ click: { name: "missing" } }] });
  assert.equal(r.isError, true);
  assert.match(text(r), /known names: title, ok_btn/);
});

test("lvgl_interact: exactly one UI source; actions required", async () => {
  const none = await call("lvgl_interact", { actions: [{ wait: 1 }] });
  assert.equal(none.isError, true);
  assert.match(text(none), /exactly one UI source/);
  const two = await call("lvgl_interact", { code: "x", ui: { type: "lv_obj" }, actions: [{ wait: 1 }] });
  assert.equal(two.isError, true);
  const noActions = await call("lvgl_interact", { code: "x" });
  assert.equal(noActions.isError, true);
  backend.calls = [];
  const ok = await call("lvgl_interact", { code: "x", full: true, actions: [{ click: { x: 5, y: 5 } }, { capture: "after" }] });
  assert.notEqual(ok.isError, true, text(ok));
  assert.equal(backend.calls[0]!.mode, "full");
  assert.equal(images(ok).length, 2);
  const uiOk = await call("lvgl_interact", { ui: { type: "lv_obj" }, actions: [{ load_screen: { name: "settings", anim: "fade", duration: 300 } }] });
  assert.notEqual(uiOk.isError, true, text(uiOk));
  assert.equal(backend.calls[1]!.mode, "ui");
});

test("lvgl_render_project: inline files validated and forwarded; esp_shims default on", async () => {
  backend.calls = [];
  const r = await call("lvgl_render_project", {
    files: [
      { path: "ui/ui.c", content: '#include "ui.h"\nvoid ui_init(void) { ui_home(); }' },
      { path: "ui/screens/home.c", content: '#include "../ui.h"\nvoid ui_home(void) {}' },
      { path: "ui/ui.h", content: "void ui_init(void); void ui_home(void);" },
    ],
    defines: ["MY_FLAG", "LEVEL=2"],
  });
  assert.notEqual(r.isError, true, text(r));
  const req = backend.calls[0]!;
  assert.equal(req.mode, "project");
  assert.equal(req.espShims, true);
  assert.equal(req.project?.entry, "ui_init");
  assert.deepEqual(req.project?.files?.map((f) => f.path), ["ui/ui.c", "ui/screens/home.c", "ui/ui.h"]);
  assert.deepEqual(req.project?.defines, ["MY_FLAG", "LEVEL=2"]);
  for (const bad of [
    [{ path: "/etc/passwd.c", content: "" }],
    [{ path: "../x.c", content: "" }],
    [{ path: "a/../../x.c", content: "" }],
    [{ path: "C:\\x.c", content: "" }],
    [{ path: "only.h", content: "" }],
  ]) {
    const e = await call("lvgl_render_project", { files: bad });
    assert.equal(e.isError, true, JSON.stringify(bad));
  }
  const both = await call("lvgl_render_project", { files: [{ path: "a.c", content: "" }], root: "/tmp" });
  assert.equal(both.isError, true);
  const badDefine = await call("lvgl_render_project", { files: [{ path: "a.c", content: "" }], defines: ["A;B"] });
  assert.equal(badDefine.isError, true);
});

test("lvgl_render_project: root outside the allowed roots is rejected", async () => {
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "lvgl-outside-"));
  try {
    await fs.writeFile(path.join(outside, "ui.c"), "void ui_init(void) {}");
    const r = await call("lvgl_render_project", { root: outside });
    if (outside.startsWith(process.cwd())) return; // cannot happen with a tmp dir, but be safe
    assert.equal(r.isError, true);
    assert.match(text(r), /outside the allowed directories/);
    const rel = await call("lvgl_render_project", { root: "relative/dir" });
    assert.equal(rel.isError, true);
    assert.match(text(rel), /absolute/);
  } finally {
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("lvgl_render_project: root inside LVGL_PROJECT_ROOT is accepted", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lvgl-proj-"));
  const prev = process.env["LVGL_PROJECT_ROOT"];
  process.env["LVGL_PROJECT_ROOT"] = root;
  try {
    await fs.mkdir(path.join(root, "app", "ui"), { recursive: true });
    await fs.writeFile(path.join(root, "app", "ui", "ui.c"), "void ui_init(void) {}");
    backend.calls = [];
    const r = await call("lvgl_render_project", { root: path.join(root, "app"), include_dirs: ["ui"], exclude: ["main/**"] });
    assert.notEqual(r.isError, true, text(r));
    assert.equal(backend.calls[0]!.project?.root, await fs.realpath(path.join(root, "app")));
    assert.deepEqual(backend.calls[0]!.project?.includeDirs, ["ui"]);
    const traversal = await call("lvgl_render_project", { root: path.join(root, "app"), include_dirs: ["../../etc"] });
    assert.equal(traversal.isError, true);
  } finally {
    if (prev === undefined) delete process.env["LVGL_PROJECT_ROOT"];
    else process.env["LVGL_PROJECT_ROOT"] = prev;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("render history + lvgl_diff: pixel and object diff between two renders", async () => {
  const a = await call("lvgl_render", { code: "x" });
  const b = await call("lvgl_render", { code: "MOVED" });
  const ida = String(sc(a)["render_id"]);
  const idb = String(sc(b)["render_id"]);
  assert.notEqual(ida, idb);
  const d = await call("lvgl_diff", { a: ida, b: idb });
  assert.notEqual(d.isError, true, text(d));
  assert.equal(images(d).length, 1);
  const t = text(d);
  assert.match(t, new RegExp(`Pixel diff ${ida} -> ${idb}: 1 of 12 px changed \\(8\\.33%\\), bounding box x 2\\.\\.2, y 0\\.\\.0`));
  assert.match(t, /~ moved "ok_btn" \(lv_button\): 10,50 80x40 -> 110,50 80x40/);
  const s = sc(d) as { pixel: { changed: number }; objects: { moved: unknown[] } };
  assert.equal(s.pixel.changed, 1);
  assert.equal(s.objects.moved.length, 1);
  const same = await call("lvgl_diff", { a: ida, b: ida });
  assert.match(text(same), /0 of 12 px changed \(0%\), no changed pixels/);
  const unknown = await call("lvgl_diff", { a: ida, b: "r999" });
  assert.equal(unknown.isError, true);
  assert.match(text(unknown), /Unknown render_id r999\. Available: /);
});

test("lvgl_inspect with render_id inspects an earlier render", async () => {
  const a = await call("lvgl_render", { code: "x" });
  await call("lvgl_render", { code: "MOVED" });
  const r = await call("lvgl_inspect", { render_id: String(sc(a)["render_id"]), name: "ok_btn" });
  assert.notEqual(r.isError, true, text(r));
  assert.match(text(r), /"abs":\{"x1":10,/);
  const missing = await call("lvgl_inspect", { render_id: "r999" });
  assert.equal(missing.isError, true);
});

test("lvgl_docs returns topics; boards resource", async () => {
  const slider = await call("lvgl_docs", { topic: "widgets/slider" });
  assert.match(text(slider), /void lv_slider_set_value\(lv_obj_t \* obj, int32_t value, lv_anim_enable_t anim\);/);
  assert.match(text(slider), /Parts: MAIN \(track\), INDICATOR/);
  const ui = await call("lvgl_docs", { topic: "ui-json" });
  assert.match(text(ui), /LVGL's own XML format is part of LVGL Pro and is not supported here/);
  assert.match(text(ui), /load_screen/);
  const actions = await call("lvgl_docs", { topic: "actions" });
  assert.match(text(actions), /\{"click": \{"name": "ok_btn"\}\}/);
  const boards = await call("lvgl_docs", { topic: "boards" });
  assert.match(text(boards), /\| `esp32-2432s028r` \| .* \| 320x240 \| RGB565 \|/);
  for (const t of ["esp32", "simulator", "styles", "layouts", "events", "anim", "fonts", "symbols", "v8-migration", "diagnostics", "widgets"]) {
    const r = await call("lvgl_docs", { topic: t });
    assert.notEqual(r.isError, true, t);
    assert.ok(text(r).length > 200, t);
  }
  const bad = await call("lvgl_docs", { topic: "xml" });
  assert.equal(bad.isError, true);
  const res = await client.readResource({ uri: "lvgl://boards" });
  const list = JSON.parse((res.contents[0] as { text: string }).text) as Array<{ id: string; width: number }>;
  assert.ok(list.length >= 15);
  assert.equal(list.find((b) => b.id === "esp32-2432s028r")?.width, 320);
});
