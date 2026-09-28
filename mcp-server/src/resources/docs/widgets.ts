/**
 * Per-widget pages (lvgl_docs "widgets/<name>"): hand-written summaries plus
 * the prototypes generated from the LVGL headers (widgets.generated.ts).
 */
import { LVGL_HEADERS_VERSION, WIDGET_TABLE } from "./widgets.generated.js";

export interface WidgetTableEntry {
  name: string;
  headers: string[];
  functions: Array<{ proto: string; brief: string; deprecated?: boolean }>;
  enums: Array<{ name: string; values: string[] }>;
}

interface WidgetNotes {
  summary: string;
  parts?: string;
  events?: string;
  example?: string;
}

const NOTES: Record<string, WidgetNotes> = {
  obj: {
    summary: "Base object: containers, cards, backgrounds. Every widget is an lv_obj; these functions work on all of them (flags, states, size, position, alignment).",
    parts: "MAIN, SCROLLBAR",
    events: "CLICKED, PRESSED, RELEASED, LONG_PRESSED, FOCUSED, SCROLL, SIZE_CHANGED, DELETE",
    example: "lv_obj_t *card = lv_obj_create(screen);\nlv_obj_set_size(card, 200, 120);\nlv_obj_center(card);\nlv_obj_set_name(card, \"card\");",
  },
  animimg: { summary: "Image animation from a list of image sources (frames).", parts: "MAIN" },
  arc: {
    summary: "Circular arc / knob: gauges and circular sliders (value between min and max, draggable).",
    parts: "MAIN (background arc), INDICATOR (value arc), KNOB",
    events: "VALUE_CHANGED when dragged",
    example: "lv_obj_t *arc = lv_arc_create(screen);\nlv_obj_set_size(arc, 150, 150);\nlv_arc_set_range(arc, 0, 100);\nlv_arc_set_value(arc, 40);\nlv_obj_center(arc);",
  },
  bar: {
    summary: "Progress bar (not interactive; use a slider for input).",
    parts: "MAIN (background), INDICATOR",
    example: "lv_obj_t *bar = lv_bar_create(screen);\nlv_obj_set_size(bar, 200, 16);\nlv_bar_set_value(bar, 70, LV_ANIM_OFF);",
  },
  barcode: { summary: "Code-128 barcode drawn on a canvas.", parts: "MAIN" },
  button: {
    summary: "Clickable container; put a label (or image) inside. Checkable with LV_OBJ_FLAG_CHECKABLE.",
    parts: "MAIN",
    events: "CLICKED, PRESSED, RELEASED, LONG_PRESSED, VALUE_CHANGED (when checkable)",
    example: "lv_obj_t *btn = lv_button_create(screen);\nlv_obj_set_name(btn, \"ok_btn\");\nlv_obj_t *l = lv_label_create(btn);\nlv_label_set_text(l, \"OK\");\nlv_obj_center(l);",
  },
  buttonmatrix: {
    summary: "Many buttons drawn by one object from a string map (\"\\n\" = new row, \"\" = end). Light-weight keypads.",
    parts: "MAIN, ITEMS (the buttons)",
    events: "VALUE_CHANGED (lv_buttonmatrix_get_selected_button)",
  },
  calendar: { summary: "Month calendar with optional header (arrow or dropdown).", parts: "MAIN, ITEMS (day buttons)", events: "VALUE_CHANGED" },
  canvas: { summary: "Draw freely into a buffer (lines, rects, text, images) - needs a static buffer.", parts: "MAIN" },
  chart: {
    summary: "Line, bar or scatter chart with series of points.",
    parts: "MAIN, ITEMS (series lines/bars), INDICATOR (points), CURSOR",
    example: "lv_obj_t *ch = lv_chart_create(screen);\nlv_obj_set_size(ch, 240, 140);\nlv_chart_series_t *s = lv_chart_add_series(ch, lv_palette_main(LV_PALETTE_BLUE), LV_CHART_AXIS_PRIMARY_Y);\nfor (int i = 0; i < 10; i++) lv_chart_set_next_value(ch, s, i * 10);",
  },
  checkbox: { summary: "Check box with a text label.", parts: "MAIN (text), INDICATOR (the box)", events: "VALUE_CHANGED" },
  dropdown: { summary: "Drop-down list; options are one \"\\n\"-separated string.", parts: "MAIN; the opened list has MAIN, SELECTED, SCROLLBAR", events: "VALUE_CHANGED" },
  image: { summary: "Image from a C array (lv_image_dsc_t), an \"S:file.png\" path or an LV_SYMBOL_* string.", parts: "MAIN" },
  imagebutton: { summary: "Button made of left/middle/right images per state.", parts: "MAIN", events: "CLICKED, VALUE_CHANGED" },
  keyboard: { summary: "On-screen keyboard; attach to a textarea with lv_keyboard_set_textarea.", parts: "MAIN, ITEMS", events: "VALUE_CHANGED, READY, CANCEL" },
  label: {
    summary: "Text. Long text behaviour via lv_label_set_long_mode (WRAP, DOTS, SCROLL, SCROLL_CIRCULAR, CLIP).",
    parts: "MAIN, SCROLLBAR, SELECTED",
    example: "lv_obj_t *l = lv_label_create(screen);\nlv_label_set_text(l, \"Hello\");\nlv_obj_set_style_text_font(l, &lv_font_montserrat_20, 0);",
  },
  led: { summary: "Round LED with colour and brightness.", parts: "MAIN" },
  line: { summary: "Polyline from a (static) array of points.", parts: "MAIN (line_* styles)" },
  list: { summary: "DEPRECATED in 9.6: use a flex column container with full-width buttons/labels.", parts: "MAIN, SCROLLBAR" },
  menu: { summary: "DEPRECATED in 9.6: build navigation from containers, buttons and screen/tab switching.", parts: "MAIN" },
  msgbox: {
    summary: "Message box (modal when created with parent NULL, on the top layer): title, text, footer buttons, close button.",
    parts: "MAIN (and its header/content/footer children)",
  },
  qrcode: { summary: "QR code.", parts: "MAIN" },
  roller: { summary: "Rolling option selector (\"\\n\"-separated options), NORMAL or INFINITE mode.", parts: "MAIN, SELECTED", events: "VALUE_CHANGED" },
  scale: { summary: "Linear or round scale with ticks and labels (replaces v8 lv_meter; add needles with lv_line or lv_arc).", parts: "MAIN, ITEMS (minor ticks), INDICATOR (major ticks + labels)" },
  slider: {
    summary: "Draggable value slider (horizontal when wider than tall).",
    parts: "MAIN (track), INDICATOR (filled part), KNOB",
    events: "VALUE_CHANGED while dragged, RELEASED",
    example: "lv_obj_t *s = lv_slider_create(screen);\nlv_obj_set_width(s, 200);\nlv_slider_set_range(s, 0, 100);\nlv_slider_set_value(s, 40, LV_ANIM_OFF);",
  },
  span: { summary: "Rich text: a span group holds spans with individual styles.", parts: "MAIN" },
  spinbox: { summary: "Numeric input with digit cursor (increment/decrement).", parts: "MAIN, CURSOR", events: "VALUE_CHANGED" },
  spinner: { summary: "Rotating arc loading indicator (animated: use settle or frames to see it move).", parts: "MAIN, INDICATOR" },
  switch: {
    summary: "On/off toggle; the checked state is LV_STATE_CHECKED.",
    parts: "MAIN, INDICATOR, KNOB",
    events: "VALUE_CHANGED when toggled (click it with the actions parameter)",
    example: "lv_obj_t *sw = lv_switch_create(screen);\nlv_obj_set_name(sw, \"wifi_sw\");\nlv_obj_add_state(sw, LV_STATE_CHECKED);",
  },
  table: { summary: "Table of text cells.", parts: "MAIN, ITEMS (cells)", events: "VALUE_CHANGED (cell clicked)" },
  tabview: { summary: "Tabs with a tab bar; each tab is a scrollable container.", parts: "MAIN; tab bar is a button container", events: "VALUE_CHANGED" },
  textarea: { summary: "Text input (one-line or multi-line, password mode, placeholder). Focus it and use the type action.", parts: "MAIN, SCROLLBAR, SELECTED, CURSOR, TEXTAREA_PLACEHOLDER", events: "VALUE_CHANGED, READY (one-line ENTER)" },
  tileview: { summary: "Swipeable pages arranged in a grid (drag action to swipe).", parts: "MAIN, SCROLLBAR", events: "VALUE_CHANGED" },
  win: { summary: "DEPRECATED in 9.6: flex column with a header container and a content container.", parts: "MAIN" },
};

export const WIDGET_NAMES: string[] = WIDGET_TABLE.map((w) => w.name);

/** Markdown page for one widget. */
export function widgetPage(name: string): string | undefined {
  const w = WIDGET_TABLE.find((e) => e.name === name);
  if (!w) return undefined;
  const n = NOTES[name];
  const lines = [`# lv_${name} (LVGL ${LVGL_HEADERS_VERSION})`, ""];
  if (n) {
    lines.push(n.summary, "");
    if (n.parts) lines.push(`Parts: ${n.parts}`);
    if (n.events) lines.push(`Events: ${n.events}`);
    if (n.parts || n.events) lines.push("");
    if (n.example) lines.push("```c", n.example, "```", "");
  }
  lines.push(`Header: ${w.headers.join(", ")} (all included by lvgl.h)`, "", "## Functions", "```c");
  for (const f of w.functions) {
    lines.push(`${f.proto}${f.deprecated ? "   // DEPRECATED" : ""}${f.brief ? `   // ${f.brief}` : ""}`);
  }
  lines.push("```");
  if (w.enums.length) {
    lines.push("", "## Enums");
    for (const e of w.enums) lines.push(`- ${e.name}: ${e.values.join(", ")}`);
  }
  lines.push("", "Styles: lvgl_docs \"styles\"; layouts: \"layouts\"; events and input: \"events\", \"actions\".");
  return lines.join("\n") + "\n";
}

/** Index page listing all widgets. */
export function widgetIndex(): string {
  return WIDGET_TABLE.map((w) => `- widgets/${w.name}: ${NOTES[w.name]?.summary ?? ""}`).join("\n");
}
