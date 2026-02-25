/**
 * E-BREW project screen render test
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

function handleResult(r, pngName, jsonName) {
  if (r.result?.isError) {
    console.log("  FAILED:", r.result.content[0].text);
    return;
  }
  const img = r.result.content.find((c) => c.type === "image");
  const time = r.result.content.find((c) => c.type === "text" && c.text.includes("Render time"));
  const tree = r.result.content.find((c) => c.type === "text" && c.text.startsWith("Widget tree:"));
  if (img) savePng(img.data, pngName);
  if (tree) saveJson(JSON.parse(tree.text.replace("Widget tree:\n", "")), jsonName);
  if (time) console.log(`  ${time.text}`);
}

await send("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "ebrew-test", version: "0.1" },
});

console.log("\n=== E-BREW Screen Render Test ===\n");

// ========== Screen 1: MENU ==========
console.log("[1] E-BREW Menu Screen (800x480)");
let r = await send("tools/call", {
  name: "lvgl_render_full",
  arguments: {
    code: `#include "lvgl.h"

#define UI_COLOR_GOLD        0xd4af37
#define UI_COLOR_WHITE       0xffffff
#define UI_COLOR_DARK_GRAY   0x2c2c2c
#define UI_COLOR_BORDER_GRAY 0xcccccc
#define UI_COLOR_GREEN       0x4CAF50

void create_ui(void) {
    lv_obj_t *screen = lv_screen_active();
    int i;
    lv_obj_set_style_bg_color(screen, lv_color_hex(UI_COLOR_WHITE), LV_PART_MAIN);

    lv_obj_t *title = lv_label_create(screen);
    lv_label_set_text(title, "E-BREW");
    lv_obj_set_style_text_font(title, &lv_font_montserrat_24, LV_PART_MAIN);
    lv_obj_set_style_text_color(title, lv_color_hex(UI_COLOR_GOLD), LV_PART_MAIN);
    lv_obj_align(title, LV_ALIGN_TOP_MID, 0, 20);

    lv_obj_t *time_lbl = lv_label_create(screen);
    lv_label_set_text(time_lbl, "12:34:56");
    lv_obj_set_style_text_font(time_lbl, &lv_font_montserrat_14, LV_PART_MAIN);
    lv_obj_set_style_text_color(time_lbl, lv_color_hex(0x333333), LV_PART_MAIN);
    lv_obj_align(time_lbl, LV_ALIGN_TOP_RIGHT, -10, 22);

    lv_obj_t *mb_lbl = lv_label_create(screen);
    lv_label_set_text(mb_lbl, "MB");
    lv_obj_set_style_text_font(mb_lbl, &lv_font_montserrat_14, LV_PART_MAIN);
    lv_obj_set_style_text_color(mb_lbl, lv_color_hex(UI_COLOR_GREEN), LV_PART_MAIN);
    lv_obj_align(mb_lbl, LV_ALIGN_TOP_RIGHT, -85, 22);

    lv_obj_t *wifi_lbl = lv_label_create(screen);
    lv_label_set_text(wifi_lbl, "WiFi");
    lv_obj_set_style_text_font(wifi_lbl, &lv_font_montserrat_14, LV_PART_MAIN);
    lv_obj_set_style_text_color(wifi_lbl, lv_color_hex(UI_COLOR_GREEN), LV_PART_MAIN);
    lv_obj_align(wifi_lbl, LV_ALIGN_TOP_RIGHT, -130, 22);

    const char *tile_labels[] = {
        "PREHLED", "CERPADLO", "OVLADANI",
        "TERMOSTATY", "GRAFY", "SYSTEM INFO"
    };
    uint32_t tile_colors[] = {
        UI_COLOR_GOLD, 0x5a5a5a, 0x4a4a4a,
        UI_COLOR_DARK_GRAY, 0x606060, 0x3a3a3a
    };

    lv_obj_t *tile_container = lv_obj_create(screen);
    lv_obj_set_size(tile_container, 770, 320);
    lv_obj_set_style_bg_opa(tile_container, 0, LV_PART_MAIN);
    lv_obj_set_style_border_width(tile_container, 0, LV_PART_MAIN);
    lv_obj_clear_flag(tile_container, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_align(tile_container, LV_ALIGN_CENTER, 0, 15);

    for (i = 0; i < 6; i++) {
        int row = i / 3;
        int col = i % 3;

        lv_obj_t *tile = lv_obj_create(tile_container);
        lv_obj_set_size(tile, 240, 140);
        lv_obj_set_style_bg_color(tile, lv_color_hex(tile_colors[i]), LV_PART_MAIN);
        lv_obj_set_style_bg_opa(tile, LV_OPA_COVER, LV_PART_MAIN);
        lv_obj_set_style_radius(tile, 8, LV_PART_MAIN);
        lv_obj_set_style_shadow_width(tile, 3, LV_PART_MAIN);
        lv_obj_set_style_shadow_color(tile, lv_color_hex(UI_COLOR_BORDER_GRAY), LV_PART_MAIN);
        lv_obj_set_style_shadow_ofs_y(tile, 2, LV_PART_MAIN);
        lv_obj_set_style_border_width(tile, 1, LV_PART_MAIN);
        lv_obj_set_style_border_color(tile, lv_color_hex(UI_COLOR_GOLD), LV_PART_MAIN);
        lv_obj_clear_flag(tile, LV_OBJ_FLAG_SCROLLABLE);
        lv_obj_set_pos(tile, col * 250 + 10, row * 150 + 10);

        lv_obj_t *tile_label = lv_label_create(tile);
        lv_label_set_text(tile_label, tile_labels[i]);
        lv_obj_set_style_text_font(tile_label, &lv_font_montserrat_20, LV_PART_MAIN);
        lv_obj_set_style_text_color(tile_label, lv_color_hex(UI_COLOR_WHITE), LV_PART_MAIN);
        lv_obj_align(tile_label, LV_ALIGN_CENTER, 0, 0);
    }
}
`,
  },
});
handleResult(r, "ebrew-01-menu.png", "ebrew-01-menu.json");

// ========== Screen 2: OVERVIEW (PREHLED) ==========
console.log("\n[2] E-BREW Overview Screen (800x480)");
r = await send("tools/call", {
  name: "lvgl_render_full",
  arguments: {
    code: `#include "lvgl.h"
#include <stdio.h>

#define UI_COLOR_GOLD        0xd4af37
#define UI_COLOR_WHITE       0xffffff
#define UI_COLOR_BLACK       0x000000
#define UI_COLOR_DARK_GRAY   0x2c2c2c
#define UI_COLOR_MEDIUM_GRAY 0x666666

void create_ui(void) {
    lv_obj_t *screen = lv_screen_active();
    int i, y;
    lv_obj_set_style_bg_color(screen, lv_color_hex(UI_COLOR_WHITE), LV_PART_MAIN);

    /* Back button */
    lv_obj_t *back_btn = lv_button_create(screen);
    lv_obj_set_size(back_btn, 100, 40);
    lv_obj_set_style_bg_color(back_btn, lv_color_hex(UI_COLOR_GOLD), LV_PART_MAIN);
    lv_obj_set_style_radius(back_btn, 20, LV_PART_MAIN);
    lv_obj_align(back_btn, LV_ALIGN_TOP_MID, 0, 10);
    lv_obj_t *back_label = lv_label_create(back_btn);
    lv_label_set_text(back_label, LV_SYMBOL_LEFT " ZPET");
    lv_obj_set_style_text_font(back_label, &lv_font_montserrat_14, LV_PART_MAIN);
    lv_obj_set_style_text_color(back_label, lv_color_hex(UI_COLOR_WHITE), LV_PART_MAIN);
    lv_obj_center(back_label);

    lv_obj_t *title = lv_label_create(screen);
    lv_label_set_text(title, "PREHLED");
    lv_obj_set_style_text_font(title, &lv_font_montserrat_20, LV_PART_MAIN);
    lv_obj_set_style_text_color(title, lv_color_hex(UI_COLOR_DARK_GRAY), LV_PART_MAIN);
    lv_obj_align(title, LV_ALIGN_TOP_LEFT, 30, 20);

    lv_obj_t *time_lbl = lv_label_create(screen);
    lv_label_set_text(time_lbl, "14:25");
    lv_obj_set_style_text_font(time_lbl, &lv_font_montserrat_20, LV_PART_MAIN);
    lv_obj_set_style_text_color(time_lbl, lv_color_hex(UI_COLOR_DARK_GRAY), LV_PART_MAIN);
    lv_obj_align(time_lbl, LV_ALIGN_TOP_RIGHT, -20, 20);

    /* Temperature frame (left) */
    lv_obj_t *temp_frame = lv_obj_create(screen);
    lv_obj_set_size(temp_frame, 370, 340);
    lv_obj_set_style_bg_color(temp_frame, lv_color_hex(UI_COLOR_WHITE), LV_PART_MAIN);
    lv_obj_set_style_border_width(temp_frame, 2, LV_PART_MAIN);
    lv_obj_set_style_border_color(temp_frame, lv_color_hex(UI_COLOR_GOLD), LV_PART_MAIN);
    lv_obj_set_style_radius(temp_frame, 5, LV_PART_MAIN);
    lv_obj_clear_flag(temp_frame, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_align(temp_frame, LV_ALIGN_LEFT_MID, 20, 50);

    const char *temp_names[] = {"BOJLER", "KOTEL", "RMUT", "VODA"};
    const char *temp_vals[]  = {"62.3 C", "78.1 C", "65.0 C", "18.5 C"};

    for (i = 0; i < 4; i++) {
        int y_off = 30 + (i * 55);

        lv_obj_t *name = lv_label_create(temp_frame);
        lv_obj_set_style_text_font(name, &lv_font_montserrat_16, LV_PART_MAIN);
        lv_obj_set_style_text_color(name, lv_color_hex(UI_COLOR_GOLD), LV_PART_MAIN);
        lv_obj_align(name, LV_ALIGN_TOP_LEFT, 20, y_off);
        lv_label_set_text(name, temp_names[i]);

        lv_obj_t *val = lv_label_create(temp_frame);
        lv_obj_set_style_text_font(val, &lv_font_montserrat_20, LV_PART_MAIN);
        lv_obj_set_style_text_color(val, lv_color_hex(UI_COLOR_BLACK), LV_PART_MAIN);
        lv_obj_align(val, LV_ALIGN_TOP_RIGHT, -20, y_off);
        lv_label_set_text(val, temp_vals[i]);
    }

    /* Control frame (right) */
    lv_obj_t *ctrl_frame = lv_obj_create(screen);
    lv_obj_set_size(ctrl_frame, 370, 340);
    lv_obj_set_style_bg_color(ctrl_frame, lv_color_hex(UI_COLOR_WHITE), LV_PART_MAIN);
    lv_obj_set_style_border_width(ctrl_frame, 2, LV_PART_MAIN);
    lv_obj_set_style_border_color(ctrl_frame, lv_color_hex(UI_COLOR_GOLD), LV_PART_MAIN);
    lv_obj_set_style_radius(ctrl_frame, 5, LV_PART_MAIN);
    lv_obj_clear_flag(ctrl_frame, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_align(ctrl_frame, LV_ALIGN_RIGHT_MID, -20, 50);

    /* Thermostat BOJLER */
    lv_obj_t *l;
    l = lv_label_create(ctrl_frame);
    lv_label_set_text(l, "Termostat BOJLER");
    lv_obj_set_style_text_font(l, &lv_font_montserrat_14, 0);
    lv_obj_set_style_text_color(l, lv_color_hex(UI_COLOR_GOLD), 0);
    lv_obj_align(l, LV_ALIGN_TOP_LEFT, 15, 15);

    l = lv_label_create(ctrl_frame);
    lv_label_set_text(l, "ZAP");
    lv_obj_set_style_text_font(l, &lv_font_montserrat_20, 0);
    lv_obj_set_style_text_color(l, lv_color_hex(UI_COLOR_BLACK), 0);
    lv_obj_align(l, LV_ALIGN_TOP_RIGHT, -15, 15);

    l = lv_label_create(ctrl_frame);
    lv_label_set_text(l, "Cilova teplota:");
    lv_obj_set_style_text_font(l, &lv_font_montserrat_12, 0);
    lv_obj_set_style_text_color(l, lv_color_hex(0x999999), 0);
    lv_obj_align(l, LV_ALIGN_TOP_LEFT, 25, 40);

    l = lv_label_create(ctrl_frame);
    lv_label_set_text(l, "65.0 C");
    lv_obj_set_style_text_font(l, &lv_font_montserrat_14, 0);
    lv_obj_set_style_text_color(l, lv_color_hex(UI_COLOR_MEDIUM_GRAY), 0);
    lv_obj_align(l, LV_ALIGN_TOP_RIGHT, -15, 40);

    /* Thermostat KOTEL */
    l = lv_label_create(ctrl_frame);
    lv_label_set_text(l, "Termostat KOTEL");
    lv_obj_set_style_text_font(l, &lv_font_montserrat_14, 0);
    lv_obj_set_style_text_color(l, lv_color_hex(UI_COLOR_GOLD), 0);
    lv_obj_align(l, LV_ALIGN_TOP_LEFT, 15, 80);

    l = lv_label_create(ctrl_frame);
    lv_label_set_text(l, "VYP");
    lv_obj_set_style_text_font(l, &lv_font_montserrat_20, 0);
    lv_obj_set_style_text_color(l, lv_color_hex(UI_COLOR_BLACK), 0);
    lv_obj_align(l, LV_ALIGN_TOP_RIGHT, -15, 80);

    l = lv_label_create(ctrl_frame);
    lv_label_set_text(l, "Cilova teplota:");
    lv_obj_set_style_text_font(l, &lv_font_montserrat_12, 0);
    lv_obj_set_style_text_color(l, lv_color_hex(0x999999), 0);
    lv_obj_align(l, LV_ALIGN_TOP_LEFT, 25, 105);

    l = lv_label_create(ctrl_frame);
    lv_label_set_text(l, "80.0 C");
    lv_obj_set_style_text_font(l, &lv_font_montserrat_14, 0);
    lv_obj_set_style_text_color(l, lv_color_hex(UI_COLOR_MEDIUM_GRAY), 0);
    lv_obj_align(l, LV_ALIGN_TOP_RIGHT, -15, 105);

    /* Other controls */
    const char *ctrl_names[] = {"Michani", "Provzdusnovani", "Cerpadlo", "Smer"};
    const char *ctrl_vals[]  = {"VYP", "VYP", "45%", "CW"};
    y = 145;
    for (i = 0; i < 4; i++) {
        l = lv_label_create(ctrl_frame);
        lv_label_set_text(l, ctrl_names[i]);
        lv_obj_set_style_text_font(l, &lv_font_montserrat_14, 0);
        lv_obj_set_style_text_color(l, lv_color_hex(UI_COLOR_GOLD), 0);
        lv_obj_align(l, LV_ALIGN_TOP_LEFT, 15, y);

        l = lv_label_create(ctrl_frame);
        lv_label_set_text(l, ctrl_vals[i]);
        lv_obj_set_style_text_font(l, &lv_font_montserrat_20, 0);
        lv_obj_set_style_text_color(l, lv_color_hex(UI_COLOR_BLACK), 0);
        lv_obj_align(l, LV_ALIGN_TOP_RIGHT, -15, y);

        y += 32;
    }
}
`,
  },
});
handleResult(r, "ebrew-02-overview.png", "ebrew-02-overview.json");

// ========== Screen 3: LOADING ==========
console.log("\n[3] E-BREW Loading Screen (800x480)");
r = await send("tools/call", {
  name: "lvgl_render_full",
  arguments: {
    code: `#include "lvgl.h"

void create_ui(void) {
    lv_obj_t *screen = lv_screen_active();
    lv_obj_set_style_bg_color(screen, lv_color_hex(0xffffff), LV_PART_MAIN);

    /* E-BREW title */
    lv_obj_t *title = lv_label_create(screen);
    lv_label_set_text(title, "E-BREW");
    lv_obj_set_style_text_font(title, &lv_font_montserrat_24, LV_PART_MAIN);
    lv_obj_set_style_text_color(title, lv_color_hex(0xd4af37), LV_PART_MAIN);
    lv_obj_align(title, LV_ALIGN_CENTER, 0, -50);

    /* Loading text */
    lv_obj_t *loading_text = lv_label_create(screen);
    lv_label_set_text(loading_text, "Inicializace...");
    lv_obj_set_style_text_font(loading_text, &lv_font_montserrat_16, LV_PART_MAIN);
    lv_obj_set_style_text_color(loading_text, lv_color_hex(0x666666), LV_PART_MAIN);
    lv_obj_align(loading_text, LV_ALIGN_CENTER, 0, 20);

    /* Progress bar */
    lv_obj_t *bar = lv_bar_create(screen);
    lv_obj_set_size(bar, 300, 20);
    lv_obj_set_style_bg_color(bar, lv_color_hex(0xe0e0e0), LV_PART_MAIN);
    lv_obj_set_style_bg_color(bar, lv_color_hex(0xd4af37), LV_PART_INDICATOR);
    lv_obj_align(bar, LV_ALIGN_CENTER, 0, 60);
    lv_bar_set_value(bar, 45, LV_ANIM_OFF);
}
`,
  },
});
handleResult(r, "ebrew-03-loading.png", "ebrew-03-loading.json");

// ========== Screen 4: PUMP (CERPADLO) ==========
console.log("\n[4] E-BREW Pump Screen (800x480)");
r = await send("tools/call", {
  name: "lvgl_render_full",
  arguments: {
    code: `#include "lvgl.h"

void create_ui(void) {
    lv_obj_t *screen = lv_screen_active();
    int i;
    lv_obj_set_style_bg_color(screen, lv_color_hex(0xffffff), LV_PART_MAIN);

    /* Back button */
    lv_obj_t *back_btn = lv_button_create(screen);
    lv_obj_set_size(back_btn, 100, 40);
    lv_obj_set_style_bg_color(back_btn, lv_color_hex(0xd4af37), LV_PART_MAIN);
    lv_obj_set_style_radius(back_btn, 20, LV_PART_MAIN);
    lv_obj_align(back_btn, LV_ALIGN_TOP_MID, 0, 10);
    lv_obj_t *back_label = lv_label_create(back_btn);
    lv_label_set_text(back_label, LV_SYMBOL_LEFT " ZPET");
    lv_obj_set_style_text_font(back_label, &lv_font_montserrat_14, LV_PART_MAIN);
    lv_obj_set_style_text_color(back_label, lv_color_hex(0xffffff), LV_PART_MAIN);
    lv_obj_center(back_label);

    /* Title */
    lv_obj_t *title = lv_label_create(screen);
    lv_label_set_text(title, "CERPADLO");
    lv_obj_set_style_text_font(title, &lv_font_montserrat_20, LV_PART_MAIN);
    lv_obj_set_style_text_color(title, lv_color_hex(0x2c2c2c), LV_PART_MAIN);
    lv_obj_align(title, LV_ALIGN_TOP_LEFT, 30, 20);

    /* Time */
    lv_obj_t *time_lbl = lv_label_create(screen);
    lv_label_set_text(time_lbl, "14:25");
    lv_obj_set_style_text_font(time_lbl, &lv_font_montserrat_20, LV_PART_MAIN);
    lv_obj_set_style_text_color(time_lbl, lv_color_hex(0x2c2c2c), LV_PART_MAIN);
    lv_obj_align(time_lbl, LV_ALIGN_TOP_RIGHT, -20, 20);

    /* Status */
    lv_obj_t *status_lbl = lv_label_create(screen);
    lv_label_set_text(status_lbl, "Stav:");
    lv_obj_set_style_text_font(status_lbl, &lv_font_montserrat_14, LV_PART_MAIN);
    lv_obj_set_style_text_color(status_lbl, lv_color_hex(0x666666), LV_PART_MAIN);
    lv_obj_align(status_lbl, LV_ALIGN_TOP_MID, -100, 90);

    lv_obj_t *status_val = lv_label_create(screen);
    lv_label_set_text(status_val, "VLEVO");
    lv_obj_set_style_text_font(status_val, &lv_font_montserrat_20, LV_PART_MAIN);
    lv_obj_set_style_text_color(status_val, lv_color_hex(0xd4af37), LV_PART_MAIN);
    lv_obj_align(status_val, LV_ALIGN_TOP_MID, 20, 88);

    /* Speed */
    lv_obj_t *speed_lbl = lv_label_create(screen);
    lv_label_set_text(speed_lbl, "Rychlost:");
    lv_obj_set_style_text_font(speed_lbl, &lv_font_montserrat_14, LV_PART_MAIN);
    lv_obj_set_style_text_color(speed_lbl, lv_color_hex(0x666666), LV_PART_MAIN);
    lv_obj_align(speed_lbl, LV_ALIGN_TOP_MID, -100, 125);

    lv_obj_t *speed_val = lv_label_create(screen);
    lv_label_set_text(speed_val, "45%");
    lv_obj_set_style_text_font(speed_val, &lv_font_montserrat_20, LV_PART_MAIN);
    lv_obj_set_style_text_color(speed_val, lv_color_hex(0x4a90e2), LV_PART_MAIN);
    lv_obj_align(speed_val, LV_ALIGN_TOP_MID, 20, 123);

    /* Speed slider (blue style) */
    lv_obj_t *slider = lv_slider_create(screen);
    lv_obj_set_size(slider, 500, 20);
    lv_slider_set_range(slider, 0, 100);
    lv_slider_set_value(slider, 45, LV_ANIM_OFF);
    lv_obj_align(slider, LV_ALIGN_TOP_MID, 0, 165);
    /* Blue slider style */
    lv_obj_set_style_bg_color(slider, lv_color_hex(0xe0e0e0), LV_PART_MAIN);
    lv_obj_set_style_radius(slider, 5, LV_PART_MAIN);
    lv_obj_set_style_bg_color(slider, lv_color_hex(0x4a90e2), LV_PART_INDICATOR);
    lv_obj_set_style_radius(slider, 5, LV_PART_INDICATOR);
    lv_obj_set_style_bg_color(slider, lv_color_hex(0xffffff), LV_PART_KNOB);
    lv_obj_set_style_border_color(slider, lv_color_hex(0x4a90e2), LV_PART_KNOB);
    lv_obj_set_style_border_width(slider, 2, LV_PART_KNOB);
    lv_obj_set_style_pad_all(slider, 6, LV_PART_KNOB);

    /* Min/Max labels */
    lv_obj_t *min_lbl = lv_label_create(screen);
    lv_label_set_text(min_lbl, "0");
    lv_obj_set_style_text_font(min_lbl, &lv_font_montserrat_12, LV_PART_MAIN);
    lv_obj_set_style_text_color(min_lbl, lv_color_hex(0x666666), LV_PART_MAIN);
    lv_obj_align_to(min_lbl, slider, LV_ALIGN_OUT_LEFT_MID, -5, 0);

    lv_obj_t *max_lbl = lv_label_create(screen);
    lv_label_set_text(max_lbl, "100");
    lv_obj_set_style_text_font(max_lbl, &lv_font_montserrat_12, LV_PART_MAIN);
    lv_obj_set_style_text_color(max_lbl, lv_color_hex(0x666666), LV_PART_MAIN);
    lv_obj_align_to(max_lbl, slider, LV_ALIGN_OUT_RIGHT_MID, 5, 0);

    /* Control buttons: STOP, VLEVO, VPRAVO */
    const char *btn_labels[] = {"STOP", "VLEVO", "VPRAVO"};
    const uint32_t btn_colors[] = {0xcc0000, 0x4a90e2, 0x4CAF50};
    const int btn_opas[] = {255, 150, 255};

    for (i = 0; i < 3; i++) {
        int x = -200 + (i * 200);
        lv_obj_t *btn = lv_button_create(screen);
        lv_obj_set_size(btn, 180, 80);
        lv_obj_set_style_bg_color(btn, lv_color_hex(btn_colors[i]), LV_PART_MAIN);
        lv_obj_set_style_bg_opa(btn, btn_opas[i], LV_PART_MAIN);
        lv_obj_set_style_radius(btn, 15, LV_PART_MAIN);
        lv_obj_set_style_shadow_width(btn, 8, LV_PART_MAIN);
        lv_obj_set_style_shadow_color(btn, lv_color_hex(0x888888), LV_PART_MAIN);
        lv_obj_align(btn, LV_ALIGN_CENTER, x, 100);

        lv_obj_t *lbl = lv_label_create(btn);
        lv_label_set_text(lbl, btn_labels[i]);
        lv_obj_set_style_text_font(lbl, &lv_font_montserrat_20, LV_PART_MAIN);
        lv_obj_set_style_text_color(lbl, lv_color_hex(0xffffff), LV_PART_MAIN);
        lv_obj_center(lbl);
    }
}
`,
  },
});
handleResult(r, "ebrew-04-pump.png", "ebrew-04-pump.json");

// ========== Screen 5: CONTROL (OVLADANI) ==========
console.log("\n[5] E-BREW Control Screen (800x480)");
r = await send("tools/call", {
  name: "lvgl_render_full",
  arguments: {
    code: `#include "lvgl.h"

void create_ui(void) {
    lv_obj_t *screen = lv_screen_active();
    int i;
    lv_obj_set_style_bg_color(screen, lv_color_hex(0xffffff), LV_PART_MAIN);

    /* Back button */
    lv_obj_t *back_btn = lv_button_create(screen);
    lv_obj_set_size(back_btn, 100, 40);
    lv_obj_set_style_bg_color(back_btn, lv_color_hex(0xd4af37), LV_PART_MAIN);
    lv_obj_set_style_radius(back_btn, 20, LV_PART_MAIN);
    lv_obj_align(back_btn, LV_ALIGN_TOP_MID, 0, 10);
    lv_obj_t *back_label = lv_label_create(back_btn);
    lv_label_set_text(back_label, LV_SYMBOL_LEFT " ZPET");
    lv_obj_set_style_text_font(back_label, &lv_font_montserrat_14, LV_PART_MAIN);
    lv_obj_set_style_text_color(back_label, lv_color_hex(0xffffff), LV_PART_MAIN);
    lv_obj_center(back_label);

    /* Title */
    lv_obj_t *title = lv_label_create(screen);
    lv_label_set_text(title, "OVLADANI");
    lv_obj_set_style_text_font(title, &lv_font_montserrat_20, LV_PART_MAIN);
    lv_obj_set_style_text_color(title, lv_color_hex(0x2c2c2c), LV_PART_MAIN);
    lv_obj_align(title, LV_ALIGN_TOP_LEFT, 30, 20);

    /* Time */
    lv_obj_t *time_lbl = lv_label_create(screen);
    lv_label_set_text(time_lbl, "14:25");
    lv_obj_set_style_text_font(time_lbl, &lv_font_montserrat_20, LV_PART_MAIN);
    lv_obj_set_style_text_color(time_lbl, lv_color_hex(0x2c2c2c), LV_PART_MAIN);
    lv_obj_align(time_lbl, LV_ALIGN_TOP_RIGHT, -20, 20);

    /* 3 relay control cards */
    const char *labels[] = {"Michani", "Ventilator", "Prorezavani"};

    for (i = 0; i < 3; i++) {
        lv_obj_t *card = lv_obj_create(screen);
        lv_obj_set_size(card, 700, 80);
        /* Card style */
        lv_obj_set_style_bg_color(card, lv_color_hex(0xffffff), LV_PART_MAIN);
        lv_obj_set_style_border_color(card, lv_color_hex(0xd4af37), LV_PART_MAIN);
        lv_obj_set_style_border_width(card, 2, LV_PART_MAIN);
        lv_obj_set_style_radius(card, 10, LV_PART_MAIN);
        lv_obj_set_style_pad_all(card, 15, LV_PART_MAIN);
        lv_obj_align(card, LV_ALIGN_TOP_MID, 0, 80 + i * 100);
        lv_obj_clear_flag(card, LV_OBJ_FLAG_SCROLLABLE);

        lv_obj_t *lbl = lv_label_create(card);
        lv_label_set_text(lbl, labels[i]);
        lv_obj_set_style_text_font(lbl, &lv_font_montserrat_20, LV_PART_MAIN);
        lv_obj_set_style_text_color(lbl, lv_color_hex(0xd4af37), LV_PART_MAIN);
        lv_obj_align(lbl, LV_ALIGN_LEFT_MID, 20, 0);

        lv_obj_t *sw = lv_switch_create(card);
        lv_obj_align(sw, LV_ALIGN_RIGHT_MID, -20, 0);
        lv_obj_set_size(sw, 80, 40);
        /* Switch style */
        lv_obj_set_style_bg_color(sw, lv_color_hex(0xe0e0e0), LV_PART_MAIN);
        lv_obj_set_style_border_color(sw, lv_color_hex(0xd4af37), LV_PART_MAIN);
        lv_obj_set_style_border_width(sw, 2, LV_PART_MAIN);
        lv_obj_set_style_bg_color(sw, lv_color_hex(0xd4af37), LV_PART_INDICATOR | LV_STATE_CHECKED);
        lv_obj_set_style_bg_color(sw, lv_color_hex(0xffffff), LV_PART_KNOB);

        /* Turn on first switch for demo */
        if (i == 0) lv_obj_add_state(sw, LV_STATE_CHECKED);
    }
}
`,
  },
});
handleResult(r, "ebrew-05-control.png", "ebrew-05-control.json");

// ========== Screen 6: THERMOSTATS (TERMOSTATY) ==========
console.log("\n[6] E-BREW Thermostats Screen (800x480)");
r = await send("tools/call", {
  name: "lvgl_render_full",
  arguments: {
    code: `#include "lvgl.h"

void create_ui(void) {
    lv_obj_t *screen = lv_screen_active();
    lv_obj_set_style_bg_color(screen, lv_color_hex(0xffffff), LV_PART_MAIN);

    /* Back button */
    lv_obj_t *back_btn = lv_button_create(screen);
    lv_obj_set_size(back_btn, 100, 40);
    lv_obj_set_style_bg_color(back_btn, lv_color_hex(0xd4af37), LV_PART_MAIN);
    lv_obj_set_style_radius(back_btn, 20, LV_PART_MAIN);
    lv_obj_align(back_btn, LV_ALIGN_TOP_MID, 0, 10);
    lv_obj_t *back_label = lv_label_create(back_btn);
    lv_label_set_text(back_label, LV_SYMBOL_LEFT " ZPET");
    lv_obj_set_style_text_font(back_label, &lv_font_montserrat_14, LV_PART_MAIN);
    lv_obj_set_style_text_color(back_label, lv_color_hex(0xffffff), LV_PART_MAIN);
    lv_obj_center(back_label);

    /* Title */
    lv_obj_t *title = lv_label_create(screen);
    lv_label_set_text(title, "TERMOSTATY");
    lv_obj_set_style_text_font(title, &lv_font_montserrat_20, LV_PART_MAIN);
    lv_obj_set_style_text_color(title, lv_color_hex(0x2c2c2c), LV_PART_MAIN);
    lv_obj_align(title, LV_ALIGN_TOP_LEFT, 30, 20);

    /* Time */
    lv_obj_t *time_lbl = lv_label_create(screen);
    lv_label_set_text(time_lbl, "14:25");
    lv_obj_set_style_text_font(time_lbl, &lv_font_montserrat_20, LV_PART_MAIN);
    lv_obj_set_style_text_color(time_lbl, lv_color_hex(0x2c2c2c), LV_PART_MAIN);
    lv_obj_align(time_lbl, LV_ALIGN_TOP_RIGHT, -20, 20);

    /* ====== BOJLER Card (left) ====== */
    lv_obj_t *bojler_card = lv_obj_create(screen);
    lv_obj_set_size(bojler_card, 370, 340);
    lv_obj_set_style_bg_color(bojler_card, lv_color_hex(0xffffff), LV_PART_MAIN);
    lv_obj_set_style_border_color(bojler_card, lv_color_hex(0xd4af37), LV_PART_MAIN);
    lv_obj_set_style_border_width(bojler_card, 2, LV_PART_MAIN);
    lv_obj_set_style_radius(bojler_card, 10, LV_PART_MAIN);
    lv_obj_set_style_pad_all(bojler_card, 15, LV_PART_MAIN);
    lv_obj_align(bojler_card, LV_ALIGN_LEFT_MID, 20, 50);
    lv_obj_clear_flag(bojler_card, LV_OBJ_FLAG_SCROLLABLE);

    lv_obj_t *l;
    l = lv_label_create(bojler_card);
    lv_label_set_text(l, "BOJLER");
    lv_obj_set_style_text_font(l, &lv_font_montserrat_20, 0);
    lv_obj_set_style_text_color(l, lv_color_hex(0xd4af37), 0);
    lv_obj_align(l, LV_ALIGN_TOP_LEFT, 10, 5);

    /* Bojler switch (ON) */
    lv_obj_t *b_sw = lv_switch_create(bojler_card);
    lv_obj_align(b_sw, LV_ALIGN_TOP_RIGHT, -10, 5);
    lv_obj_set_style_bg_color(b_sw, lv_color_hex(0xe0e0e0), LV_PART_MAIN);
    lv_obj_set_style_border_color(b_sw, lv_color_hex(0xd4af37), LV_PART_MAIN);
    lv_obj_set_style_border_width(b_sw, 2, LV_PART_MAIN);
    lv_obj_set_style_bg_color(b_sw, lv_color_hex(0xd4af37), LV_PART_INDICATOR | LV_STATE_CHECKED);
    lv_obj_set_style_bg_color(b_sw, lv_color_hex(0xffffff), LV_PART_KNOB);
    lv_obj_add_state(b_sw, LV_STATE_CHECKED);

    /* Heating indicator (green = heating) */
    lv_obj_t *b_ind = lv_obj_create(bojler_card);
    lv_obj_set_size(b_ind, 20, 20);
    lv_obj_set_style_radius(b_ind, 10, LV_PART_MAIN);
    lv_obj_set_style_bg_color(b_ind, lv_color_hex(0x4CAF50), LV_PART_MAIN);
    lv_obj_set_style_border_width(b_ind, 0, LV_PART_MAIN);
    lv_obj_align(b_ind, LV_ALIGN_TOP_RIGHT, -70, 8);

    /* Current temp */
    l = lv_label_create(bojler_card);
    lv_label_set_text(l, "Aktualni:");
    lv_obj_set_style_text_font(l, &lv_font_montserrat_14, 0);
    lv_obj_align(l, LV_ALIGN_TOP_LEFT, 10, 50);

    l = lv_label_create(bojler_card);
    lv_label_set_text(l, "62.3 C");
    lv_obj_set_style_text_font(l, &lv_font_montserrat_24, 0);
    lv_obj_set_style_text_color(l, lv_color_hex(0x000000), 0);
    lv_obj_align(l, LV_ALIGN_TOP_RIGHT, -10, 45);

    /* Target temp */
    l = lv_label_create(bojler_card);
    lv_label_set_text(l, "Cilova:");
    lv_obj_set_style_text_font(l, &lv_font_montserrat_14, 0);
    lv_obj_align(l, LV_ALIGN_TOP_LEFT, 10, 100);

    l = lv_label_create(bojler_card);
    lv_label_set_text(l, "65.0 C");
    lv_obj_set_style_text_font(l, &lv_font_montserrat_20, 0);
    lv_obj_set_style_text_color(l, lv_color_hex(0xd4af37), 0);
    lv_obj_align(l, LV_ALIGN_TOP_RIGHT, -10, 98);

    /* Bojler slider (gold style, range 30-90) */
    lv_obj_t *b_slider = lv_slider_create(bojler_card);
    lv_obj_set_size(b_slider, 300, 20);
    lv_slider_set_range(b_slider, 30, 90);
    lv_slider_set_value(b_slider, 65, LV_ANIM_OFF);
    lv_obj_align(b_slider, LV_ALIGN_TOP_MID, 0, 150);
    lv_obj_set_style_bg_color(b_slider, lv_color_hex(0xe0e0e0), LV_PART_MAIN);
    lv_obj_set_style_radius(b_slider, 5, LV_PART_MAIN);
    lv_obj_set_style_bg_color(b_slider, lv_color_hex(0xd4af37), LV_PART_INDICATOR);
    lv_obj_set_style_radius(b_slider, 5, LV_PART_INDICATOR);
    lv_obj_set_style_bg_color(b_slider, lv_color_hex(0xffffff), LV_PART_KNOB);
    lv_obj_set_style_border_color(b_slider, lv_color_hex(0xd4af37), LV_PART_KNOB);
    lv_obj_set_style_border_width(b_slider, 2, LV_PART_KNOB);
    lv_obj_set_style_pad_all(b_slider, 6, LV_PART_KNOB);

    /* ====== KOTEL Card (right) ====== */
    lv_obj_t *kotel_card = lv_obj_create(screen);
    lv_obj_set_size(kotel_card, 370, 340);
    lv_obj_set_style_bg_color(kotel_card, lv_color_hex(0xffffff), LV_PART_MAIN);
    lv_obj_set_style_border_color(kotel_card, lv_color_hex(0xd4af37), LV_PART_MAIN);
    lv_obj_set_style_border_width(kotel_card, 2, LV_PART_MAIN);
    lv_obj_set_style_radius(kotel_card, 10, LV_PART_MAIN);
    lv_obj_set_style_pad_all(kotel_card, 15, LV_PART_MAIN);
    lv_obj_align(kotel_card, LV_ALIGN_RIGHT_MID, -20, 50);
    lv_obj_clear_flag(kotel_card, LV_OBJ_FLAG_SCROLLABLE);

    l = lv_label_create(kotel_card);
    lv_label_set_text(l, "KOTEL");
    lv_obj_set_style_text_font(l, &lv_font_montserrat_20, 0);
    lv_obj_set_style_text_color(l, lv_color_hex(0xd4af37), 0);
    lv_obj_align(l, LV_ALIGN_TOP_LEFT, 10, 5);

    /* Kotel switch (OFF) */
    lv_obj_t *k_sw = lv_switch_create(kotel_card);
    lv_obj_align(k_sw, LV_ALIGN_TOP_RIGHT, -10, 5);
    lv_obj_set_style_bg_color(k_sw, lv_color_hex(0xe0e0e0), LV_PART_MAIN);
    lv_obj_set_style_border_color(k_sw, lv_color_hex(0xd4af37), LV_PART_MAIN);
    lv_obj_set_style_border_width(k_sw, 2, LV_PART_MAIN);
    lv_obj_set_style_bg_color(k_sw, lv_color_hex(0xd4af37), LV_PART_INDICATOR | LV_STATE_CHECKED);
    lv_obj_set_style_bg_color(k_sw, lv_color_hex(0xffffff), LV_PART_KNOB);

    /* Heating indicator (gray = not heating) */
    lv_obj_t *k_ind = lv_obj_create(kotel_card);
    lv_obj_set_size(k_ind, 20, 20);
    lv_obj_set_style_radius(k_ind, 10, LV_PART_MAIN);
    lv_obj_set_style_bg_color(k_ind, lv_color_hex(0xcccccc), LV_PART_MAIN);
    lv_obj_set_style_border_width(k_ind, 0, LV_PART_MAIN);
    lv_obj_align(k_ind, LV_ALIGN_TOP_RIGHT, -70, 8);

    /* Current temp */
    l = lv_label_create(kotel_card);
    lv_label_set_text(l, "Aktualni:");
    lv_obj_set_style_text_font(l, &lv_font_montserrat_14, 0);
    lv_obj_align(l, LV_ALIGN_TOP_LEFT, 10, 50);

    l = lv_label_create(kotel_card);
    lv_label_set_text(l, "45.7 C");
    lv_obj_set_style_text_font(l, &lv_font_montserrat_24, 0);
    lv_obj_set_style_text_color(l, lv_color_hex(0x000000), 0);
    lv_obj_align(l, LV_ALIGN_TOP_RIGHT, -10, 45);

    /* Target temp */
    l = lv_label_create(kotel_card);
    lv_label_set_text(l, "Cilova:");
    lv_obj_set_style_text_font(l, &lv_font_montserrat_14, 0);
    lv_obj_align(l, LV_ALIGN_TOP_LEFT, 10, 100);

    l = lv_label_create(kotel_card);
    lv_label_set_text(l, "70.0 C");
    lv_obj_set_style_text_font(l, &lv_font_montserrat_20, 0);
    lv_obj_set_style_text_color(l, lv_color_hex(0xd4af37), 0);
    lv_obj_align(l, LV_ALIGN_TOP_RIGHT, -10, 98);

    /* Kotel temp slider (gold style, range 30-100) */
    lv_obj_t *k_slider = lv_slider_create(kotel_card);
    lv_obj_set_size(k_slider, 300, 20);
    lv_slider_set_range(k_slider, 30, 100);
    lv_slider_set_value(k_slider, 70, LV_ANIM_OFF);
    lv_obj_align(k_slider, LV_ALIGN_TOP_MID, 0, 140);
    lv_obj_set_style_bg_color(k_slider, lv_color_hex(0xe0e0e0), LV_PART_MAIN);
    lv_obj_set_style_radius(k_slider, 5, LV_PART_MAIN);
    lv_obj_set_style_bg_color(k_slider, lv_color_hex(0xd4af37), LV_PART_INDICATOR);
    lv_obj_set_style_radius(k_slider, 5, LV_PART_INDICATOR);
    lv_obj_set_style_bg_color(k_slider, lv_color_hex(0xffffff), LV_PART_KNOB);
    lv_obj_set_style_border_color(k_slider, lv_color_hex(0xd4af37), LV_PART_KNOB);
    lv_obj_set_style_border_width(k_slider, 2, LV_PART_KNOB);
    lv_obj_set_style_pad_all(k_slider, 6, LV_PART_KNOB);

    /* Power label */
    l = lv_label_create(kotel_card);
    lv_label_set_text(l, "Vykon:");
    lv_obj_set_style_text_font(l, &lv_font_montserrat_14, 0);
    lv_obj_align(l, LV_ALIGN_TOP_LEFT, 10, 190);

    l = lv_label_create(kotel_card);
    lv_label_set_text(l, "80%");
    lv_obj_set_style_text_font(l, &lv_font_montserrat_20, 0);
    lv_obj_set_style_text_color(l, lv_color_hex(0x4CAF50), 0);
    lv_obj_align(l, LV_ALIGN_TOP_RIGHT, -10, 188);

    /* Power slider (green style, range 0-100) */
    lv_obj_t *p_slider = lv_slider_create(kotel_card);
    lv_obj_set_size(p_slider, 300, 20);
    lv_slider_set_range(p_slider, 0, 100);
    lv_slider_set_value(p_slider, 80, LV_ANIM_OFF);
    lv_obj_align(p_slider, LV_ALIGN_TOP_MID, 0, 230);
    lv_obj_set_style_bg_color(p_slider, lv_color_hex(0xe0e0e0), LV_PART_MAIN);
    lv_obj_set_style_radius(p_slider, 5, LV_PART_MAIN);
    lv_obj_set_style_bg_color(p_slider, lv_color_hex(0x4CAF50), LV_PART_INDICATOR);
    lv_obj_set_style_radius(p_slider, 5, LV_PART_INDICATOR);
    lv_obj_set_style_bg_color(p_slider, lv_color_hex(0xffffff), LV_PART_KNOB);
    lv_obj_set_style_border_color(p_slider, lv_color_hex(0x4CAF50), LV_PART_KNOB);
    lv_obj_set_style_border_width(p_slider, 2, LV_PART_KNOB);
    lv_obj_set_style_pad_all(p_slider, 6, LV_PART_KNOB);
}
`,
  },
});
handleResult(r, "ebrew-06-thermostats.png", "ebrew-06-thermostats.json");

// ========== Screen 7: GRAPHS (GRAFY) ==========
console.log("\n[7] E-BREW Graphs Screen (800x480)");
r = await send("tools/call", {
  name: "lvgl_render_full",
  arguments: {
    code: `#include "lvgl.h"

void create_ui(void) {
    lv_obj_t *screen = lv_screen_active();
    int i;
    lv_obj_set_style_bg_color(screen, lv_color_hex(0xffffff), LV_PART_MAIN);

    /* Back button */
    lv_obj_t *back_btn = lv_button_create(screen);
    lv_obj_set_size(back_btn, 100, 40);
    lv_obj_set_style_bg_color(back_btn, lv_color_hex(0xd4af37), LV_PART_MAIN);
    lv_obj_set_style_radius(back_btn, 20, LV_PART_MAIN);
    lv_obj_align(back_btn, LV_ALIGN_TOP_MID, 0, 10);
    lv_obj_t *back_label = lv_label_create(back_btn);
    lv_label_set_text(back_label, LV_SYMBOL_LEFT " ZPET");
    lv_obj_set_style_text_font(back_label, &lv_font_montserrat_14, LV_PART_MAIN);
    lv_obj_set_style_text_color(back_label, lv_color_hex(0xffffff), LV_PART_MAIN);
    lv_obj_center(back_label);

    /* Title */
    lv_obj_t *title = lv_label_create(screen);
    lv_label_set_text(title, "GRAFY");
    lv_obj_set_style_text_font(title, &lv_font_montserrat_20, LV_PART_MAIN);
    lv_obj_set_style_text_color(title, lv_color_hex(0x2c2c2c), LV_PART_MAIN);
    lv_obj_align(title, LV_ALIGN_TOP_LEFT, 30, 20);

    /* Time */
    lv_obj_t *time_lbl = lv_label_create(screen);
    lv_label_set_text(time_lbl, "14:25");
    lv_obj_set_style_text_font(time_lbl, &lv_font_montserrat_20, LV_PART_MAIN);
    lv_obj_set_style_text_color(time_lbl, lv_color_hex(0x2c2c2c), LV_PART_MAIN);
    lv_obj_align(time_lbl, LV_ALIGN_TOP_RIGHT, -20, 20);

    /* Chart */
    lv_obj_t *chart = lv_chart_create(screen);
    lv_obj_set_size(chart, 700, 300);
    lv_obj_align(chart, LV_ALIGN_CENTER, 0, 30);
    lv_chart_set_type(chart, LV_CHART_TYPE_LINE);
    lv_chart_set_range(chart, LV_CHART_AXIS_PRIMARY_Y, 0, 100);
    lv_chart_set_point_count(chart, 20);
    lv_chart_set_div_line_count(chart, 5, 5);

    lv_obj_set_style_bg_color(chart, lv_color_hex(0xffffff), LV_PART_MAIN);
    lv_obj_set_style_border_color(chart, lv_color_hex(0xd4af37), LV_PART_MAIN);
    lv_obj_set_style_border_width(chart, 2, LV_PART_MAIN);

    /* 4 series: Hlavni(red), Rmut(gold), Bojler(blue), Okoli(green) */
    lv_chart_series_t *s_main = lv_chart_add_series(chart, lv_color_hex(0xF44336), LV_CHART_AXIS_PRIMARY_Y);
    lv_chart_series_t *s_mash = lv_chart_add_series(chart, lv_color_hex(0xd4af37), LV_CHART_AXIS_PRIMARY_Y);
    lv_chart_series_t *s_boil = lv_chart_add_series(chart, lv_color_hex(0x4a90e2), LV_CHART_AXIS_PRIMARY_Y);
    lv_chart_series_t *s_amb  = lv_chart_add_series(chart, lv_color_hex(0x4CAF50), LV_CHART_AXIS_PRIMARY_Y);

    /* Mock data - simulated brewing temperatures */
    int16_t main_data[] = {65,66,67,68,70,72,74,75,76,77,78,78,78,77,76,75,74,73,72,71};
    int16_t mash_data[] = {60,61,62,63,64,65,66,66,65,65,64,64,63,63,62,62,61,61,60,60};
    int16_t boil_data[] = {55,56,57,58,59,60,61,62,62,63,63,63,62,62,61,61,60,60,59,59};
    int16_t amb_data[]  = {22,22,22,23,23,23,23,24,24,24,24,24,24,23,23,23,23,22,22,22};

    for (i = 0; i < 20; i++) {
        lv_chart_set_value_by_id(chart, s_main, i, main_data[i]);
        lv_chart_set_value_by_id(chart, s_mash, i, mash_data[i]);
        lv_chart_set_value_by_id(chart, s_boil, i, boil_data[i]);
        lv_chart_set_value_by_id(chart, s_amb, i, amb_data[i]);
    }
    lv_chart_refresh(chart);

    /* Legend */
    lv_obj_t *legend = lv_obj_create(screen);
    lv_obj_set_size(legend, 700, 30);
    lv_obj_set_style_bg_opa(legend, 0, LV_PART_MAIN);
    lv_obj_set_style_border_width(legend, 0, LV_PART_MAIN);
    lv_obj_align(legend, LV_ALIGN_BOTTOM_MID, 0, -60);

    const char *legend_labels[] = {"Hlavni", "Rmut", "Bojler", "Okoli"};
    const uint32_t legend_colors[] = {0xF44336, 0xd4af37, 0x4a90e2, 0x4CAF50};

    for (i = 0; i < 4; i++) {
        lv_obj_t *dot = lv_obj_create(legend);
        lv_obj_set_size(dot, 12, 12);
        lv_obj_set_style_radius(dot, 6, LV_PART_MAIN);
        lv_obj_set_style_bg_color(dot, lv_color_hex(legend_colors[i]), LV_PART_MAIN);
        lv_obj_set_style_border_width(dot, 0, LV_PART_MAIN);
        lv_obj_align(dot, LV_ALIGN_LEFT_MID, i * 170 + 10, 0);

        lv_obj_t *lbl = lv_label_create(legend);
        lv_label_set_text(lbl, legend_labels[i]);
        lv_obj_set_style_text_font(lbl, &lv_font_montserrat_14, LV_PART_MAIN);
        lv_obj_align(lbl, LV_ALIGN_LEFT_MID, i * 170 + 30, 0);
    }

    /* Current temps */
    lv_obj_t *temps = lv_label_create(screen);
    lv_label_set_text(temps, "Aktualni: Hlavni 71 C | Rmut 60 C | Bojler 59 C | Okoli 22 C");
    lv_obj_set_style_text_font(temps, &lv_font_montserrat_14, LV_PART_MAIN);
    lv_obj_align(temps, LV_ALIGN_BOTTOM_MID, 0, -30);
}
`,
  },
});
handleResult(r, "ebrew-07-graphs.png", "ebrew-07-graphs.json");

// ========== Screen 8: SYSTEM INFO ==========
console.log("\n[8] E-BREW System Info Screen (800x480)");
r = await send("tools/call", {
  name: "lvgl_render_full",
  arguments: {
    code: `#include "lvgl.h"

void create_ui(void) {
    lv_obj_t *screen = lv_screen_active();
    int y;
    lv_obj_set_style_bg_color(screen, lv_color_hex(0xffffff), LV_PART_MAIN);

    /* Back button */
    lv_obj_t *back_btn = lv_button_create(screen);
    lv_obj_set_size(back_btn, 100, 40);
    lv_obj_set_style_bg_color(back_btn, lv_color_hex(0xd4af37), LV_PART_MAIN);
    lv_obj_set_style_radius(back_btn, 20, LV_PART_MAIN);
    lv_obj_align(back_btn, LV_ALIGN_TOP_MID, 0, 10);
    lv_obj_t *back_label = lv_label_create(back_btn);
    lv_label_set_text(back_label, LV_SYMBOL_LEFT " ZPET");
    lv_obj_set_style_text_font(back_label, &lv_font_montserrat_14, LV_PART_MAIN);
    lv_obj_set_style_text_color(back_label, lv_color_hex(0xffffff), LV_PART_MAIN);
    lv_obj_center(back_label);

    /* Title */
    lv_obj_t *title = lv_label_create(screen);
    lv_label_set_text(title, "SYSTEM INFO");
    lv_obj_set_style_text_font(title, &lv_font_montserrat_20, LV_PART_MAIN);
    lv_obj_set_style_text_color(title, lv_color_hex(0x2c2c2c), LV_PART_MAIN);
    lv_obj_align(title, LV_ALIGN_TOP_LEFT, 30, 20);

    /* Time */
    lv_obj_t *time_lbl = lv_label_create(screen);
    lv_label_set_text(time_lbl, "14:25");
    lv_obj_set_style_text_font(time_lbl, &lv_font_montserrat_20, LV_PART_MAIN);
    lv_obj_set_style_text_color(time_lbl, lv_color_hex(0x2c2c2c), LV_PART_MAIN);
    lv_obj_align(time_lbl, LV_ALIGN_TOP_RIGHT, -20, 20);

    /* Info frame (card style) */
    lv_obj_t *frame = lv_obj_create(screen);
    lv_obj_set_size(frame, 700, 300);
    lv_obj_set_style_bg_color(frame, lv_color_hex(0xffffff), LV_PART_MAIN);
    lv_obj_set_style_border_color(frame, lv_color_hex(0xd4af37), LV_PART_MAIN);
    lv_obj_set_style_border_width(frame, 2, LV_PART_MAIN);
    lv_obj_set_style_radius(frame, 10, LV_PART_MAIN);
    lv_obj_set_style_pad_all(frame, 15, LV_PART_MAIN);
    lv_obj_align(frame, LV_ALIGN_CENTER, 0, 20);
    lv_obj_clear_flag(frame, LV_OBJ_FLAG_SCROLLABLE);

    y = 10;

    /* Row helper: label + value */
    const char *row_labels[] = {
        "Display FW:", "Controller FW:", "WiFi Mode:",
        "MAC:", "SSID:", "IP:", "mDNS:"
    };
    const char *row_values[] = {
        "1.0.0", "2.3.1", "Station",
        "AA:BB:CC:DD:EE:FF", "Pivovar", "192.168.1.42", "ebrew.local"
    };
    const uint32_t val_colors[] = {
        0x000000, 0x000000, 0x4CAF50,
        0x000000, 0x000000, 0x000000, 0x000000
    };

    lv_obj_t *lbl;
    lv_obj_t *val;
    int i;
    for (i = 0; i < 7; i++) {
        lbl = lv_label_create(frame);
        lv_label_set_text(lbl, row_labels[i]);
        lv_obj_set_style_text_font(lbl, &lv_font_montserrat_14, 0);
        lv_obj_set_style_text_color(lbl, lv_color_hex(0xd4af37), 0);
        lv_obj_align(lbl, LV_ALIGN_TOP_LEFT, 20, y);

        val = lv_label_create(frame);
        lv_label_set_text(val, row_values[i]);
        lv_obj_set_style_text_font(val, &lv_font_montserrat_14, 0);
        lv_obj_set_style_text_color(val, lv_color_hex(val_colors[i]), 0);
        lv_obj_align(val, LV_ALIGN_TOP_LEFT, 250, y);

        y += 35;
    }

    /* AP Mode button (right side) */
    lv_obj_t *ap_btn = lv_button_create(frame);
    lv_obj_set_size(ap_btn, 180, 60);
    lv_obj_set_style_bg_color(ap_btn, lv_color_hex(0xFF9800), LV_PART_MAIN);
    lv_obj_set_style_radius(ap_btn, 10, LV_PART_MAIN);
    lv_obj_align(ap_btn, LV_ALIGN_RIGHT_MID, -30, 0);

    lv_obj_t *ap_lbl = lv_label_create(ap_btn);
    lv_label_set_text(ap_lbl, "Prepnout\\nna AP");
    lv_obj_set_style_text_font(ap_lbl, &lv_font_montserrat_14, LV_PART_MAIN);
    lv_obj_set_style_text_color(ap_lbl, lv_color_hex(0xffffff), LV_PART_MAIN);
    lv_obj_set_style_text_align(ap_lbl, LV_TEXT_ALIGN_CENTER, LV_PART_MAIN);
    lv_obj_center(ap_lbl);
}
`,
  },
});
handleResult(r, "ebrew-08-sysinfo.png", "ebrew-08-sysinfo.json");

console.log("\n=== All 8 E-BREW Screens Rendered ===\n");
child.stdin.end();
child.on("exit", () => process.exit(0));
setTimeout(() => { child.kill(); process.exit(1); }, 300000);
