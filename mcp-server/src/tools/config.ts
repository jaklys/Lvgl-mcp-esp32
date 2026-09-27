import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SimulatorBackend } from "../simulator/types.js";

export function registerConfigTools(server: McpServer, backend: SimulatorBackend): void {
  server.registerTool(
    "lvgl_set_resolution",
    {
      title: "Set default display resolution",
      description:
        "Set the DEFAULT display resolution used by lvgl_render / lvgl_render_full / lvgl_inspect when a call does not pass width/height (initially 800x480). Per-call width/height never change this default. Common ESP32 panels: 320x240, 240x320, 480x320, 480x272, 800x480, 1024x600, 240x240 (round).",
      inputSchema: {
        width: z.number().int().min(16).max(4096).describe("Default display width in px (16..4096)."),
        height: z.number().int().min(16).max(4096).describe("Default display height in px (16..4096)."),
      },
      outputSchema: {
        width: z.number().int(),
        height: z.number().int(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ width, height }) => {
      backend.setDefaults(width, height);
      return {
        content: [
          {
            type: "text",
            text: `Default display resolution set to ${width}x${height}. Renders without explicit width/height will use it.`,
          },
        ],
        structuredContent: { width, height },
      };
    }
  );
}
