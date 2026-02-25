import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SimulatorManager } from "../simulator/manager.js";

export function registerInspectTools(
  server: McpServer,
  manager: SimulatorManager
): void {
  server.tool(
    "lvgl_inspect",
    "Get the widget tree as JSON for an LVGL UI. Provides type, position, size, and widget-specific properties (text, value, checked state) for every widget.",
    {
      code: z
        .string()
        .optional()
        .describe(
          "LVGL C code snippet to render and inspect. Omit to inspect the last rendered UI."
        ),
    },
    async ({ code }) => {
      try {
        let result;
        if (code) {
          result = await manager.render(code, false);
        } else {
          result = manager.getLastResult();
        }

        if (!result?.widgetTree) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No widget tree available. Render some LVGL code first using lvgl_render.",
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result.widgetTree, null, 2),
            },
          ],
        };
      } catch (err: unknown) {
        const error = err as Error;
        return {
          content: [{ type: "text" as const, text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    }
  );
}
