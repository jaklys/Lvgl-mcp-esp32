import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "../../src/server.js";
import { FakeBackend } from "../helpers/fake-backend.js";

const backend = new FakeBackend();
const client = new Client({ name: "contract-test", version: "0.0.0" });

before(async () => {
  const server = createServer({ backend, version: "9.9.9-test" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

after(async () => {
  await client.close();
});

async function call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args }, undefined, signal ? { signal } : undefined)) as CallToolResult;
}

function text(r: CallToolResult): string {
  return r.content
    .filter((c) => c.type === "text")
    .map((c) => (c as { text: string }).text)
    .join("\n");
}

test("server reports name and version from package metadata", () => {
  const info = client.getServerVersion();
  assert.equal(info?.name, "lvgl-simulator");
  assert.equal(info?.version, "9.9.9-test");
  assert.match(client.getInstructions() ?? "", /lvgl_render/);
});

test("tools/list exposes the 2.1.0 tool set with titles, annotations and schemas", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["lvgl_check", "lvgl_inspect", "lvgl_render", "lvgl_render_full", "lvgl_set_resolution"]);
  for (const t of tools) {
    assert.ok(t.title, `${t.name} has a title`);
    assert.ok(t.description && t.description.length > 80, `${t.name} has a real description`);
    assert.ok(t.outputSchema, `${t.name} has an outputSchema`);
    assert.equal(t.annotations?.readOnlyHint, t.name !== "lvgl_set_resolution", `${t.name} readOnlyHint`);
    assert.equal(t.annotations?.openWorldHint, false);
    const props = (t.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
    for (const [k, v] of Object.entries(props)) assert.ok(v.description, `${t.name}.${k} has a description`);
  }
  const render = tools.find((t) => t.name === "lvgl_render")!;
  const props = render.inputSchema.properties as Record<string, Record<string, unknown>>;
  assert.deepEqual(render.inputSchema.required, ["code"]);
  assert.equal(props["width"]["type"], "integer");
  assert.equal(props["width"]["minimum"], 16);
  assert.equal(props["width"]["maximum"], 4096);
  assert.equal(props["width"]["default"], undefined, "width default comes from lvgl_set_resolution");
  assert.equal(props["time_ms"]["default"], 330);
  assert.equal(props["settle"]["default"], false);
  assert.equal(props["theme"]["default"], "light");
  assert.deepEqual(props["include_tree"]["enum"], ["summary", "full", "none"]);
  assert.equal(props["include_tree"]["default"], "summary");
  assert.deepEqual(props["rotation"]["enum"], [0, 90, 180, 270]);
  assert.match(render.description!, /LVGL 9\.6/);
  assert.match(render.description!, /XRGB8888/);
  assert.match(render.description!, /montserrat_8 \.\. lv_font_montserrat_48/);
  assert.match(render.description!, /S:<file>/);
  assert.match(render.description!, /330 ms/);
  assert.match(render.description!, /No input devices/);
  assert.match(render.description!, /lv_obj_t \*screen/);
  assert.match(render.description!, /C11/);

  const res = tools.find((t) => t.name === "lvgl_set_resolution")!;
  const rp = res.inputSchema.properties as Record<string, Record<string, unknown>>;
  assert.equal(rp["width"]["type"], "integer");
  assert.deepEqual(res.inputSchema.required, ["width", "height"]);
  assert.deepEqual(Object.keys(tools.find((t) => t.name === "lvgl_check")!.inputSchema.properties ?? {}).sort(), ["code", "full"]);
  assert.deepEqual(
    Object.keys(tools.find((t) => t.name === "lvgl_inspect")!.inputSchema.properties ?? {}).sort(),
    ["code", "full", "include_styles", "max_depth", "name", "type"]
  );
});

test("lvgl_inspect before any render is an error with guidance", async () => {
  const r = await call("lvgl_inspect", {});
  assert.equal(r.isError, true);
  assert.match(text(r), /No render yet/);
});

test("lvgl_render returns a PNG image, a summary text and structured content", async () => {
  const r = await call("lvgl_render", { code: "lv_label_create(screen);" });
  assert.notEqual(r.isError, true);
  const img = r.content.find((c) => c.type === "image") as { data: string; mimeType: string };
  assert.equal(img.mimeType, "image/png");
  assert.equal(Buffer.from(img.data, "base64").subarray(1, 4).toString(), "PNG");
  const t = text(r);
  assert.match(t, /^Rendered 800x480 px/);
  assert.match(t, /LVGL 9\.6\.0/);
  assert.match(t, /Compiler warnings \(1\):\nsnippet\.c:3:5: warning: unused variable/);
  assert.match(t, /LVGL log \(1 line\):\n\[Warn\]/);
  assert.match(t, /printf output:\nhello from printf/);
  assert.match(t, /Widget tree summary/);
  assert.match(t, /Named: title/);
  assert.doesNotMatch(t, /compact JSON/);
  const sc = r.structuredContent as Record<string, unknown>;
  assert.equal(sc["width"], 800);
  assert.equal(sc["lvgl_version"], "9.6.0");
  assert.equal(sc["widget_count"], 3);
  assert.equal(sc["tree"], undefined);
});

test("render options are forwarded; width/height are per call and not sticky", async () => {
  backend.calls = [];
  await call("lvgl_render", {
    code: "x",
    width: 320,
    height: 240,
    time_ms: 1000,
    settle: true,
    rotation: 90,
    theme: "dark",
    include_tree: "none",
  });
  const req = backend.calls[0];
  assert.deepEqual(
    [req.width, req.height, req.timeMs, req.settle, req.rotation, req.theme, req.full],
    [320, 240, 1000, true, 90, "dark", false]
  );
  assert.deepEqual(backend.getDefaults(), { width: 800, height: 480 });
  const r = await call("lvgl_render", { code: "y" });
  assert.equal(backend.calls[1].width, undefined, "no width passed means backend default");
  assert.equal((r.structuredContent as Record<string, unknown>)["width"], 800);
});

test("include_tree=none omits the summary; full adds compact JSON", async () => {
  const none = await call("lvgl_render", { code: "x", include_tree: "none" });
  assert.doesNotMatch(text(none), /Widget tree/);
  const full = await call("lvgl_render", { code: "x", include_tree: "full" });
  const t = text(full);
  assert.match(t, /Widget tree \(compact JSON\):\n\{"screen":\{"type":"lv_obj"/);
  assert.ok((full.structuredContent as Record<string, unknown>)["tree"]);
});

test("huge trees are trimmed so the text stays under ~20k characters", async () => {
  const r = await call("lvgl_render", { code: "HUGE_TREE", include_tree: "full" });
  const t = text(r);
  assert.ok(t.length < 21000, `text length ${t.length}`);
  assert.match(t, /lvgl_inspect/);
  const summary = await call("lvgl_render", { code: "HUGE_TREE" });
  assert.ok(text(summary).length < 21000);
});

test("lvgl_render_full uses full-file mode", async () => {
  backend.calls = [];
  const r = await call("lvgl_render_full", { code: '#include "lvgl.h"\nvoid create_ui(void){}' });
  assert.notEqual(r.isError, true);
  assert.equal(backend.calls[0].full, true);
  assert.match(text(r), /full-file mode/);
});

test("compile errors are isError with cleaned diagnostics", async () => {
  const r = await call("lvgl_render", { code: "COMPILE_ERROR" });
  assert.equal(r.isError, true);
  assert.equal(r.content.some((c) => c.type === "image"), false);
  assert.match(text(r), /snippet\.c:2:1: error/);
});

test("runtime failures are isError with the mapped message", async () => {
  const crash = await call("lvgl_render", { code: "CRASH" });
  assert.equal(crash.isError, true);
  assert.match(text(crash), /crashed with SIGSEGV/);
  const to = await call("lvgl_render_full", { code: "TIMEOUT" });
  assert.equal(to.isError, true);
  assert.match(text(to), /timed out after 15 s \(infinite loop\?\)/);
});

test("invalid arguments are rejected by the schema", async () => {
  for (const args of [{ code: "x", width: 10 }, { code: "x", width: 320.5 }, { code: "x", rotation: 45 }, { code: "" }]) {
    const r = await call("lvgl_render", args);
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.match(text(r), /Input validation error|Invalid arguments/i);
  }
});

test("lvgl_inspect returns filtered compact JSON of the last render", async () => {
  await call("lvgl_render", { code: "x" });
  const all = await call("lvgl_inspect", {});
  assert.notEqual(all.isError, true);
  assert.match(text(all), /"text":"Hello LVGL"/);
  assert.match(text(all), /format_version 2/);
  const labels = await call("lvgl_inspect", { type: "label", include_styles: false });
  const t = text(labels);
  assert.match(t, /1 widget\(s\) match type=label/);
  assert.doesNotMatch(t, /"styles"/);
  assert.match(t, /"path":"screen\/title"/);
  const sc = labels.structuredContent as Record<string, unknown>;
  assert.equal(sc["match_count"], 1);
  const byName = await call("lvgl_inspect", { name: "tit*" });
  assert.equal((byName.structuredContent as Record<string, unknown>)["match_count"], 1);
  const shallow = await call("lvgl_inspect", { max_depth: 0 });
  assert.match(text(shallow), /"children_omitted":2/);
});

test("lvgl_inspect with code renders first", async () => {
  backend.calls = [];
  const r = await call("lvgl_inspect", { code: "lv_label_create(screen);", full: false });
  assert.notEqual(r.isError, true);
  assert.equal(backend.calls.length, 1);
});

test("lvgl_check returns structured diagnostics without isError", async () => {
  const bad = await call("lvgl_check", { code: "COMPILE_ERROR" });
  assert.notEqual(bad.isError, true);
  const sc = bad.structuredContent as { ok: boolean; errors: number; diagnostics: Array<{ line: number }> };
  assert.equal(sc.ok, false);
  assert.equal(sc.errors, 1);
  assert.equal(sc.diagnostics[0].line, 2);
  assert.match(text(bad), /Compilation failed/);
  const good = await call("lvgl_check", { code: "int x = 1; (void)x;" });
  assert.equal((good.structuredContent as { ok: boolean }).ok, true);
  assert.match(text(good), /Compiles OK/);
});

test("lvgl_set_resolution changes the defaults only", async () => {
  const r = await call("lvgl_set_resolution", { width: 480, height: 320 });
  assert.notEqual(r.isError, true);
  assert.deepEqual(r.structuredContent, { width: 480, height: 320 });
  assert.deepEqual(backend.getDefaults(), { width: 480, height: 320 });
  const rr = await call("lvgl_render", { code: "x" });
  assert.equal((rr.structuredContent as Record<string, unknown>)["width"], 480);
  backend.setDefaults(800, 480);
});

test("cancellation reaches the backend through extra.signal", async () => {
  const ac = new AbortController();
  const p = call("lvgl_render", { code: "SLOW" }, ac.signal).catch((e: Error) => e);
  await new Promise((r) => setTimeout(r, 100));
  ac.abort();
  await p;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(backend.lastSignal?.aborted, true);
});

test("resources: api-reference (9.6) and project-config", async () => {
  const { resources } = await client.listResources();
  const uris = resources.map((r) => r.uri).sort();
  assert.deepEqual(uris, ["lvgl://api-reference", "lvgl://project-config"]);
  const ref = await client.readResource({ uri: "lvgl://api-reference" });
  const md = (ref.contents[0] as { text: string }).text;
  assert.match(md, /LVGL 9\.6/);
  assert.match(md, /Deprecated in 9\.6 \(removed in v10\)/);
  assert.match(md, /lv_obj_set_hidden/);
  assert.match(md, /LV_LABEL_LONG_MODE_WRAP/);
  assert.match(md, /lv_chart_set_axis_range/);
  assert.match(md, /v8 -> v9 renames/);
  assert.match(md, /Simulator constraints/);
  for (const w of ["buttonmatrix", "imagebutton", "spangroup", "tileview", "animimg", "lv_timer_create", "lv_anim_init", "lv_obj_add_event_cb"]) {
    assert.ok(md.includes(w), `mentions ${w}`);
  }
  assert.doesNotMatch(md, /LV_LABEL_LONG_WRAP\)/);
  assert.doesNotMatch(md, /9\.5 API Quick Reference/);
  const cfg = await client.readResource({ uri: "lvgl://project-config" });
  const json = JSON.parse((cfg.contents[0] as { text: string }).text) as Record<string, unknown>;
  assert.equal(json["default_width"], 800);
  assert.equal(json["lvgl_version"], "9.6.0");
  assert.equal(json["colorDepth"], undefined);
});
