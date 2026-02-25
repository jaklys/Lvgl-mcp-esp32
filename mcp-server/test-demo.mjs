/**
 * Demo test — renders a complex LVGL UI through the MCP server.
 * Tests: lvgl_render, lvgl_render_full, lvgl_set_resolution, lvgl_inspect
 */
import { spawn } from "node:child_process";
import * as readline from "node:readline";
import * as fs from "node:fs";
import * as path from "node:path";

const child = spawn("node", ["dist/index.js"], {
  stdio: ["pipe", "pipe", "pipe"],
  cwd: import.meta.dirname,
});

child.stderr.on("data", (d) => process.stderr.write(`[srv] ${d}`));

const rl = readline.createInterface({ input: child.stdout });
let nextId = 1;
const pending = new Map();

rl.on("line", (line) => {
  const msg = JSON.parse(line);
  const cb = pending.get(msg.id);
  if (cb) { pending.delete(msg.id); cb(msg); }
});

function send(method, params) {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

const outDir = path.join(import.meta.dirname, "..", "test-output");
fs.mkdirSync(outDir, { recursive: true });

function savePng(base64, filename) {
  const p = path.join(outDir, filename);
  fs.writeFileSync(p, Buffer.from(base64, "base64"));
  console.log(`  Saved: ${p}`);
}

function saveJson(data, filename) {
  const p = path.join(outDir, filename);
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
  console.log(`  Saved: ${p}`);
}

// ---- TESTS ----

await send("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "demo-test", version: "0.1" },
});
console.log("\n=== LVGL MCP Demo Test ===\n");

// --- Test 1: Simple snippet (480x320) ---
console.log("[1] lvgl_render — Button + slider (480x320)");
let r = await send("tools/call", {
  name: "lvgl_render",
  arguments: {
    code: `
      /* Title */
      lv_obj_t *title = lv_label_create(screen);
      lv_label_set_text(title, "LVGL Demo");
      lv_obj_set_style_text_font(title, &lv_font_montserrat_24, 0);
      lv_obj_align(title, LV_ALIGN_TOP_MID, 0, 20);

      /* Button */
      lv_obj_t *btn = lv_button_create(screen);
      lv_obj_set_size(btn, 160, 50);
      lv_obj_align(btn, LV_ALIGN_CENTER, 0, -30);
      lv_obj_t *btn_label = lv_label_create(btn);
      lv_label_set_text(btn_label, LV_SYMBOL_POWER " Power");
      lv_obj_center(btn_label);

      /* Slider */
      lv_obj_t *slider = lv_slider_create(screen);
      lv_obj_set_width(slider, 200);
      lv_slider_set_value(slider, 70, LV_ANIM_OFF);
      lv_obj_align(slider, LV_ALIGN_CENTER, 0, 40);

      /* Slider label */
      lv_obj_t *sl_label = lv_label_create(screen);
      lv_label_set_text(sl_label, "Brightness: 70%");
      lv_obj_align(sl_label, LV_ALIGN_CENTER, 0, 70);
    `,
    width: 480,
    height: 320,
  },
});
if (r.result?.isError) {
  console.log("  FAILED:", r.result.content[0].text);
} else {
  const img = r.result.content.find((c) => c.type === "image");
  const time = r.result.content.find((c) => c.type === "text" && c.text.includes("Render time"));
  const tree = r.result.content.find((c) => c.type === "text" && c.text.startsWith("Widget tree:"));
  if (img) savePng(img.data, "01-button-slider.png");
  if (tree) saveJson(JSON.parse(tree.text.replace("Widget tree:\n", "")), "01-button-slider.json");
  if (time) console.log(`  ${time.text}`);
}

// --- Test 2: Dashboard with flex layout (800x480) ---
console.log("\n[2] lvgl_render_full — Dashboard (800x480)");
r = await send("tools/call", {
  name: "lvgl_render_full",
  arguments: {
    code: `
#include "lvgl.h"

static lv_obj_t * create_card(lv_obj_t *parent, const char *title, const char *value, lv_color_t color) {
    lv_obj_t *card = lv_obj_create(parent);
    lv_obj_set_size(card, 180, 120);
    lv_obj_set_style_bg_color(card, color, 0);
    lv_obj_set_style_bg_opa(card, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(card, 12, 0);
    lv_obj_set_style_pad_all(card, 15, 0);
    lv_obj_set_flex_flow(card, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_align(card, LV_FLEX_ALIGN_SPACE_BETWEEN, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_START);
    lv_obj_set_scrollbar_mode(card, LV_SCROLLBAR_MODE_OFF);

    lv_obj_t *lbl_title = lv_label_create(card);
    lv_label_set_text(lbl_title, title);
    lv_obj_set_style_text_color(lbl_title, lv_color_white(), 0);
    lv_obj_set_style_text_font(lbl_title, &lv_font_montserrat_14, 0);

    lv_obj_t *lbl_value = lv_label_create(card);
    lv_label_set_text(lbl_value, value);
    lv_obj_set_style_text_color(lbl_value, lv_color_white(), 0);
    lv_obj_set_style_text_font(lbl_value, &lv_font_montserrat_24, 0);

    return card;
}

void create_ui(void) {
    lv_obj_t *screen = lv_screen_active();
    lv_obj_set_style_bg_color(screen, lv_color_hex(0x1a1a2e), 0);
    lv_obj_set_style_bg_opa(screen, LV_OPA_COVER, 0);
    lv_obj_set_flex_flow(screen, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_style_pad_all(screen, 20, 0);
    lv_obj_set_style_pad_gap(screen, 15, 0);

    /* Header */
    lv_obj_t *header = lv_obj_create(screen);
    lv_obj_set_size(header, lv_pct(100), 50);
    lv_obj_set_style_bg_opa(header, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(header, 0, 0);
    lv_obj_set_style_pad_all(header, 0, 0);
    lv_obj_set_scrollbar_mode(header, LV_SCROLLBAR_MODE_OFF);

    lv_obj_t *app_title = lv_label_create(header);
    lv_label_set_text(app_title, LV_SYMBOL_HOME " Smart Home Dashboard");
    lv_obj_set_style_text_color(app_title, lv_color_white(), 0);
    lv_obj_set_style_text_font(app_title, &lv_font_montserrat_20, 0);
    lv_obj_align(app_title, LV_ALIGN_LEFT_MID, 0, 0);

    lv_obj_t *time_lbl = lv_label_create(header);
    lv_label_set_text(time_lbl, "14:32");
    lv_obj_set_style_text_color(time_lbl, lv_color_hex(0x888888), 0);
    lv_obj_set_style_text_font(time_lbl, &lv_font_montserrat_20, 0);
    lv_obj_align(time_lbl, LV_ALIGN_RIGHT_MID, 0, 0);

    /* Cards row */
    lv_obj_t *cards = lv_obj_create(screen);
    lv_obj_set_size(cards, lv_pct(100), 140);
    lv_obj_set_style_bg_opa(cards, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(cards, 0, 0);
    lv_obj_set_style_pad_all(cards, 0, 0);
    lv_obj_set_flex_flow(cards, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(cards, LV_FLEX_ALIGN_SPACE_BETWEEN, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_scrollbar_mode(cards, LV_SCROLLBAR_MODE_OFF);

    create_card(cards, LV_SYMBOL_TINT " Temperature", "23.5 C", lv_color_hex(0xe74c3c));
    create_card(cards, LV_SYMBOL_CHARGE " Power", "1.2 kW", lv_color_hex(0x3498db));
    create_card(cards, LV_SYMBOL_WIFI " Network", "Online", lv_color_hex(0x2ecc71));
    create_card(cards, LV_SYMBOL_BELL " Alerts", "3 new", lv_color_hex(0xf39c12));

    /* Bottom section: switch + bar */
    lv_obj_t *bottom = lv_obj_create(screen);
    lv_obj_set_size(bottom, lv_pct(100), LV_SIZE_CONTENT);
    lv_obj_set_style_bg_color(bottom, lv_color_hex(0x16213e), 0);
    lv_obj_set_style_bg_opa(bottom, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(bottom, 12, 0);
    lv_obj_set_style_pad_all(bottom, 20, 0);
    lv_obj_set_flex_flow(bottom, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_style_pad_gap(bottom, 15, 0);
    lv_obj_set_scrollbar_mode(bottom, LV_SCROLLBAR_MODE_OFF);

    /* Lights row */
    lv_obj_t *light_row = lv_obj_create(bottom);
    lv_obj_set_size(light_row, lv_pct(100), LV_SIZE_CONTENT);
    lv_obj_set_style_bg_opa(light_row, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(light_row, 0, 0);
    lv_obj_set_style_pad_all(light_row, 0, 0);
    lv_obj_set_flex_flow(light_row, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(light_row, LV_FLEX_ALIGN_SPACE_BETWEEN, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_scrollbar_mode(light_row, LV_SCROLLBAR_MODE_OFF);

    lv_obj_t *light_lbl = lv_label_create(light_row);
    lv_label_set_text(light_lbl, LV_SYMBOL_EYE_OPEN " Living Room Lights");
    lv_obj_set_style_text_color(light_lbl, lv_color_white(), 0);

    lv_obj_t *sw = lv_switch_create(light_row);
    lv_obj_add_state(sw, LV_STATE_CHECKED);

    /* Progress bar */
    lv_obj_t *prog_lbl = lv_label_create(bottom);
    lv_label_set_text(prog_lbl, "Energy usage today: 67%");
    lv_obj_set_style_text_color(prog_lbl, lv_color_hex(0xaaaaaa), 0);

    lv_obj_t *bar = lv_bar_create(bottom);
    lv_obj_set_size(bar, lv_pct(100), 15);
    lv_bar_set_value(bar, 67, LV_ANIM_OFF);
    lv_obj_set_style_bg_color(bar, lv_color_hex(0x0a3d62), LV_PART_MAIN);
    lv_obj_set_style_bg_color(bar, lv_palette_main(LV_PALETTE_GREEN), LV_PART_INDICATOR);
    lv_obj_set_style_radius(bar, 5, 0);
    lv_obj_set_style_radius(bar, 5, LV_PART_INDICATOR);
}
`,
  },
});
if (r.result?.isError) {
  console.log("  FAILED:", r.result.content[0].text);
} else {
  const img = r.result.content.find((c) => c.type === "image");
  const time = r.result.content.find((c) => c.type === "text" && c.text.includes("Render time"));
  const tree = r.result.content.find((c) => c.type === "text" && c.text.startsWith("Widget tree:"));
  if (img) savePng(img.data, "02-dashboard.png");
  if (tree) saveJson(JSON.parse(tree.text.replace("Widget tree:\n", "")), "02-dashboard.json");
  if (time) console.log(`  ${time.text}`);
}

// --- Test 3: lvgl_inspect on the dashboard ---
console.log("\n[3] lvgl_inspect — Widget tree of last render");
r = await send("tools/call", { name: "lvgl_inspect", arguments: {} });
if (r.result?.isError) {
  console.log("  FAILED:", r.result.content[0].text);
} else {
  const tree = JSON.parse(r.result.content[0].text);
  saveJson(tree, "03-inspect.json");
  const countWidgets = (node) => 1 + (node.children || []).reduce((s, c) => s + countWidgets(c), 0);
  console.log(`  Widget count: ${countWidgets(tree)}`);
  console.log(`  Root: ${tree.type} ${tree.w}x${tree.h}`);
  console.log(`  Direct children: ${tree.children?.length || 0}`);
}

// --- Test 4: Small resolution ESP32 display ---
console.log("\n[4] lvgl_render — ESP32 small display (320x240)");
r = await send("tools/call", {
  name: "lvgl_render",
  arguments: {
    code: `
      lv_obj_set_style_bg_color(screen, lv_color_hex(0x003a57), 0);
      lv_obj_set_style_bg_opa(screen, LV_OPA_COVER, 0);
      lv_obj_set_flex_flow(screen, LV_FLEX_FLOW_COLUMN);
      lv_obj_set_flex_align(screen, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
      lv_obj_set_style_pad_gap(screen, 10, 0);

      lv_obj_t *arc = lv_arc_create(screen);
      lv_obj_set_size(arc, 120, 120);
      lv_arc_set_value(arc, 72);
      lv_obj_set_style_arc_color(arc, lv_palette_main(LV_PALETTE_CYAN), LV_PART_INDICATOR);
      lv_obj_set_style_arc_width(arc, 10, LV_PART_INDICATOR);
      lv_obj_set_style_arc_width(arc, 10, LV_PART_MAIN);

      lv_obj_t *arc_lbl = lv_label_create(arc);
      lv_label_set_text(arc_lbl, "72%");
      lv_obj_set_style_text_font(arc_lbl, &lv_font_montserrat_24, 0);
      lv_obj_set_style_text_color(arc_lbl, lv_color_white(), 0);
      lv_obj_center(arc_lbl);

      lv_obj_t *status = lv_label_create(screen);
      lv_label_set_text(status, "Sensor Active");
      lv_obj_set_style_text_color(status, lv_palette_main(LV_PALETTE_GREEN), 0);
    `,
    width: 320,
    height: 240,
  },
});
if (r.result?.isError) {
  console.log("  FAILED:", r.result.content[0].text);
} else {
  const img = r.result.content.find((c) => c.type === "image");
  const time = r.result.content.find((c) => c.type === "text" && c.text.includes("Render time"));
  const tree = r.result.content.find((c) => c.type === "text" && c.text.startsWith("Widget tree:"));
  if (img) savePng(img.data, "04-esp32-small.png");
  if (tree) saveJson(JSON.parse(tree.text.replace("Widget tree:\n", "")), "04-esp32-small.json");
  if (time) console.log(`  ${time.text}`);
}

// --- Test 5: Compilation error handling ---
console.log("\n[5] lvgl_render — Intentional error");
r = await send("tools/call", {
  name: "lvgl_render",
  arguments: { code: "this_function_does_not_exist();" },
});
if (r.result?.isError) {
  console.log("  Error caught (expected):", r.result.content[0].text.split("\n")[0]);
} else {
  console.log("  UNEXPECTED: no error returned");
}

console.log("\n=== All tests complete ===\n");
child.stdin.end();

child.on("exit", () => process.exit(0));
setTimeout(() => { child.kill(); process.exit(1); }, 300000);
