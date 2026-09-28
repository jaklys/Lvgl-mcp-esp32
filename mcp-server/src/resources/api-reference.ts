import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BOARDS } from "../boards.js";
import type { SimulatorBackend } from "../simulator/types.js";
import { apiReference } from "./docs/index.js";

/** The lvgl://api-reference text: the concatenation of the lvgl_docs topics. */
export const LVGL_API_CHEATSHEET = apiReference();

export function registerResources(server: McpServer, backend: SimulatorBackend): void {
  server.registerResource(
    "api-reference",
    "lvgl://api-reference",
    {
      title: "LVGL 9.6 API quick reference",
      description:
        "LVGL 9.6 cheat sheet for the simulator: tools overview, simulator constraints, widgets, layouts, styles, events, timers/animations, fonts, symbols, functions deprecated in 9.6 and the v8->v9 rename table, actions, JSON UI documents, UI diagnostics, ESP32 notes and board presets. The same text by topic: lvgl_docs.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, text: LVGL_API_CHEATSHEET, mimeType: "text/markdown" }],
    })
  );

  server.registerResource(
    "project-config",
    "lvgl://project-config",
    {
      title: "Simulator configuration",
      description:
        "Current simulator configuration: default resolution, LVGL version (from the last render), color formats, timeouts, simulator/build paths, prebuilt artifacts and toolchain status.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, text: JSON.stringify(backend.getConfig(), null, 2), mimeType: "application/json" }],
    })
  );

  server.registerResource(
    "boards",
    "lvgl://boards",
    {
      title: "Board presets",
      description:
        "ESP32 board presets for the `board` render parameter: id, name, resolution, color format, DPI, rotation, typical LV_MEM_SIZE (KB), panel and notes.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, text: JSON.stringify(BOARDS, null, 2), mimeType: "application/json" }],
    })
  );
}
