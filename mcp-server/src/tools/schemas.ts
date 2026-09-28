import { z } from "zod";
import { BOARD_IDS } from "../boards.js";

/** Facts every render-ish tool description repeats for the model. */
export const SIMULATOR_FACTS = [
  "Environment: LVGL 9.6 API, not v8 - use v9 names (lv_button_create, lv_screen_active, lv_image_*, lv_obj_remove_flag, LV_LABEL_LONG_MODE_*); v8 lv_msgbox_create/lv_tabview_create/lv_spinner_create signatures and lv_meter/lv_colorwheel do not exist. Code must also work on 9.5 devices? Avoid 9.6-only calls (lv_obj_set_hidden, lv_obj_set_checked, lv_label_set_max_lines); see lvgl_docs / resource lvgl://api-reference. C11, 32 bpp XRGB8888 framebuffer by default (color_format=\"rgb565\" or a board preset renders like a 16 bpp panel).",
  "Fonts: lv_font_montserrat_8 .. lv_font_montserrat_48 (even sizes) and unscii_8/16 exist here, but on the ESP32 only the sizes enabled in the device's lv_conf.h exist - pass `fonts` with the device's list to get FONT_NOT_ON_DEVICE errors.",
  "Images: C arrays (lv_image_dsc_t) or \"S:<file>\" paths (PNG/BMP/JPG) resolved relative to assets_dir.",
  "Time: ~330 ms of simulated time is advanced before capture (time_ms; settle=true waits for animations; frames=[0,150,300] returns one image per point in time). Input: nothing is clicked unless you pass `actions` (click/drag/key/type via real LVGL input devices) - then you get one image per capture and the events that fired.",
  "Every render returns a render_id (for lvgl_diff / lvgl_inspect), UI diagnostics (clipped labels, missing glyphs, low contrast, overlaps, off-screen objects, small touch targets, fonts not on the device, LVGL heap over budget) and the LVGL heap peak. Name objects with lv_obj_set_name so diagnostics, annotated images and actions can refer to them.",
  "Crashes (NULL/deleted objects), LVGL assertions and infinite loops are caught and reported with the LVGL log.",
].join("\n");

export const widthSchema = z
  .number()
  .int()
  .min(16)
  .max(4096)
  .optional()
  .describe("Display width in px for THIS call only (default: the board's, else the lvgl_set_resolution default, initially 800).");
export const heightSchema = z
  .number()
  .int()
  .min(16)
  .max(4096)
  .optional()
  .describe("Display height in px for THIS call only (default: the board's, else the lvgl_set_resolution default, initially 480).");

// ---------------------------------------------------------------------------
// Action script (contract section 2 + load_screen from section 10)
// ---------------------------------------------------------------------------

const coord = z.number().int().min(-4096).max(8192);
export const pointTargetSchema = z.object({ x: coord, y: coord }).strict();
export const nameTargetSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(128)
      .describe("Object name (lv_obj_set_name / \"name\" in a JSON UI) or a tree path like \"lv_button#2\"."),
  })
  .strict();
export const targetSchema = z.union([pointTargetSchema, nameTargetSchema]);

export const KEY_NAMES = ["ENTER", "ESC", "UP", "DOWN", "LEFT", "RIGHT", "NEXT", "PREV", "BACKSPACE", "DEL", "HOME", "END"] as const;
export const SCREEN_ANIMS = [
  "none",
  "fade",
  "fade_in",
  "fade_out",
  "over_left",
  "over_right",
  "over_top",
  "over_bottom",
  "move_left",
  "move_right",
  "move_top",
  "move_bottom",
  "out_left",
  "out_right",
  "out_top",
  "out_bottom",
] as const;

const singleChar = z
  .string()
  .min(1)
  .max(4)
  .refine((s) => [...s].length === 1, { message: "must be one of the key names or exactly one character" });

/**
 * One action: an object with exactly one key. A union of strict single-key
 * objects (the key is the discriminator).
 */
export const actionSchema = z.union([
  z.object({ wait: z.number().int().min(0).max(30000).describe("Advance simulated time by N ms.") }).strict(),
  z.object({ click: targetSchema.describe("Press 60 ms and release at {x, y} (logical px) or at the centre of {name}.") }).strict(),
  z.object({ press: targetSchema.describe("Press and hold (release with {\"release\": {}}).") }).strict(),
  z.object({ release: z.object({}).strict() }).strict(),
  z
    .object({
      drag: z
        .object({
          from: targetSchema,
          to: targetSchema,
          steps: z.number().int().min(1).max(100).optional(),
          duration: z.number().int().min(0).max(10000).optional(),
        })
        .strict(),
    })
    .strict(),
  z.object({ key: z.union([z.enum(KEY_NAMES), singleChar]).describe("Key name or one character, via the keypad input device.") }).strict(),
  z.object({ type: z.string().min(1).max(500).describe("Type characters one by one (focus a textarea first).") }).strict(),
  z.object({ focus: nameTargetSchema }).strict(),
  z
    .object({
      capture: z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,32}$/, "capture label: 1-32 letters, digits, _ or -")
        .describe("Take an image now with this label."),
    })
    .strict(),
  z.object({ settle: z.number().int().min(0).max(10000).describe("Advance until no animation runs (at most N ms).") }).strict(),
  z
    .object({
      load_screen: z
        .object({
          name: z.string().min(1).max(128),
          anim: z.enum(SCREEN_ANIMS).optional(),
          duration: z.number().int().min(0).max(5000).optional(),
        })
        .strict(),
    })
    .strict(),
]);

export const MAX_ACTIONS = 200;
export const MAX_CAPTURES = 20;

export const actionsSchema = z
  .array(actionSchema)
  .min(1)
  .max(MAX_ACTIONS)
  .superRefine((actions, ctx) => {
    const captures = actions.filter((a) => "capture" in a).length;
    if (captures > MAX_CAPTURES) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `at most ${MAX_CAPTURES} capture actions (got ${captures})` });
    }
  });

export const ACTIONS_DESCRIPTION =
  "Action script run after the UI is built: lets you click, drag, press keys and type through real LVGL input devices and SEE the result - one image per {\"capture\": \"label\"} plus the final state, and the events that fired (CLICKED, VALUE_CHANGED, ...). Target objects by the names you gave them with lv_obj_set_name (or \"name\" in a JSON UI) or by the path shown in the tree (\"lv_button#2\"), or by {x, y} display coordinates. " +
  'Actions: {"wait": ms}, {"click": {"name": "ok_btn"}}, {"click": {"x": 10, "y": 20}}, {"press": target}, {"release": {}}, {"drag": {"from": target, "to": target, "steps": 10, "duration": 300}}, {"key": "ENTER"|"ESC"|"UP"|"DOWN"|"LEFT"|"RIGHT"|"NEXT"|"PREV"|"BACKSPACE"|"DEL"|"HOME"|"END"|"a"}, {"type": "text"}, {"focus": {"name": "..."}}, {"capture": "label"}, {"settle": ms}, {"load_screen": {"name": "...", "anim": "fade", "duration": 300}} (JSON UI screens). Max 200 actions, 20 captures. Details: lvgl_docs "actions".';

export const framesSchema = z
  .array(z.number().int().min(0).max(30000))
  .min(1)
  .max(MAX_CAPTURES)
  .refine((f) => f.every((v, i) => i === 0 || v > f[i - 1]!), { message: "frames must be strictly ascending" })
  .describe(
    "Capture at these simulated times in ms (ascending), e.g. [0, 150, 300, 600]: one image per time so you can see animations and transitions. Shortcut for wait+capture actions; use either frames or actions."
  );

export const fontNameSchema = z
  .string()
  .regex(/^(?:&?lv_font_)?[a-z0-9_]{1,48}$/, "font name like \"montserrat_14\" or \"lv_font_montserrat_14\"");

// ---------------------------------------------------------------------------
// Common render options
// ---------------------------------------------------------------------------

export const renderOptionsShape = {
  width: widthSchema,
  height: heightSchema,
  time_ms: z
    .number()
    .int()
    .min(0)
    .max(10000)
    .default(330)
    .describe("Simulated time in ms to advance (timers, animations) before the screenshot (before actions). Default 330."),
  settle: z
    .boolean()
    .default(false)
    .describe("After time_ms keep advancing until no animation is running (max 3000 ms total). Use for spinners/animated value changes."),
  rotation: z
    .union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)])
    .optional()
    .describe("Display rotation in degrees (lv_display_set_rotation). 90/270 swap the PNG width and height. Default 0 (or the board's)."),
  theme: z
    .enum(["light", "dark"])
    .default("light")
    .describe("Default theme mode applied before your code runs (lv_theme_default_init)."),
  dpi: z
    .number()
    .int()
    .min(50)
    .max(600)
    .optional()
    .describe("Display DPI (affects lv_dpx() and theme paddings). Default 130 (LVGL's default) or the board's."),
  assets_dir: z
    .string()
    .optional()
    .describe("Absolute directory that \"S:<file>\" image/font paths are resolved against. Default: the server's working directory (or LVGL_ASSETS_DIR)."),
  include_tree: z
    .enum(["summary", "full", "none"])
    .default("summary")
    .describe("\"summary\" (default): widget counts, names, texts, hidden/off-screen/overflowing widgets. \"full\": plus the compact JSON widget tree of the final state (large). \"none\": images, diagnostics and status only."),
  board: z
    .enum(BOARD_IDS)
    .optional()
    .describe(
      "ESP32 board preset: sets width, height, color_format (RGB565), DPI, rotation and mem_budget_kb (the board's typical LV_MEM_SIZE) so you see and measure the UI like on that device. Explicit parameters override the preset. List: lvgl_docs \"boards\" / resource lvgl://boards."
    ),
  color_format: z
    .enum(["xrgb8888", "rgb565"])
    .optional()
    .describe("Framebuffer format. \"rgb565\" renders through a 16 bpp buffer like most ESP32 panels (gradient banding, merged near colours). Default xrgb8888 (or the board's)."),
  scale: z
    .number()
    .int()
    .min(1)
    .max(4)
    .optional()
    .describe("Upscale every PNG by 1..4 (nearest neighbour) so small displays (e.g. 128x64) are readable; coordinates in the tree stay logical."),
  fonts: z
    .array(fontNameSchema)
    .min(1)
    .max(40)
    .optional()
    .describe("Fonts that exist on the DEVICE, e.g. [\"montserrat_14\", \"montserrat_20\"]. Objects using any other built-in font get a FONT_NOT_ON_DEVICE error - catches code that renders here but fails to link on the ESP32. Default: no restriction."),
  mem_budget_kb: z
    .number()
    .int()
    .min(4)
    .max(65536)
    .optional()
    .describe("The device's LV_MEM_SIZE in KB. The render reports the LVGL heap peak and a MEM_OVER_BUDGET error when the UI would not fit. Default: the board's, else none."),
  annotate: z
    .boolean()
    .default(false)
    .describe("Also return an annotated image per capture: every visible object outlined (colour by depth) and labelled with its name or type#index path - lets you map what you see to objects in the tree and to action targets."),
  frames: framesSchema.optional(),
  actions: actionsSchema.optional().describe(ACTIONS_DESCRIPTION),
};

/** Options that only make sense for C code. */
export const espShimsSchema = z
  .boolean()
  .describe(
    "ESP-IDF shims: code copied from an ESP-IDF project compiles unchanged - esp_log.h/ESP_LOGx, freertos/task.h/vTaskDelay (advances simulated time), esp_timer.h, esp_err.h, semaphores and esp_lvgl_port.h lock/unlock are provided as simulator stand-ins. Details: lvgl_docs \"esp32\"."
  );

export const diagnosticSchema = z.object({
  file: z.string(),
  line: z.number().int(),
  col: z.number().int().optional(),
  severity: z.enum(["error", "warning", "note"]),
  message: z.string(),
  code: z.string().optional(),
});

const rectSchema = z.object({ x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number() });

export const uiDiagnosticSchema = z
  .object({
    code: z.string(),
    severity: z.string(),
    name: z.string().optional(),
    path: z.string().optional(),
    abs: rectSchema.optional(),
    message: z.string(),
  })
  .passthrough();

export const renderOutputShape = {
  render_id: z.string().describe("Id of this render for lvgl_diff / lvgl_inspect (r1, r2, ...; last 20 kept)"),
  width: z.number().int().describe("PNG width in px (after rotation and scale)"),
  height: z.number().int().describe("PNG height in px (after rotation and scale)"),
  rotation: z.number().int(),
  theme: z.string(),
  mode: z.enum(["snippet", "full", "ui", "project"]),
  board: z.string().optional(),
  color_format: z.string().optional(),
  scale: z.number().optional(),
  lvgl_version: z.string(),
  format_version: z.number().optional(),
  elapsed_ms: z.number(),
  anims_running: z.number(),
  widget_count: z.number().int(),
  counts_by_type: z.record(z.number().int()),
  issues: z.object({
    hidden: z.array(z.string()),
    offscreen: z.array(z.string()),
    clipped: z.array(z.string()),
    overflowing: z.array(z.string()),
  }),
  named: z.array(
    z.object({ name: z.string(), type: z.string(), x: z.number(), y: z.number(), w: z.number(), h: z.number() })
  ),
  captures: z
    .array(
      z.object({
        n: z.number(),
        label: z.string(),
        elapsed_ms: z.number(),
        annotated: z.boolean(),
        widget_count: z.number().int().optional(),
      })
    )
    .optional()
    .describe("Captures in image order (the last one is the final state)"),
  diagnostics: z.array(uiDiagnosticSchema).optional().describe("UI diagnostics of the final state (simulator 2.2+)"),
  mem: z
    .object({
      peak_bytes: z.number(),
      used_bytes: z.number().optional(),
      frag_pct: z.number().optional(),
      budget_bytes: z.number().optional(),
      over_budget: z.boolean().optional(),
    })
    .passthrough()
    .optional(),
  fonts_used: z.array(z.string()).optional(),
  events: z.array(z.record(z.unknown())).optional(),
  input: z.record(z.unknown()).optional(),
  warnings: z.array(diagnosticSchema),
  logs: z.array(z.string()),
  stdout: z.string(),
  notes: z.array(z.string()).optional(),
  binary: z.enum(["built", "prebuilt"]).optional(),
  compile_ms: z.number(),
  run_ms: z.number(),
  compile_cached: z.boolean(),
  tree: z.record(z.unknown()).optional().describe("Full widget tree of the final state (only with include_tree=\"full\")"),
};
