import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RenderHistory } from "./history.js";
import { registerResources } from "./resources/api-reference.js";
import type { SimulatorBackend } from "./simulator/types.js";
import { registerCheckTools } from "./tools/check.js";
import { registerConfigTools } from "./tools/config.js";
import { registerDiffTools } from "./tools/diff.js";
import { registerDocsTools } from "./tools/docs.js";
import { registerInspectTools } from "./tools/inspect.js";
import { registerRenderTools } from "./tools/render.js";

export interface CreateServerOptions {
  backend: SimulatorBackend;
  version: string;
}

export const SERVER_INSTRUCTIONS =
  "Headless LVGL 9.6 simulator for ESP32 UI work. Write LVGL C code, call lvgl_render (snippet inside create_ui with `screen` predefined), lvgl_render_full (complete file defining void create_ui(void)), lvgl_render_project (multi-file project, entry ui_init) or lvgl_render_ui (JSON UI document, no compiler) and look at the PNG(s), the UI diagnostics (clipped text, missing glyphs, low contrast, overlaps, memory over budget) and the widget summary; iterate until it looks right and diagnostics are clean. " +
  "Pass `board` to render like a specific ESP32 panel (resolution, RGB565, LV_MEM_SIZE budget) and `fonts` with the device's fonts. Name objects with lv_obj_set_name; drive the UI with `actions` / lvgl_interact (click, drag, type) and see one image per capture plus the events; `frames` shows animations over time; `annotate` outlines every object. " +
  "lvgl_diff compares two renders by render_id; lvgl_inspect gives exact positions/styles; lvgl_check compiles only. lvgl_docs returns 9.6 reference text by topic (widgets/<name>, styles, layouts, actions, ui-json, esp32, boards, v8-migration ...).";

/** Build the MCP server with all tools and resources registered (no transport). */
export function createServer(opts: CreateServerOptions): McpServer {
  const server = new McpServer(
    { name: "lvgl-simulator", title: "LVGL Simulator", version: opts.version },
    { instructions: SERVER_INSTRUCTIONS }
  );
  const history = new RenderHistory(20);
  registerRenderTools(server, opts.backend, history);
  registerInspectTools(server, opts.backend, history);
  registerDiffTools(server, history);
  registerDocsTools(server);
  registerCheckTools(server, opts.backend);
  registerConfigTools(server, opts.backend);
  registerResources(server, opts.backend);
  return server;
}
