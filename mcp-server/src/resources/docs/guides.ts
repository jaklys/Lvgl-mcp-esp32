/**
 * Simulator-specific lvgl_docs topics: simulator, fonts, actions, ui-json,
 * esp32, diagnostics. Keep in sync with CONTRACT-2.2 (simulator CLI/JSON).
 */

export const SIMULATOR = `# The simulator (lvgl-mcp 2.2)

## Simulator constraints
- Snippet mode (lvgl_render): code runs inside \`void create_ui(void)\` with
  \`lv_obj_t *screen = lv_screen_active();\` predefined. Includes: lvgl.h, stdio.h, stdlib.h, string.h,
  stdint.h, stdbool.h. File-scope things (helper functions, static callbacks, #define, image arrays)
  need lvgl_render_full with a complete file defining \`void create_ui(void)\`.
- Multi-file projects (lvgl_render_project): all .c/.cpp files are compiled; the entry function
  (default \`ui_init\`, e.g. a SquareLine/EEZ export) is called instead of create_ui().
- JSON UI documents (lvgl_render_ui): no C code and no compiler at all; see topic "ui-json".
- Do not call lv_init(), create displays/indevs, or loop on lv_timer_handler(): the simulator does it.
- Framebuffer: 32 bpp XRGB8888 by default; \`color_format: "rgb565"\` (or a \`board\`) renders through a
  16 bpp buffer so gradients band like on the device. \`scale\` (1..4) enlarges the PNG (nearest neighbour)
  without changing coordinates.
- Simulated time: ~330 ms (time_ms) in 33 ms steps before capture; settle=true waits for animations (max 3 s);
  \`frames\` captures several points in time.
- Input: a POINTER and a KEYPAD input device exist (all focusable objects are in the default group).
  They are driven by the \`actions\` parameter (click, drag, key, type, focus ...; topic "actions"). Without
  actions nothing is pressed; preview states with lv_obj_add_state() (or [9.6+] lv_obj_set_checked()...).
- Fonts: lv_font_montserrat_8 .. _48 (even sizes), lv_font_montserrat_28_compressed, lv_font_unscii_8/16.
  **On the ESP32 only the sizes enabled in the device's lv_conf.h (LV_FONT_MONTSERRAT_xx 1) exist** -
  pass \`fonts\` (the device's font list) and the render reports FONT_NOT_ON_DEVICE for anything else.
- Memory: LVGL's heap is an 8 MB pool here; the render reports the peak. Pass \`mem_budget_kb\` (the device's
  LV_MEM_SIZE) or a \`board\` to get MEM_OVER_BUDGET when the UI would not fit.
- Images: C arrays (\`LV_IMAGE_DECLARE(img); lv_image_set_src(img_obj, &img);\`) or files through the
  stdio driver letter S: - \`lv_image_set_src(img, "S:logo.png")\` resolved relative to assets_dir
  (PNG via lodepng, BMP, JPG via TJPGD). Symbols: \`lv_image_set_src(img, LV_SYMBOL_OK)\`.
- Crashes (NULL / deleted objects), LVGL assertions and infinite loops are caught and reported.
- lv_obj_set_name(obj, "ok_btn") names show up in the widget tree, in UI diagnostics and in annotated
  images, and are the targets of actions (lv_obj_find_by_name works too). Name everything you care about.
- printf() output is returned by the tools; LV_LOG_USER(...) and sim_log(...) show up in the LVGL log.

## Helpers for C code (sim.h, included by the snippet wrapper; \`#include "sim.h"\` in full/project mode)
\`\`\`c
void sim_advance_ms(uint32_t ms);      // advance simulated time (timers, animations run)
void sim_capture(const char *label);   // capture an image right now, like the action {"capture": label}
void sim_log(const char *fmt, ...);    // goes to the LVGL log ("[User]") in the result
\`\`\`

## What every render returns
- One PNG per capture (plus an annotated PNG per capture with \`annotate: true\`: every object outlined, labelled
  with its name or type#index path), the final state last.
- A text summary: render_id (for lvgl_diff / lvgl_inspect), UI diagnostics grouped by severity (topic
  "diagnostics"), LVGL heap peak vs. budget, fonts used, events fired by actions, compiler warnings,
  LVGL log, printf output and a widget-tree summary (include_tree="full" for the JSON tree).
- lvgl_diff compares two renders (pixels + objects); lvgl_inspect returns the full tree of any recent render.

## Limits
- Run time 15 s per render (LVGL_RUN_TIMEOUT_MS), compile 180 s (LVGL_COMPILE_TIMEOUT_MS; the first build
  compiles LVGL unless a prebuilt library is installed).
- Width/height 16..4096, scale 1..4, frames <= 20, actions <= 200 with <= 20 captures.
- The last 20 renders are kept in memory (ids r1, r2, ...).
`;

export const FONTS = `# Fonts

## Built into the simulator
\`lv_font_montserrat_8\` .. \`lv_font_montserrat_48\` (even sizes), \`lv_font_montserrat_28_compressed\`,
\`lv_font_unscii_8\`, \`lv_font_unscii_16\`. The Montserrat fonts contain ASCII 0x20-0x7F, the degree sign (°),
the bullet (•) and the LV_SYMBOL_* icons (topic "symbols") - nothing else. Characters outside a font
(e.g. "č", "€", "→", CJK, emoji) draw as an empty box: the render reports MISSING_GLYPH with the code point.

\`\`\`c
lv_obj_set_style_text_font(label, &lv_font_montserrat_20, 0);
\`\`\`
The widget tree reports fonts by name (\`styles.font\` = "montserrat_20"), and every render lists \`fonts_used\`.

## Device fonts
On the ESP32 only the fonts enabled in the firmware's lv_conf.h / Kconfig (\`CONFIG_LV_FONT_MONTSERRAT_14=y\`)
exist; any other size compiles here but fails to link on the device. Pass the device's list:
\`"fonts": ["montserrat_14", "montserrat_20"]\` - objects that use another built-in font get a
FONT_NOT_ON_DEVICE error diagnostic.

## Custom fonts
Convert a TTF with lv_font_conv (or the online converter) to a C array and paste it in full-file/project
mode: \`LV_FONT_DECLARE(my_font_18);\` then \`lv_obj_set_style_text_font(obj, &my_font_18, 0);\`. Include the
exact characters you need (e.g. \`--range 0x20-0x7F,0x10C,0x10D\`).
`;

export const ACTIONS = `# Actions: click, type and see the result

The \`actions\` render parameter (lvgl_render, lvgl_render_full, lvgl_render_project, lvgl_render_ui,
lvgl_interact) is a JSON array executed after create_ui() and the initial time_ms. Input goes through real
LVGL input devices (a POINTER indev and a KEYPAD indev whose default group holds all focusable objects),
so event callbacks, pressed/checked states, scrolling, focus and animations behave like on the device.
Simulated time advances in 33 ms steps.

| Action | Effect |
|---|---|
| \`{"wait": 300}\` | advance 300 ms |
| \`{"click": {"x": 10, "y": 20}}\` | press 60 ms, release at logical (display) coordinates |
| \`{"click": {"name": "ok_btn"}}\` | click the centre of the object named with lv_obj_set_name (or "name" in a JSON UI); tree paths like "lv_button#2" work too |
| \`{"press": {"name": "..."}}\` / \`{"release": {}}\` | hold / let go (long press = press, wait, release) |
| \`{"drag": {"from": {"name": "slider"}, "to": {"x": 300, "y": 120}, "steps": 10, "duration": 300}}\` | press, move in steps, release (sliders, scrolling, swiping tiles) |
| \`{"key": "ENTER"}\` | ENTER, ESC, UP, DOWN, LEFT, RIGHT, NEXT, PREV, BACKSPACE, DEL, HOME, END, or one character |
| \`{"type": "hello"}\` | keypad characters one by one (focus a textarea first) |
| \`{"focus": {"name": "ssid_ta"}}\` | lv_group_focus_obj |
| \`{"capture": "after_click"}\` | take an image now (label: letters, digits, _ and -) |
| \`{"settle": 3000}\` | advance until no animation runs (at most 3000 ms) |
| \`{"load_screen": {"name": "settings", "anim": "fade", "duration": 300}}\` | JSON UI documents with several \`screens\`: load one |

The final state is always captured last (label "final"). Every capture becomes one image in the result
(plus its annotated image with \`annotate: true\`), in order.

The result lists the events that fired (\`events\`: CLICKED, VALUE_CHANGED, PRESSED, RELEASED, FOCUSED,
SCREEN_LOADED with time and object name) and the focused object (\`input.focused\`).

Errors: an unknown action, bad JSON or an object name that does not exist fails the render with the
message and the list of known object names - name the objects you want to interact with.

Example - toggle a switch and check the event:
\`\`\`json
[{"capture": "before"}, {"click": {"name": "wifi_sw"}}, {"wait": 200}]
\`\`\`
\`frames\` (e.g. [0, 100, 300]) is sugar for wait+capture steps (labels "t0", "t100", ...); use either
frames or actions.
`;

export const UI_JSON = `# JSON UI documents (lvgl_render_ui)

**LVGL's own XML format is part of LVGL Pro and is not supported here; the JSON UI format is this project's own
and maps 1:1 to LVGL calls; the widget tree returned by every render uses the same vocabulary.** It needs no
C code and no compiler: with the prebuilt simulator (release archives) it works on machines without a
toolchain. Actions, frames, annotate, diagnostics and events work exactly as in C mode.

## Document shape
The root object is the screen (type "lv_obj"). All keys are optional except \`type\`; unknown keys are errors
(typos never pass silently) and all errors are reported at once as \`ui: <json-path>: <message>\` lines.

\`\`\`json
{ "type": "lv_obj", "name": "screen", "styles": {"bg_color": "#f5f5f5"},
  "children": [
    {"type": "lv_label", "name": "title", "text": "Living room", "align": "top_mid", "x": 0, "y": 12,
     "styles": {"font": "montserrat_24", "text_color": "#111827"}},
    {"type": "lv_slider", "name": "target", "x": 20, "y": 80, "w": 280, "h": 12, "min": 16, "max": 30, "value": 23,
     "styles": {"bg_color": "#e5e7eb"}, "indicator": {"bg_color": "#ff6b3d", "bg_grad_color": "#3b82f6", "bg_grad_dir": "hor"},
     "knob": {"bg_color": "#ffffff", "border_color": "#ff6b3d", "border_width": 3, "shadow_color": "#ff6b3d", "shadow_width": 20, "shadow_opa": 180}},
    {"type": "lv_button", "name": "ok_btn", "align": "bottom_right", "x": -16, "y": -16, "w": 120, "h": 44,
     "children": [{"type": "lv_label", "text": "Heat on", "align": "center"}]}
  ] }
\`\`\`

## Node keys
- \`type\`: lv_obj, lv_label, lv_button, lv_image, lv_slider, lv_bar, lv_arc, lv_switch, lv_checkbox, lv_dropdown,
  lv_roller, lv_textarea, lv_spinner, lv_led, lv_line, lv_chart (line or bar chart, \`series\`: [{color, points: [..]}],
  \`range\`), lv_table (\`rows\`: [[..]]), lv_buttonmatrix (\`map\`: [..]), lv_tabview (\`tabs\`: [{title, children}]),
  lv_msgbox (\`title\`, \`text\`, \`buttons\`), lv_spinbox, lv_scale, lv_list (\`items\`: [{icon?, text}]).
- \`name\` (the target for actions and the label in diagnostics/annotations - name everything you care about).
- Geometry: \`x\`, \`y\` (int; offsets when \`align\` is set), \`w\`, \`h\` (int px, "content" or "50%"), \`align\`:
  top_left | top_mid | top_right | left_mid | center | right_mid | bottom_left | bottom_mid | bottom_right.
- \`hidden\` (bool), \`states\` ["checked", "disabled", "focused"], \`flags\` ["clickable", "scrollable", "checkable",
  "floating", "ignore_layout", "hidden"] (prefix "-" to remove, e.g. "-scrollable").
- Content: \`text\`, \`placeholder\`, \`long_mode\`, \`one_line\`; \`value\`, \`min\`, \`max\`, \`anim\` (bool); \`checked\`;
  \`options\` [..], \`selected\`; \`src\` ("S:path.png" relative to assets_dir, or "symbol:OK" for LV_SYMBOL_OK).
- \`layout\`: \`{"type": "flex", "flow": "row|column|row_wrap|column_wrap", "main": "start|end|center|space_between|space_around|space_evenly", "cross": "start|end|center", "track": "start|end|center"}\`
  (children may set \`"grow": N\`) or \`{"type": "grid", "cols": [100, "fr1", "content"], "rows": [...]}\` with
  \`"cell": {"col": 0, "col_span": 1, "row": 0, "row_span": 1, "x_align": "stretch|start|center|end", "y_align": ...}\` on children.
- Styles: \`styles\` (LV_PART_MAIN, default state), part blocks \`indicator\`, \`knob\`, \`selected\`, \`items\`, \`cursor\`,
  \`scrollbar\`, and state variants \`styles_pressed\`, \`styles_checked\`, \`styles_disabled\`, \`styles_focused\`
  (also \`indicator_checked\` etc.).

## Style keys (the names the widget tree prints)
bg_color, bg_opa, bg_grad_color, bg_grad_dir (hor|ver|none), bg_grad_stops [{color, frac 0..255}],
border_color, border_width, border_opa, border_side (full|top|bottom|left|right|none), outline_width,
outline_color, outline_pad, radius (int or "circle"), pad_top/bottom/left/right, pad_all, pad_hor, pad_ver,
pad_row, pad_column, pad_gap, margin_*, shadow_color, shadow_width, shadow_spread, shadow_opa, shadow_ofs_x,
shadow_ofs_y, text_color, text_opa, font (montserrat_8..48, unscii_8/16), text_align (left|center|right|auto),
text_letter_space, text_line_space, line_width, line_color, line_rounded, arc_width, arc_color, arc_opa,
arc_rounded, opa, width, height, min_width, max_width, min_height, max_height, transform_rotation (0.1 deg),
transform_scale (256 = 1.0), translate_x, translate_y, clip_corner (bool).
Colours "#rrggbb" or "#rgb"; opacities 0..255 or "50%".

## Document extras
- \`"theme": "light" | "dark"\`
- \`"layer_top": [nodes]\` (message boxes, toasts)
- \`"animations": [{"target": "name", "prop": "x|y|w|h|opa|value|rotation", "from": 0, "to": 100, "duration": 500,
  "delay": 0, "repeat": 2 | "infinite", "playback": true, "path": "linear|ease_in|ease_out|ease_in_out|overshoot|bounce"}]\`
  (combine with \`frames\` or settle to see the motion)
- \`"screens": {"name": node, ...}\` + \`"active": "name"\` - several screens; the action
  \`{"load_screen": {"name": "...", "anim": "fade|move_left|...", "duration": 300}}\` switches between them.

## Example 1 - card with gradient and glow
\`\`\`json
{"type": "lv_obj", "styles": {"bg_color": "#0f172a"}, "children": [
  {"type": "lv_obj", "name": "card", "align": "center", "w": 260, "h": 140,
   "styles": {"radius": 16, "bg_color": "#6366f1", "bg_grad_color": "#ec4899", "bg_grad_dir": "hor", "border_width": 0,
              "shadow_color": "#ec4899", "shadow_width": 30, "shadow_opa": 160, "pad_all": 16},
   "flags": ["-scrollable"],
   "children": [
     {"type": "lv_label", "name": "card_title", "text": "Energy today", "align": "top_left",
      "styles": {"text_color": "#ffffff", "font": "montserrat_16"}},
     {"type": "lv_label", "name": "card_value", "text": "12.4 kWh", "align": "bottom_left",
      "styles": {"text_color": "#ffffff", "font": "montserrat_32"}}]}]}
\`\`\`

## Example 2 - flex list of settings rows
\`\`\`json
{"type": "lv_obj", "layout": {"type": "flex", "flow": "column", "main": "start", "cross": "center"},
 "styles": {"pad_all": 12, "pad_row": 8}, "children": [
  {"type": "lv_obj", "name": "row_wifi", "w": "100%", "h": "content", "flags": ["-scrollable"],
   "layout": {"type": "flex", "flow": "row", "main": "space_between", "cross": "center"},
   "children": [{"type": "lv_label", "text": "Wi-Fi"}, {"type": "lv_switch", "name": "wifi_sw", "checked": true}]},
  {"type": "lv_obj", "name": "row_bright", "w": "100%", "h": "content", "flags": ["-scrollable"],
   "layout": {"type": "flex", "flow": "row", "main": "space_between", "cross": "center"},
   "children": [{"type": "lv_label", "text": "Brightness"}, {"type": "lv_slider", "name": "bright", "w": 140, "value": 60}]}]}
\`\`\`

## Example 3 - two screens and a load_screen action
\`\`\`json
{"screens": {
   "home": {"type": "lv_obj", "children": [
     {"type": "lv_button", "name": "go_settings", "align": "center",
      "children": [{"type": "lv_label", "text": "Settings"}]}]},
   "settings": {"type": "lv_obj", "styles": {"bg_color": "#1f2937"}, "children": [
     {"type": "lv_label", "text": "Settings", "align": "top_mid", "y": 10, "styles": {"text_color": "#ffffff"}}]}},
 "active": "home"}
\`\`\`
with \`"actions": [{"capture": "home"}, {"load_screen": {"name": "settings", "anim": "move_left", "duration": 300}}, {"settle": 1000}]\`.
`;

export const ESP32 = `# ESP32 / ESP-IDF integration

## From simulator code to the device
- The same C code runs on the device: put it in a function (e.g. \`void ui_init(void)\`) called after the display
  driver is set up (esp_lvgl_port: inside \`lvgl_port_lock(0)\` / \`lvgl_port_unlock()\`).
- Pick the \`board\` preset (lvgl://boards, lvgl_docs "boards") - it sets resolution, RGB565, DPI and a typical
  LV_MEM_SIZE budget; explicit parameters override it.
- Declare the device fonts with \`fonts\` and the heap with \`mem_budget_kb\` so FONT_NOT_ON_DEVICE / MEM_OVER_BUDGET
  catch what would fail on the device.

## ESP-IDF shims (\`esp_shims: true\`; default on in lvgl_render_project)
Code copied from an ESP-IDF project compiles unchanged: \`esp_log.h\`, \`esp_err.h\`, \`esp_timer.h\`,
\`esp_system.h\`, \`esp_check.h\`, \`sdkconfig.h\`, \`freertos/FreeRTOS.h\`, \`freertos/task.h\`, \`freertos/semphr.h\`,
\`freertos/queue.h\` and \`esp_lvgl_port.h\` resolve to stand-ins:
- ESP_LOGI/W/E/D/V(tag, fmt, ...) -> sim_log (shows in the LVGL log of the result)
- vTaskDelay(ticks) -> sim_advance_ms(ticks * portTICK_PERIOD_MS); pdMS_TO_TICKS(ms); portTICK_PERIOD_MS = 10
- esp_timer_get_time() -> lv_tick_get() * 1000; TickType_t, portMAX_DELAY; esp_err_t, ESP_OK, ESP_ERROR_CHECK
- xTaskCreate runs the task function once, synchronously; vTaskDelete is a no-op
- mutexes/semaphores/queues and lvgl_port_lock/unlock are no-ops that succeed
- A \`while (1) { lv_timer_handler(); vTaskDelay(...); }\` loop is detected: after 5 s of simulated time the
  simulator captures and ends the render with the info diagnostic APP_LOOP_DETECTED.
Hardware (GPIO, I2C, SPI, Wi-Fi, NVS) is not simulated: keep it out of the UI code or behind #ifdef.

## Memory
- LV_MEM_SIZE (Kconfig LV_MEM_SIZE_KILOBYTES) is LVGL's own heap: widgets, styles, text. Typical: 32-64 KB
  without PSRAM. Each widget costs ~100-300 bytes, labels also their text, charts their points.
- The render reports the LVGL heap peak; with a budget it adds MEM_OVER_BUDGET (error) when it does not fit.
- Draw buffers are separate (1/10 screen x 2 bytes x 2 buffers is common), as are images in flash (C arrays).
- With PSRAM, set \`CONFIG_LV_MEM_CUSTOM\`/LV_USE_STDLIB_MALLOC=CLIB and the budget matters less.

## Colour (RGB565)
Most ESP32 panels are 16 bpp RGB565: \`color_format: "rgb565"\` (or a board) renders through a 16 bpp buffer, so
gradients band and near colours merge like on the device. Byte swapping (LV_COLOR_16_SWAP / lv_draw_sw_rgb565_swap)
is a driver detail and does not affect the UI code.

## Fonts
Only the fonts enabled in sdkconfig exist on the device (CONFIG_LV_FONT_MONTSERRAT_xx=y); see topic "fonts".

## Touch targets and DPI
Small panels have high DPI: keep clickable objects >= 40x40 px (SMALL_TOUCH_TARGET info diagnostic) and use
lv_dpx() for sizes that should scale with the panel.
`;

export const DIAGNOSTICS = `# UI diagnostics (every render)

Computed by the simulator on the final state; each carries the object's name/path, absolute rectangle and a
message with numbers. Grouped in the result by severity.

| Code | Severity | Meaning |
|---|---|---|
| LABEL_CLIPPED | warn | label text needs more space than the label has (clip / dots long mode) |
| TEXT_OVERFLOW | warn | wrapped text is taller than the object's content box |
| MISSING_GLYPH | error | a character is not in the font (drawn as an empty box) |
| OFF_SCREEN | warn | object partly or fully outside its screen |
| OUTSIDE_PARENT | warn | object outside its parent's clip area and the parent does not scroll |
| OVERLAP | info | two visible siblings overlap and the parent has no layout |
| LOW_CONTRAST | warn | text vs. effective background contrast ratio < 3.0 (WCAG formula) |
| SMALL_TOUCH_TARGET | info | clickable object smaller than 40x40 px on a display with dpi <= 160 |
| ZERO_SIZE | warn | width or height is 0 while not hidden |
| FONT_NOT_ON_DEVICE | error | object uses a font not in \`fonts\` (the device's font list) |
| MEM_OVER_BUDGET | error | LVGL heap peak exceeds \`mem_budget_kb\` / the board's LV_MEM_SIZE |
| HIDDEN_CLICKABLE | info | clickable but hidden or invisible |
| ANIM_UNFINISHED | info | animations still running at the final capture (use settle or a larger time_ms) |
| APP_LOOP_DETECTED | info | an endless lv_timer_handler()/vTaskDelay loop was stopped after 5 s (ESP shims) |

A clean UI has zero diagnostics. Fix errors first, then warnings; info items are judgement calls
(e.g. an intentional overlap).
`;
