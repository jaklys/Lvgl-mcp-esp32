import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SimulatorManager } from "../simulator/manager.js";

export function registerConfigTools(
  server: McpServer,
  manager: SimulatorManager
): void {
  server.tool(
    "lvgl_set_resolution",
    "Set the virtual display resolution for LVGL rendering. Common ESP32 display sizes: 320x240, 480x320, 800x480.",
    {
      width: z
        .number()
        .min(100)
        .max(2048)
        .describe("Display width in pixels"),
      height: z
        .number()
        .min(100)
        .max(2048)
        .describe("Display height in pixels"),
    },
    async ({ width, height }) => {
      manager.setResolution(width, height);
      return {
        content: [
          {
            type: "text" as const,
            text: `Display resolution set to ${width}x${height}. Next render will use this resolution.`,
          },
        ],
      };
    }
  );
}
