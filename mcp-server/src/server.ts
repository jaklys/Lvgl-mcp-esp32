import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerResources } from "./resources/api-reference.js";
import type { SimulatorBackend } from "./simulator/types.js";
import { registerCheckTools } from "./tools/check.js";
import { registerConfigTools } from "./tools/config.js";
import { registerInspectTools } from "./tools/inspect.js";
import { registerRenderTools } from "./tools/render.js";

export interface CreateServerOptions {
  backend: SimulatorBackend;
  version: string;
}

export const SERVER_INSTRUCTIONS =
  "Headless LVGL 9.6 simulator for ESP32 UI work. Write LVGL C code, call lvgl_render (snippet inside create_ui with `screen` predefined) or lvgl_render_full (complete file defining void create_ui(void)) and look at the PNG + widget summary; iterate until it looks right. Use lvgl_check for fast compile-only checks and lvgl_inspect for exact positions/styles. Read lvgl://api-reference for 9.6 names, 9.6 deprecations and v8->v9 renames.";

/** Build the MCP server with all tools and resources registered (no transport). */
export function createServer(opts: CreateServerOptions): McpServer {
  const server = new McpServer(
    { name: "lvgl-simulator", title: "LVGL Simulator", version: opts.version },
    { instructions: SERVER_INSTRUCTIONS }
  );
  registerRenderTools(server, opts.backend);
  registerInspectTools(server, opts.backend);
  registerCheckTools(server, opts.backend);
  registerConfigTools(server, opts.backend);
  registerResources(server, opts.backend);
  return server;
}
