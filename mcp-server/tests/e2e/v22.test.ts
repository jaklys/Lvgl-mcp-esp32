/**
 * End-to-end tests for the 2.2.0 features against the real simulator
 * (written against CONTRACT-2.2; needs a 2.2.0 simulator binary).
 * Enabled with LVGL_E2E=1, like tests/e2e/simulator.test.ts.
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
interface UiDiag {
  code: string;
  severity: string;
  name?: string;
  message: string;
}

const text = (r: CallToolResult) =>
  r.content
    .filter((c) => c.type === "text")
    .map((c) => (c as { text: string }).text)
    .join("\n");
const images = (r: CallToolResult) =>
  r.content.filter((c) => c.type === "image").map((c) => Buffer.from((c as { data: string }).data, "base64"));
const sc = (r: CallToolResult) => r.structuredContent as Structured;
const diags = (r: CallToolResult) => (sc(r)["diagnostics"] ?? []) as UiDiag[];
const codes = (r: CallToolResult) => diags(r).map((d) => d.code);

describe("e2e 2.2.0: captures, actions, UI documents, projects, diagnostics", { skip: E2E ? false : "set LVGL_E2E=1 to run end-to-end tests", timeout: 30 * 60_000 }, () => {
  const client = new Client({ name: "e2e-v22", version: "0.0.0" });

  before(async () => {
    const { simulatorDir } = resolveSimulatorDir(packageDir);
    const manager = new SimulatorManager({ simulatorDir, serverVersion: "e2e", runTimeoutMs: 10000 });
    const report = await manager.doctor();
    assert.ok(report.ok, formatDoctorReport(report));
    const server = createServer({ backend: manager, version: "e2e" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
  });

  after(async () => {
    await client.close();
  });

  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args }, undefined, { timeout: 20 * 60_000 })) as CallToolResult;
    return r;
  };
  const ok = (r: CallToolResult) => {
    assert.notEqual(r.isError, true, text(r).slice(0, 4000));
    return r;
  };

  const SWITCH_UI = `#include "lvgl.h"
static void on_change(lv_event_t *e) {
    lv_obj_t *sw = lv_event_get_target_obj(e);
    printf("switch %s\\n", lv_obj_has_state(sw, LV_STATE_CHECKED) ? "on" : "off");
}
void create_ui(void) {
    lv_obj_t *sw = lv_switch_create(lv_screen_active());
    lv_obj_set_name(sw, "wifi_sw");
    lv_obj_set_size(sw, 80, 44);
    lv_obj_center(sw);
    lv_obj_add_event_cb(sw, on_change, LV_EVENT_VALUE_CHANGED, NULL);
}
`;

  test("click by name toggles a switch; VALUE_CHANGED is reported; one image per capture", async () => {
    const r = ok(
      await call("lvgl_render_full", {
        code: SWITCH_UI,
        width: 320,
        height: 240,
        actions: [{ capture: "before" }, { click: { name: "wifi_sw" } }, { wait: 300 }],
      })
    );
    const imgs = images(r);
    assert.equal(imgs.length, 2, "capture 'before' + final");
    assert.ok(!imgs[0]!.equals(imgs[1]!), "the switch looks different after the click");
    const events = (sc(r)["events"] ?? []) as Array<{ name?: string; event: string }>;
    assert.ok(events.some((e) => e.name === "wifi_sw" && /value_changed/i.test(e.event)), JSON.stringify(events));
    assert.match(text(r), /switch on/);
    const inspect = await call("lvgl_inspect", { name: "wifi_sw" });
    assert.match(text(inspect), /"checked"/);
  });

  test("keypad: focus a textarea and type", async () => {
    const r = ok(
      await call("lvgl_render", {
        code: 'lv_obj_t *ta = lv_textarea_create(screen);\nlv_obj_set_name(ta, "ssid");\nlv_textarea_set_one_line(ta, true);\nlv_obj_center(ta);',
        width: 320,
        height: 240,
        actions: [{ focus: { name: "ssid" } }, { type: "hello" }, { key: "BACKSPACE" }],
      })
    );
    const inspect = await call("lvgl_inspect", { name: "ssid" });
    assert.match(text(inspect), /hell(?!o)/);
    assert.match(text(r), /Focused object: ssid/);
  });

  test("frames return one image per frame (labels t<ms>), final state last", async () => {
    const r = ok(
      await call("lvgl_render", {
        code: "lv_obj_t *sp = lv_spinner_create(screen);\nlv_obj_center(sp);",
        width: 200,
        height: 200,
        frames: [0, 100, 300],
      })
    );
    const caps = sc(r)["captures"] as Array<{ label: string }>;
    const labels = caps.map((c) => c.label);
    for (const l of ["t0", "t100", "t300"]) assert.ok(labels.includes(l), labels.join(","));
    assert.ok(images(r).length >= 3 && images(r).length === caps.length, `${images(r).length} images for ${caps.length} captures`);
    assert.ok(!images(r)[0]!.equals(images(r)[1]!), "the spinner moved between frames");
  });

  test("annotate returns the plain and the annotated image", async () => {
    const r = ok(
      await call("lvgl_render", {
        code: 'lv_obj_t *b = lv_button_create(screen);\nlv_obj_set_name(b, "ok_btn");\nlv_obj_center(b);',
        width: 320,
        height: 240,
        annotate: true,
      })
    );
    const imgs = images(r);
    assert.equal(imgs.length, 2);
    assert.deepEqual(pngSize(imgs[0]!), pngSize(imgs[1]!));
    assert.ok(!imgs[0]!.equals(imgs[1]!));
    const tree = await call("lvgl_inspect", {});
    assert.doesNotMatch(text(tree), /lv_layer_sys|annotation/i, "annotations do not change the widget tree");
  });

  test("scale 2 doubles the PNG size, tree coordinates stay logical", async () => {
    const r = ok(await call("lvgl_render", { code: "lv_label_create(screen);", width: 160, height: 120, scale: 2 }));
    assert.deepEqual(pngSize(images(r)[0]!), { width: 320, height: 240 });
  });

  test("JSON UI document renders a label (no C code)", async () => {
    const r = ok(
      await call("lvgl_render_ui", {
        ui: {
          type: "lv_obj",
          styles: { bg_color: "#ffffff" },
          children: [{ type: "lv_label", name: "hello", text: "Hello UI", align: "center", styles: { text_color: "#111827", font: "montserrat_20" } }],
        },
        width: 320,
        height: 240,
      })
    );
    assert.equal(sc(r)["mode"], "ui");
    assert.match(text(r), /"Hello UI"/);
    const t = await call("lvgl_inspect", { name: "hello" });
    assert.match(text(t), /"text":"Hello UI"/);
    assert.match(text(t), /"font":"montserrat_20"/, "styles round-trip");
  });

  test("invalid JSON UI documents list every problem (exit 5)", async () => {
    const r = await call("lvgl_render_ui", {
      ui: { type: "lv_obj", children: [{ type: "lv_meter" }, { type: "lv_label", colour: "#fff" }] },
    });
    assert.equal(r.isError, true);
    const t = text(r);
    assert.match(t, /ui: children\[0\]\.type: /);
    assert.match(t, /ui: children\[1\]\.colour: /);
  });

  test("unknown action target (exit 6) lists the known names", async () => {
    const r = await call("lvgl_render_full", { code: SWITCH_UI, actions: [{ click: { name: "wifi_switch" } }] });
    assert.equal(r.isError, true);
    assert.match(text(r), /wifi_sw/);
  });

  test("lvgl_diff of two renders reports the moved object", async () => {
    const mk = (x: number) =>
      `lv_obj_t *b = lv_button_create(screen);\nlv_obj_set_name(b, "ok_btn");\nlv_obj_set_size(b, 80, 40);\nlv_obj_set_pos(b, ${x}, 50);`;
    const a = ok(await call("lvgl_render", { code: mk(10), width: 320, height: 240 }));
    const b = ok(await call("lvgl_render", { code: mk(110), width: 320, height: 240 }));
    const d = ok(await call("lvgl_diff", { a: sc(a)["render_id"], b: sc(b)["render_id"] }));
    const objects = sc(d)["objects"] as { moved: Array<{ key: string; from: { x1: number }; to: { x1: number } }> };
    const moved = objects.moved.find((m) => m.key === "ok_btn");
    assert.ok(moved, text(d));
    assert.equal(moved.to.x1 - moved.from.x1, 100);
    assert.ok((sc(d)["pixel"] as { changed: number }).changed > 0);
    assert.equal(images(d).length, 1);
  });

  test("lvgl_render_project compiles two inline files and calls ui_init()", async () => {
    const r = ok(
      await call("lvgl_render_project", {
        files: [
          { path: "ui/ui.h", content: "#pragma once\n#include \"lvgl.h\"\nvoid ui_init(void);\nvoid ui_home_create(lv_obj_t *parent);\n" },
          { path: "ui/ui.c", content: '#include "ui.h"\n#include "esp_log.h"\nvoid ui_init(void) {\n    ESP_LOGI("ui", "init");\n    ui_home_create(lv_screen_active());\n}\n' },
          {
            path: "ui/screens/home.c",
            content: '#include "../ui.h"\nvoid ui_home_create(lv_obj_t *parent) {\n    lv_obj_t *l = lv_label_create(parent);\n    lv_obj_set_name(l, "home_title");\n    lv_label_set_text(l, "Project home");\n    lv_obj_center(l);\n}\n',
          },
        ],
        width: 320,
        height: 240,
      })
    );
    assert.equal(sc(r)["mode"], "project");
    assert.match(text(r), /"Project home"/);
    assert.match(text(r), /init/, "ESP_LOGI goes to the LVGL log through the shims");
    const bad = await call("lvgl_render_project", {
      files: [{ path: "ui/screens/home.c", content: "void ui_init(void) {\n  nope();\n}\n" }],
    });
    assert.equal(bad.isError, true);
    assert.match(text(bad), /ui\/screens\/home\.c:2/, "diagnostics keep the project-relative file name");
  });

  test("board preset sets 320x240 RGB565", async () => {
    const r = ok(await call("lvgl_render", { code: "lv_label_create(screen);", board: "esp32-2432s028r" }));
    assert.deepEqual(pngSize(images(r)[0]!), { width: 320, height: 240 });
    assert.match(String(sc(r)["color_format"]), /565/i);
    assert.match(text(r), /budget 48 KB/);
  });

  test("mem_budget_kb 32 with many labels yields MEM_OVER_BUDGET", async () => {
    const r = ok(
      await call("lvgl_render", {
        code: 'for (int i = 0; i < 400; i++) {\n  lv_obj_t *l = lv_label_create(screen);\n  lv_label_set_text_fmt(l, "Label number %d with some text", i);\n  lv_obj_set_pos(l, (i % 4) * 200, (i / 4) * 20);\n}',
        mem_budget_kb: 32,
      })
    );
    assert.ok(codes(r).includes("MEM_OVER_BUDGET"), codes(r).join(","));
    const mem = sc(r)["mem"] as { peak_bytes: number; budget_bytes: number; over_budget: boolean };
    assert.equal(mem.budget_bytes, 32 * 1024);
    assert.ok(mem.peak_bytes > mem.budget_bytes);
    assert.match(text(r), /OVER BUDGET/);
  });

  test("fonts restriction yields FONT_NOT_ON_DEVICE", async () => {
    const r = ok(
      await call("lvgl_render", {
        code: 'lv_obj_t *l = lv_label_create(screen);\nlv_obj_set_name(l, "big");\nlv_label_set_text(l, "Big");\nlv_obj_set_style_text_font(l, &lv_font_montserrat_20, 0);',
        fonts: ["montserrat_14"],
      })
    );
    const d = diags(r).find((x) => x.code === "FONT_NOT_ON_DEVICE");
    assert.ok(d, codes(r).join(","));
    assert.equal(d.severity, "error");
    assert.equal(d.name, "big");
    assert.ok((sc(r)["fonts_used"] as string[]).includes("montserrat_20"));
  });

  test("a bad UI yields LABEL_CLIPPED, MISSING_GLYPH, LOW_CONTRAST and OVERLAP", async () => {
    const r = ok(
      await call("lvgl_render", {
        code: [
          'lv_obj_t *t = lv_label_create(screen);',
          'lv_obj_set_name(t, "title");',
          'lv_label_set_long_mode(t, LV_LABEL_LONG_MODE_CLIP);',
          'lv_obj_set_width(t, 60);',
          'lv_label_set_text(t, "Living room temperature");',
          'lv_obj_set_pos(t, 10, 10);',
          'lv_obj_t *g = lv_label_create(screen);',
          'lv_obj_set_name(g, "glyph");',
          'lv_label_set_text(g, "Teplota \\xC4\\x8D");', // "č" is not in montserrat_14
          'lv_obj_set_pos(g, 10, 60);',
          'lv_obj_t *c = lv_label_create(screen);',
          'lv_obj_set_name(c, "faint");',
          'lv_label_set_text(c, "Faint text");',
          'lv_obj_set_style_text_color(c, lv_color_hex(0xEEEEEE), 0);',
          'lv_obj_set_pos(c, 10, 110);',
          'lv_obj_t *a = lv_obj_create(screen);',
          'lv_obj_set_name(a, "box_a");',
          'lv_obj_set_size(a, 100, 60);',
          'lv_obj_set_pos(a, 150, 100);',
          'lv_obj_t *b = lv_obj_create(screen);',
          'lv_obj_set_name(b, "box_b");',
          'lv_obj_set_size(b, 100, 60);',
          'lv_obj_set_pos(b, 200, 130);',
        ].join("\n"),
        width: 320,
        height: 240,
      })
    );
    const c = codes(r);
    for (const code of ["LABEL_CLIPPED", "MISSING_GLYPH", "LOW_CONTRAST", "OVERLAP"]) assert.ok(c.includes(code), `${code} in ${c.join(",")}`);
    assert.equal(diags(r).find((d) => d.code === "LABEL_CLIPPED")?.name, "title");
    assert.equal(diags(r).find((d) => d.code === "MISSING_GLYPH")?.severity, "error");
    assert.match(text(r), /UI diagnostics \(\d+ error\(s\)/);
  });

  test("a clean UI yields zero diagnostics", async () => {
    const r = ok(
      await call("lvgl_render", {
        code: [
          'lv_obj_t *t = lv_label_create(screen);',
          'lv_obj_set_name(t, "title");',
          'lv_label_set_text(t, "Settings");',
          'lv_obj_align(t, LV_ALIGN_TOP_MID, 0, 16);',
          'lv_obj_t *b = lv_button_create(screen);',
          'lv_obj_set_name(b, "save_btn");',
          'lv_obj_set_size(b, 140, 50);',
          'lv_obj_set_style_bg_color(b, lv_color_hex(0x1E3A8A), 0);',
          'lv_obj_center(b);',
          'lv_obj_t *bl = lv_label_create(b);',
          'lv_label_set_text(bl, "Save");',
          'lv_obj_set_style_text_color(bl, lv_color_white(), 0);',
          'lv_obj_center(bl);',
        ].join("\n"),
        width: 320,
        height: 240,
        settle: true,
      })
    );
    assert.deepEqual(diags(r), [], JSON.stringify(diags(r)));
    assert.match(text(r), /UI diagnostics: none/);
  });

  test("esp_shims in full mode: ESP_LOGI and vTaskDelay compile and run", async () => {
    const r = ok(
      await call("lvgl_render_full", {
        code: '#include "lvgl.h"\n#include "esp_log.h"\n#include "freertos/FreeRTOS.h"\n#include "freertos/task.h"\nstatic const char *TAG = "ui";\nvoid create_ui(void) {\n    ESP_LOGI(TAG, "building %d", 42);\n    vTaskDelay(pdMS_TO_TICKS(100));\n    lv_label_set_text(lv_label_create(lv_screen_active()), "ESP");\n}\n',
        esp_shims: true,
      })
    );
    assert.match(text(r), /building 42/);
  });
});
