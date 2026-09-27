import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { SimulatorError } from "../simulator/errors.js";
import type { RenderResult, Rotation, SimulatorBackend, Theme } from "../simulator/types.js";
import { formatRenderText, summarizeTree, treeForOutput, type IncludeTree } from "./format.js";
import { renderOutputShape, renderOptionsShape, SIMULATOR_FACTS } from "./schemas.js";

export interface RenderArgs {
  code: string;
  width?: number;
  height?: number;
  time_ms: number;
  settle: boolean;
  rotation: Rotation;
  theme: Theme;
  dpi: number;
  assets_dir?: string;
  include_tree: IncludeTree;
}

/** Convert any thrown error into an MCP error result. */
export function errorResult(err: unknown): CallToolResult {
  const message =
    err instanceof SimulatorError
      ? err.message
      : `Internal error: ${err instanceof Error ? err.message : String(err)}`;
  return { content: [{ type: "text", text: message }], isError: true };
}

export function renderResultToTool(r: RenderResult, include: IncludeTree): CallToolResult {
  const summary = summarizeTree(r.output);
  const { text, treeOpts } = formatRenderText(r, include, summary);
  const structured: Record<string, unknown> = {
    width: r.pngWidth,
    height: r.pngHeight,
    rotation: r.params.rotation,
    theme: r.params.theme,
    mode: r.params.full ? "full" : "snippet",
    lvgl_version: r.output.lvgl_version,
    elapsed_ms: r.output.elapsed_ms,
    anims_running: r.output.anims_running,
    widget_count: summary.widget_count,
    counts_by_type: summary.counts_by_type,
    issues: summary.issues,
    named: summary.named,
    warnings: r.warnings,
    logs: r.logs.slice(-100),
    stdout: r.stdout.slice(0, 4000),
    compile_ms: r.compileMs,
    run_ms: r.runMs,
    compile_cached: r.compileCached,
  };
  if (include === "full" && treeOpts) structured["tree"] = treeForOutput(r.output, treeOpts);
  return {
    content: [
      { type: "image", data: r.png.toString("base64"), mimeType: "image/png" },
      { type: "text", text },
    ],
    structuredContent: structured,
  };
}

async function doRender(
  backend: SimulatorBackend,
  args: RenderArgs,
  full: boolean,
  signal: AbortSignal | undefined
): Promise<CallToolResult> {
  try {
    const r = await backend.render(
      {
        code: args.code,
        full,
        width: args.width,
        height: args.height,
        timeMs: args.time_ms,
        settle: args.settle,
        rotation: args.rotation,
        theme: args.theme,
        dpi: args.dpi,
        assetsDir: args.assets_dir,
      },
      signal
    );
    return renderResultToTool(r, args.include_tree);
  } catch (err) {
    return errorResult(err);
  }
}

const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export function registerRenderTools(server: McpServer, backend: SimulatorBackend): void {
  server.registerTool(
    "lvgl_render",
    {
      title: "Render LVGL snippet",
      description: [
        "Compile and run an LVGL C code snippet in a headless simulator and return a PNG screenshot plus a widget-tree summary.",
        "Snippet mode: your code is pasted inside the body of `void create_ui(void)`; a variable `lv_obj_t *screen = lv_screen_active();` is already defined - use it as the parent. lvgl.h, stdio.h, stdlib.h, string.h, stdint.h and stdbool.h are included. Helper functions, static event callbacks, #includes or #defines at file scope need lvgl_render_full instead.",
        "Compiler errors/warnings reference snippet.c line numbers (line 1 = first line of your code). printf output is returned.",
        SIMULATOR_FACTS,
        "Use lvgl_check to only compile, lvgl_inspect for the full JSON widget tree (positions, styles, states).",
      ].join("\n\n"),
      inputSchema: {
        code: z
          .string()
          .min(1)
          .describe("C statements for the body of create_ui(). Example: lv_obj_t *btn = lv_button_create(screen); lv_obj_center(btn);"),
        ...renderOptionsShape,
      },
      outputSchema: renderOutputShape,
      annotations,
    },
    async (args, extra) => doRender(backend, args as RenderArgs, false, extra.signal)
  );

  server.registerTool(
    "lvgl_render_full",
    {
      title: "Render complete LVGL C file",
      description: [
        "Compile and run a complete C source file in the headless LVGL simulator and return a PNG screenshot plus a widget-tree summary.",
        "The file must `#include \"lvgl.h\"` and define a global `void create_ui(void)` that builds the UI on lv_screen_active(). It may contain helper functions, static callbacks, styles, image descriptors (C arrays) and #defines - e.g. paste a screen file from your ESP32 project. Do not call lv_init(), create displays or run lv_timer_handler(); the simulator does that.",
        "Diagnostics reference user_code.c line numbers (= lines of your file).",
        SIMULATOR_FACTS,
      ].join("\n\n"),
      inputSchema: {
        code: z.string().min(1).describe("Complete C file with #include \"lvgl.h\" and void create_ui(void) { ... }."),
        ...renderOptionsShape,
      },
      outputSchema: renderOutputShape,
      annotations,
    },
    async (args, extra) => doRender(backend, args as RenderArgs, true, extra.signal)
  );
}
