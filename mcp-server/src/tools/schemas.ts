import { z } from "zod";

/** Facts every render-ish tool description repeats for the model. */
export const SIMULATOR_FACTS = [
  "Environment: LVGL 9.6 API, not v8 - use v9 names (lv_button_create, lv_screen_active, lv_image_*, lv_obj_remove_flag, LV_LABEL_LONG_MODE_*); v8 lv_msgbox_create/lv_tabview_create/lv_spinner_create signatures and lv_meter/lv_colorwheel do not exist. Code must also work on 9.5 devices? Avoid 9.6-only calls (lv_obj_set_hidden, lv_obj_set_checked, lv_label_set_max_lines); see resource lvgl://api-reference. C11, 32 bpp XRGB8888 framebuffer.",
  "Fonts: lv_font_montserrat_8 .. lv_font_montserrat_48 (even sizes) and unscii_8/16 exist here, but on the ESP32 only the sizes enabled in the device's lv_conf.h exist - stick to the sizes the target firmware enables.",
  "Images: C arrays (lv_image_dsc_t) or \"S:<file>\" paths (PNG/BMP/JPG) resolved relative to assets_dir.",
  "Time: ~330 ms of simulated time is advanced before capture (time_ms; settle=true waits for animations). No input devices: nothing can be clicked, pressed, focused or scrolled by a user; set states (lv_obj_add_state) to preview them.",
  "Crashes (NULL/deleted objects), LVGL assertions and infinite loops are caught and reported with the LVGL log.",
].join("\n");

export const widthSchema = z
  .number()
  .int()
  .min(16)
  .max(4096)
  .optional()
  .describe("Display width in px for THIS call only (default: the lvgl_set_resolution default, initially 800).");
export const heightSchema = z
  .number()
  .int()
  .min(16)
  .max(4096)
  .optional()
  .describe("Display height in px for THIS call only (default: the lvgl_set_resolution default, initially 480).");

export const renderOptionsShape = {
  width: widthSchema,
  height: heightSchema,
  time_ms: z
    .number()
    .int()
    .min(0)
    .max(10000)
    .default(330)
    .describe("Simulated time in ms to advance (timers, animations) before the screenshot. Default 330."),
  settle: z
    .boolean()
    .default(false)
    .describe("After time_ms keep advancing until no animation is running (max 3000 ms total). Use for spinners/animated value changes."),
  rotation: z
    .union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)])
    .default(0)
    .describe("Display rotation in degrees (lv_display_set_rotation). 90/270 swap the PNG width and height."),
  theme: z
    .enum(["light", "dark"])
    .default("light")
    .describe("Default theme mode applied before your code runs (lv_theme_default_init)."),
  dpi: z
    .number()
    .int()
    .min(50)
    .max(600)
    .default(130)
    .describe("Display DPI (affects lv_dpx() and theme paddings). Default 130 like LVGL's default."),
  assets_dir: z
    .string()
    .optional()
    .describe("Absolute directory that \"S:<file>\" image/font paths are resolved against. Default: the server's working directory (or LVGL_ASSETS_DIR)."),
  include_tree: z
    .enum(["summary", "full", "none"])
    .default("summary")
    .describe("\"summary\" (default): widget counts, names, texts, hidden/off-screen/overflowing widgets. \"full\": plus the compact JSON widget tree (large). \"none\": image and status only."),
};

export const diagnosticSchema = z.object({
  file: z.string(),
  line: z.number().int(),
  col: z.number().int().optional(),
  severity: z.enum(["error", "warning", "note"]),
  message: z.string(),
  code: z.string().optional(),
});

export const renderOutputShape = {
  width: z.number().int().describe("PNG width in px (after rotation)"),
  height: z.number().int().describe("PNG height in px (after rotation)"),
  rotation: z.number().int(),
  theme: z.string(),
  mode: z.enum(["snippet", "full"]),
  lvgl_version: z.string(),
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
  warnings: z.array(diagnosticSchema),
  logs: z.array(z.string()),
  stdout: z.string(),
  compile_ms: z.number(),
  run_ms: z.number(),
  compile_cached: z.boolean(),
  tree: z.record(z.unknown()).optional().describe("Full widget tree (only with include_tree=\"full\")"),
};
