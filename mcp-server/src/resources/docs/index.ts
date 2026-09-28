/**
 * lvgl_docs topics and the lvgl://api-reference resource (their concatenation).
 */
import { boardsMarkdownTable } from "../../boards.js";
import { ANIM, EVENTS, LAYOUTS, STYLES, SYMBOLS, V8_MIGRATION, WIDGETS_OVERVIEW } from "./core.js";
import { ACTIONS, DIAGNOSTICS, ESP32, FONTS, SIMULATOR, UI_JSON } from "./guides.js";
import { WIDGET_NAMES, widgetIndex, widgetPage } from "./widgets.js";

export const BOARDS_DOC = `# Board presets

Pass \`board: "<id>"\` to any render tool: it sets width, height, color format, DPI, rotation and the LVGL heap
budget (mem_budget_kb) of that board; explicit parameters override the preset. Machine-readable: resource lvgl://boards.

${boardsMarkdownTable()}
`;

/** Top-level topics in api-reference order. */
const TOPICS: Array<[string, string, () => string]> = [
  ["simulator", "Simulator constraints, sim.h helpers, what a render returns, limits", () => SIMULATOR],
  ["widgets", "Widget overview and common widget APIs (index of widgets/<name>)", () => `${WIDGETS_OVERVIEW}\n## Per-widget pages\n${widgetIndex()}\n`],
  ["layouts", "Size, position, alignment, flex and grid", () => LAYOUTS],
  ["styles", "Style properties, colors, parts and states", () => STYLES],
  ["events", "Event callbacks and which events actions trigger", () => EVENTS],
  ["anim", "Timers and animations", () => ANIM],
  ["fonts", "Built-in fonts, device fonts, missing glyphs, custom fonts", () => FONTS],
  ["symbols", "LV_SYMBOL_* icons", () => SYMBOLS],
  ["v8-migration", "9.6 deprecations and v8 -> v9 renames", () => V8_MIGRATION],
  ["actions", "Action script: click, drag, key, type, focus, capture, load_screen", () => ACTIONS],
  ["ui-json", "JSON UI documents for lvgl_render_ui (no compiler needed)", () => UI_JSON],
  ["diagnostics", "UI diagnostic codes (LABEL_CLIPPED, MISSING_GLYPH, LOW_CONTRAST, ...)", () => DIAGNOSTICS],
  ["esp32", "ESP-IDF integration: shims, memory budgets, RGB565, fonts", () => ESP32],
  ["boards", "Board presets (resolution, color format, DPI, LV_MEM_SIZE)", () => BOARDS_DOC],
];

export const DOC_TOPIC_IDS: [string, ...string[]] = [
  ...TOPICS.map(([id]) => id),
  ...WIDGET_NAMES.map((n) => `widgets/${n}`),
] as [string, ...string[]];

/** One line per top-level topic (for tool descriptions and unknown-topic errors). */
export function topicList(): string {
  return TOPICS.map(([id, desc]) => `${id}: ${desc}`).join("\n") + `\nwidgets/<name>: ${WIDGET_NAMES.join(", ")}`;
}

export function getDocTopic(id: string): string | undefined {
  const t = TOPICS.find(([tid]) => tid === id);
  if (t) return t[2]();
  if (id.startsWith("widgets/")) return widgetPage(id.slice("widgets/".length).replace(/^lv_/, ""));
  return undefined;
}

export const API_REFERENCE_HEADER = `# LVGL 9.6 API Quick Reference (lvgl-mcp simulator)

This simulator runs **LVGL 9.6** (C11). ESP32 projects are often still on 9.5 (or older v8):
everything below works on 9.5 unless marked **[9.6+]**. Write v9 names. Many v8 names still compile
through LVGL's compatibility macros (lv_api_map_v8.h), but v8 calls whose signature changed
(lv_msgbox_create, lv_tabview_create, lv_spinner_create) and removed widgets (lv_meter, lv_colorwheel)
do not - see the rename table in "9.6 deprecations and v8 -> v9 migration".

Tools: lvgl_render (C snippet), lvgl_render_full (complete C file), lvgl_render_project (multi-file C project,
e.g. a SquareLine/EEZ export), lvgl_render_ui (JSON UI document, no compiler needed), lvgl_interact (render +
click/type actions), lvgl_diff (compare two renders), lvgl_inspect (widget tree), lvgl_check (compile only),
lvgl_docs (this text by topic, plus per-widget pages widgets/<name>), lvgl_set_resolution.
Every render can take a \`board\` preset, \`color_format\`, \`scale\`, device \`fonts\`, \`mem_budget_kb\`,
\`annotate\`, \`frames\` and \`actions\`, and returns UI diagnostics, memory use and a render_id.
`;

/** The full reference: header + every top-level topic (widget pages are separate). */
export function apiReference(): string {
  return [API_REFERENCE_HEADER, ...TOPICS.map(([, , text]) => text())].join("\n\n");
}
