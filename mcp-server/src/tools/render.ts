import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { RenderHistory } from "../history.js";
import { SimulatorError } from "../simulator/errors.js";
import {
  ProjectPathError,
  defaultAllowedRoots,
  isCIdentifier,
  isValidDefine,
  resolveProjectRoot,
  validateRelativePath,
} from "../simulator/project.js";
import type {
  ColorFormat,
  ProjectRequest,
  RenderMode,
  RenderRequest,
  RenderResult,
  Rotation,
  SimAction,
  SimulatorBackend,
  Theme,
} from "../simulator/types.js";
import { formatRenderText, imageList, summarizeTree, treeForOutput, type IncludeTree } from "./format.js";
import { ACTIONS_DESCRIPTION, actionsSchema, espShimsSchema, renderOptionsShape, renderOutputShape, SIMULATOR_FACTS } from "./schemas.js";

/** Common render arguments (snake_case, as validated by the schemas). */
export interface RenderArgs {
  code?: string;
  width?: number;
  height?: number;
  time_ms: number;
  settle: boolean;
  rotation?: Rotation;
  theme: Theme;
  dpi?: number;
  assets_dir?: string;
  include_tree: IncludeTree;
  board?: string;
  color_format?: ColorFormat;
  scale?: number;
  fonts?: string[];
  mem_budget_kb?: number;
  annotate: boolean;
  frames?: number[];
  actions?: SimAction[];
  esp_shims?: boolean;
}

export interface ProjectArgs extends RenderArgs {
  files?: Array<{ path: string; content: string }>;
  root?: string;
  include_dirs?: string[];
  defines?: string[];
  exclude?: string[];
  entry: string;
}

export interface InteractArgs extends ProjectArgs {
  full: boolean;
  ui?: Record<string, unknown>;
}

/** Convert any thrown error into an MCP error result. */
export function errorResult(err: unknown): CallToolResult {
  const message =
    err instanceof SimulatorError || err instanceof ProjectPathError
      ? err.message
      : `Internal error: ${err instanceof Error ? err.message : String(err)}`;
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Map validated tool arguments to a backend request (mode-specific fields are added by the caller). */
export function toRenderRequest(args: RenderArgs, mode: RenderMode): RenderRequest {
  return {
    code: args.code ?? "",
    full: mode === "full",
    mode,
    width: args.width,
    height: args.height,
    timeMs: args.time_ms,
    settle: args.settle,
    rotation: args.rotation,
    theme: args.theme,
    dpi: args.dpi,
    assetsDir: args.assets_dir,
    board: args.board,
    colorFormat: args.color_format,
    scale: args.scale,
    fonts: args.fonts,
    memBudgetKb: args.mem_budget_kb,
    annotate: args.annotate,
    frames: args.frames,
    actions: args.actions,
    espShims: args.esp_shims ?? (mode === "project"),
  };
}

export function renderResultToTool(r: RenderResult, include: IncludeTree, renderId: string): CallToolResult {
  const summary = summarizeTree(r.output);
  const { text, treeOpts } = formatRenderText(r, include, summary, renderId);
  const out = r.output;
  const structured: Record<string, unknown> = {
    render_id: renderId,
    width: r.pngWidth,
    height: r.pngHeight,
    rotation: r.params.rotation,
    theme: r.params.theme,
    mode: r.params.mode ?? (r.params.full ? "full" : "snippet"),
    board: r.params.board,
    color_format: out.display.color_format ?? r.params.colorFormat,
    scale: out.display.scale ?? r.params.scale,
    lvgl_version: out.lvgl_version,
    format_version: out.format_version,
    elapsed_ms: out.elapsed_ms,
    anims_running: out.anims_running,
    widget_count: summary.widget_count,
    counts_by_type: summary.counts_by_type,
    issues: summary.issues,
    named: summary.named,
    captures: (r.captures ?? []).map((c) => ({
      n: c.n,
      label: c.label,
      elapsed_ms: c.elapsedMs,
      annotated: !!c.annotated,
      ...(c.screen ? { widget_count: summarizeTree({ ...out, screen: c.screen, layer_top: c.layerTop, layer_sys: undefined }).widget_count } : {}),
    })),
    diagnostics: out.diagnostics,
    mem: out.mem,
    fonts_used: out.fonts_used,
    events: out.events,
    input: out.input,
    warnings: r.warnings,
    logs: r.logs.slice(-100),
    stdout: r.stdout.slice(0, 4000),
    notes: r.notes ?? [],
    binary: r.binary,
    compile_ms: r.compileMs,
    run_ms: r.runMs,
    compile_cached: r.compileCached,
  };
  for (const k of Object.keys(structured)) if (structured[k] === undefined) delete structured[k];
  if (include === "full" && treeOpts) structured["tree"] = treeForOutput(out, treeOpts);
  return {
    content: [
      ...imageList(r).map((img) => ({ type: "image" as const, data: img.data.toString("base64"), mimeType: "image/png" })),
      { type: "text", text },
    ],
    structuredContent: structured,
  };
}

/** Render through the backend, remember it in the history, format the result. */
export async function runRender(
  backend: SimulatorBackend,
  history: RenderHistory,
  tool: string,
  req: RenderRequest,
  include: IncludeTree,
  signal: AbortSignal | undefined
): Promise<CallToolResult> {
  try {
    if (req.frames?.length && req.actions?.length) {
      throw new SimulatorError(
        "args",
        'Pass either frames or actions, not both (add {"wait": ms} and {"capture": "label"} steps to the actions instead).'
      );
    }
    const r = await backend.render(req, signal);
    const entry = history.add(r, tool);
    return renderResultToTool(r, include, entry.id);
  } catch (err) {
    return errorResult(err);
  }
}

// ---------------------------------------------------------------------------
// Project mode: argument validation (paths, roots)
// ---------------------------------------------------------------------------

/** Filesystem roots the MCP client exposes (empty when it does not support roots). */
export async function clientRoots(server: McpServer): Promise<string[]> {
  const caps = server.server.getClientCapabilities();
  if (!caps?.roots) return [];
  try {
    const res = await server.server.listRoots(undefined, { timeout: 5000 });
    return res.roots.filter((r) => r.uri.startsWith("file://")).map((r) => fileURLToPath(r.uri));
  } catch {
    return [];
  }
}

/**
 * Validate the project arguments and build the backend's ProjectRequest.
 * Inline file paths must be relative without "..", `root` must realpath
 * inside an allowed root, include dirs must stay inside the project (or an
 * allowed root when absolute).
 */
export async function buildProjectRequest(
  args: Pick<ProjectArgs, "files" | "root" | "include_dirs" | "defines" | "exclude" | "entry">,
  allowedRoots: () => Promise<string[]>
): Promise<ProjectRequest> {
  const hasFiles = !!args.files?.length;
  if (hasFiles === !!args.root) {
    throw new ProjectPathError("Pass exactly one of `files` (inline sources) or `root` (a project directory).");
  }
  if (!isCIdentifier(args.entry)) throw new ProjectPathError(`entry "${args.entry}" is not a C identifier`);
  for (const d of args.defines ?? []) if (!isValidDefine(d)) throw new ProjectPathError(`invalid define "${d}" (expected NAME or NAME=value)`);
  const req: ProjectRequest = { entry: args.entry, defines: args.defines, exclude: args.exclude };
  if (hasFiles) {
    req.files = args.files!.map((f) => ({ path: validateRelativePath(f.path, "file path"), content: f.content }));
    const srcs = req.files.filter((f) => /\.(c|cpp|cc|cxx)$/i.test(f.path));
    if (srcs.length === 0) throw new ProjectPathError("`files` contains no .c/.cpp source");
    req.includeDirs = (args.include_dirs ?? []).map((d) => validateRelativePath(d, "include dir"));
    return req;
  }
  const allowed = await allowedRoots();
  const root = await resolveProjectRoot(args.root!, allowed);
  req.root = root;
  req.includeDirs = [];
  for (const d of args.include_dirs ?? []) {
    if (path.isAbsolute(d)) {
      // Absolute include dirs must lie in the project or an allowed root.
      req.includeDirs.push(await resolveProjectRoot(d, [root, ...allowed]));
    } else {
      req.includeDirs.push(validateRelativePath(d, "include dir"));
    }
  }
  return req;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const MAX_UI_BYTES = 2 * 1024 * 1024;

export const UI_DOC_SUMMARY =
  "JSON UI document (this project's own format; LVGL's XML is LVGL Pro only and not supported). Root = the screen: {\"type\": \"lv_obj\", \"styles\": {...}, \"children\": [nodes]}. " +
  "Node keys: type (lv_obj, lv_label, lv_button, lv_image, lv_slider, lv_bar, lv_arc, lv_switch, lv_checkbox, lv_dropdown, lv_roller, lv_textarea, lv_spinner, lv_led, lv_line, lv_chart, lv_table, lv_buttonmatrix, lv_tabview, lv_msgbox, lv_spinbox, lv_scale, lv_list), name, x, y, w, h (px, \"content\" or \"50%\"), align (top_left..bottom_right, center), hidden, states [\"checked\",\"disabled\",\"focused\"], flags ([\"-scrollable\"] removes), text, placeholder, long_mode, value/min/max, checked, options/selected, src (\"S:file.png\" or \"symbol:OK\"), layout ({\"type\":\"flex\",\"flow\":\"row|column\",\"main\":\"space_between\",...} or grid), children. " +
  "Styles use the widget-tree names: styles (main part) and indicator, knob, selected, items, cursor, scrollbar blocks, state variants styles_pressed/styles_checked/...; keys bg_color, bg_opa, bg_grad_color, bg_grad_dir, border_*, radius, pad_*, shadow_*, text_color, font (\"montserrat_20\"), text_align, arc_*, line_*, opa, transform_*; colours \"#rrggbb\". " +
  "Top level may add theme, layer_top [nodes], animations [{target, prop, from, to, duration, repeat, playback, path}], screens {name: node} + active. Unknown keys are errors, all reported as `ui: <json-path>: <message>`. Full schema and 3 examples: lvgl_docs \"ui-json\".";

export const uiSchema = z.record(z.string(), z.unknown()).describe(UI_DOC_SUMMARY);

export const projectShape = {
  files: z
    .array(
      z
        .object({
          path: z.string().min(1).max(512).describe("Project-relative path, e.g. \"ui/ui.c\" or \"ui/screens/ui_Home.c\" (no absolute paths, no \"..\")."),
          content: z.string().max(4 * 1024 * 1024).describe("File contents."),
        })
        .strict()
    )
    .min(1)
    .max(1000)
    .optional()
    .describe("Inline project files (.c/.cpp compiled, .h on the include path). Use this OR root."),
  root: z
    .string()
    .min(1)
    .max(4096)
    .optional()
    .describe("Absolute path of a project directory on this machine (must be inside one of the MCP client's roots, LVGL_ALLOWED_ROOTS or the server's working directory). All .c/.cpp files below it are compiled (build/, .git/, managed_components/ ... are skipped). Use this OR files."),
  include_dirs: z
    .array(z.string().min(1).max(1024))
    .max(64)
    .optional()
    .describe("Extra include directories, relative to the project root. The root and every directory containing headers are on the include path already."),
  defines: z
    .array(z.string().min(1).max(256))
    .max(64)
    .optional()
    .describe("Preprocessor defines for the project sources: \"NAME\" or \"NAME=value\"."),
  exclude: z
    .array(z.string().min(1).max(256))
    .max(64)
    .optional()
    .describe("Glob patterns (relative to the root) of files/directories not to compile, e.g. [\"main/main.c\", \"drivers/**\"] - keep hardware code (app_main, LCD/touch drivers) out."),
  entry: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, "entry must be a C identifier")
    .default("ui_init")
    .describe("Function the simulator calls to build the UI: void entry(void) with C linkage (default \"ui_init\" as in SquareLine/EEZ exports). Use \"create_ui\" if the project defines that itself."),
};

export interface RenderToolDeps {
  backend: SimulatorBackend;
  history: RenderHistory;
  /** Allowed roots for `root` (MCP client roots, LVGL_ALLOWED_ROOTS, cwd). */
  allowedRoots: () => Promise<string[]>;
}

export function registerRenderTools(server: McpServer, backend: SimulatorBackend, history: RenderHistory): void {
  const deps: RenderToolDeps = {
    backend,
    history,
    allowedRoots: async () => defaultAllowedRoots(await clientRoots(server)),
  };

  server.registerTool(
    "lvgl_render",
    {
      title: "Render LVGL snippet",
      description: [
        "Compile and run an LVGL C code snippet in a headless simulator and return PNG screenshot(s), UI diagnostics and a widget-tree summary.",
        "Snippet mode: your code is pasted inside the body of `void create_ui(void)`; a variable `lv_obj_t *screen = lv_screen_active();` is already defined - use it as the parent. lvgl.h, stdio.h, stdlib.h, string.h, stdint.h and stdbool.h are included. Helper functions, static event callbacks, #includes or #defines at file scope need lvgl_render_full instead.",
        "Compiler errors/warnings reference snippet.c line numbers (line 1 = first line of your code). printf output is returned.",
        SIMULATOR_FACTS,
        "Use lvgl_check to only compile, lvgl_inspect for the full JSON widget tree (positions, styles, states), lvgl_diff to compare two renders.",
      ].join("\n\n"),
      inputSchema: {
        code: z
          .string()
          .min(1)
          .describe("C statements for the body of create_ui(). Example: lv_obj_t *btn = lv_button_create(screen); lv_obj_set_name(btn, \"ok_btn\"); lv_obj_center(btn);"),
        ...renderOptionsShape,
        esp_shims: espShimsSchema.default(false),
      },
      outputSchema: renderOutputShape,
      annotations,
    },
    async (args, extra) => {
      const a = args as RenderArgs;
      return runRender(backend, history, "lvgl_render", toRenderRequest(a, "snippet"), a.include_tree, extra.signal);
    }
  );

  server.registerTool(
    "lvgl_render_full",
    {
      title: "Render complete LVGL C file",
      description: [
        "Compile and run a complete C source file in the headless LVGL simulator and return PNG screenshot(s), UI diagnostics and a widget-tree summary.",
        "The file must `#include \"lvgl.h\"` and define a global `void create_ui(void)` that builds the UI on lv_screen_active(). It may contain helper functions, static callbacks, styles, image descriptors (C arrays) and #defines - e.g. paste a screen file from your ESP32 project (esp_shims=true for ESP_LOGx/vTaskDelay/FreeRTOS includes). Do not call lv_init(), create displays or run lv_timer_handler(); the simulator does that. `#include \"sim.h\"` gives sim_advance_ms/sim_capture/sim_log.",
        "Diagnostics reference user_code.c line numbers (= lines of your file).",
        SIMULATOR_FACTS,
      ].join("\n\n"),
      inputSchema: {
        code: z.string().min(1).describe("Complete C file with #include \"lvgl.h\" and void create_ui(void) { ... }."),
        ...renderOptionsShape,
        esp_shims: espShimsSchema.default(false),
      },
      outputSchema: renderOutputShape,
      annotations,
    },
    async (args, extra) => {
      const a = args as RenderArgs;
      return runRender(backend, history, "lvgl_render_full", toRenderRequest(a, "full"), a.include_tree, extra.signal);
    }
  );

  server.registerTool(
    "lvgl_render_ui",
    {
      title: "Render a JSON UI document (no compiler)",
      description: [
        "Render a UI described as a JSON document - no C code, no compilation, works even on machines without a C toolchain (prebuilt simulator). The fastest way to try layouts and styles; the vocabulary is exactly the one the widget tree of every render uses (same type names and style keys), so you can copy values from a tree into a document and back.",
        "LVGL's own XML format is part of LVGL Pro and is not supported here; this JSON format is this project's own and maps 1:1 to LVGL calls. Invalid documents fail with every problem listed as `ui: <json-path>: <message>`.",
        "Actions, frames, annotate, board presets, device fonts, memory budget and UI diagnostics work as in C mode. Schema and examples: lvgl_docs \"ui-json\".",
      ].join("\n\n"),
      inputSchema: {
        ui: uiSchema,
        ...renderOptionsShape,
      },
      outputSchema: renderOutputShape,
      annotations,
    },
    async (args, extra) => {
      const a = args as RenderArgs & { ui: Record<string, unknown> };
      const size = Buffer.byteLength(JSON.stringify(a.ui), "utf-8");
      if (size > MAX_UI_BYTES) return errorResult(new SimulatorError("args", `ui document is ${size} bytes (max ${MAX_UI_BYTES}).`));
      return runRender(backend, history, "lvgl_render_ui", { ...toRenderRequest(a, "ui"), ui: a.ui }, a.include_tree, extra.signal);
    }
  );

  server.registerTool(
    "lvgl_render_project",
    {
      title: "Render a multi-file LVGL C project",
      description: [
        "Compile a multi-file LVGL C/C++ project (e.g. a SquareLine Studio or EEZ Studio export, or the ui/ folder of an ESP-IDF app) and render it: all .c/.cpp files are compiled and the simulator calls your entry function (default `ui_init`) instead of create_ui().",
        "Pass the files inline (`files`: [{path, content}], written to a private build directory) or point `root` at a directory on this machine inside the client's roots / LVGL_ALLOWED_ROOTS / the server's working directory. The root and every directory with headers are on the include path; add include_dirs/defines as needed and `exclude` hardware code (app_main, LCD/touch drivers).",
        "ESP-IDF shims are ON by default here (esp_log.h, freertos/*.h, esp_timer.h, esp_lvgl_port.h lock/unlock ... compile unchanged). Diagnostics keep the project-relative file names.",
        SIMULATOR_FACTS,
      ].join("\n\n"),
      inputSchema: {
        ...projectShape,
        ...renderOptionsShape,
        esp_shims: espShimsSchema.default(true),
      },
      outputSchema: renderOutputShape,
      annotations,
    },
    async (args, extra) => {
      const a = args as ProjectArgs;
      try {
        const project = await buildProjectRequest(a, deps.allowedRoots);
        return runRender(backend, history, "lvgl_render_project", { ...toRenderRequest(a, "project"), project }, a.include_tree, extra.signal);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "lvgl_interact",
    {
      title: "Interact with an LVGL UI (click, type, see)",
      description: [
        "Render a UI and drive it with an action script - click buttons, drag sliders, press keys, type into textareas, switch screens - through real LVGL input devices, and get one image per capture plus the events that fired. Same as the render tools with `actions` (same implementation).",
        "Give exactly one UI source: `code` (C snippet; full=true for a complete C file), `ui` (JSON UI document), or a project (`files` or `root`, with entry/include_dirs/defines/exclude).",
        "Name the objects you want to interact with (lv_obj_set_name / \"name\" in JSON UI) and target them by name; tree paths like \"lv_button#2\" and {x, y} coordinates work too. Add {\"capture\": \"label\"} steps to see intermediate states; the final state is always captured.",
      ].join("\n\n"),
      inputSchema: {
        code: z.string().min(1).optional().describe("C snippet (body of create_ui) or, with full=true, a complete C file defining create_ui()."),
        full: z.boolean().default(false).describe("Treat `code` as a complete C file (like lvgl_render_full)."),
        ui: uiSchema.optional(),
        ...projectShape,
        ...renderOptionsShape,
        actions: actionsSchema.describe(ACTIONS_DESCRIPTION),
        esp_shims: espShimsSchema.optional().describe("ESP-IDF shims (default: true for projects, false otherwise). See lvgl_docs \"esp32\"."),
      },
      outputSchema: renderOutputShape,
      annotations,
    },
    async (args, extra) => {
      const a = args as InteractArgs;
      try {
        const sources = [a.code !== undefined, a.ui !== undefined, !!a.files?.length || !!a.root].filter(Boolean).length;
        if (sources !== 1) {
          throw new SimulatorError("args", "Pass exactly one UI source: `code`, `ui`, or a project (`files` or `root`).");
        }
        let req: RenderRequest;
        if (a.code !== undefined) req = toRenderRequest(a, a.full ? "full" : "snippet");
        else if (a.ui !== undefined) req = { ...toRenderRequest(a, "ui"), ui: a.ui };
        else req = { ...toRenderRequest(a, "project"), project: await buildProjectRequest(a, deps.allowedRoots) };
        return runRender(backend, history, "lvgl_interact", req, a.include_tree, extra.signal);
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}
