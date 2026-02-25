import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SimulatorManager } from "../simulator/manager.js";

export function registerRenderTools(
  server: McpServer,
  manager: SimulatorManager
): void {
  server.tool(
    "lvgl_render",
    "Compile and render an LVGL UI code snippet. The code should create widgets using the active screen (available as `screen` variable of type lv_obj_t*). Returns a PNG screenshot.",
    {
      code: z
        .string()
        .describe(
          "LVGL C code snippet that creates widgets. Use the `screen` variable as the parent. Example: lv_obj_t *btn = lv_button_create(screen);"
        ),
      width: z
        .number()
        .min(100)
        .max(2048)
        .optional()
        .describe("Display width in pixels (default: 800)"),
      height: z
        .number()
        .min(100)
        .max(2048)
        .optional()
        .describe("Display height in pixels (default: 480)"),
    },
    async ({ code, width, height }) => {
      if (width !== undefined && height !== undefined) {
        manager.setResolution(width, height);
      }

      try {
        const result = await manager.render(code, false);

        const content: Array<
          | { type: "image"; data: string; mimeType: string }
          | { type: "text"; text: string }
        > = [];

        content.push({
          type: "image" as const,
          data: result.pngBase64,
          mimeType: "image/png",
        });

        if (result.widgetTree) {
          content.push({
            type: "text" as const,
            text:
              "Widget tree:\n" +
              JSON.stringify(result.widgetTree, null, 2),
          });
        }

        content.push({
          type: "text" as const,
          text: `Render time: ${result.executionTime}ms`,
        });

        if (result.compilationWarnings) {
          content.push({
            type: "text" as const,
            text: `Compilation warnings:\n${result.compilationWarnings}`,
          });
        }

        return { content };
      } catch (err: unknown) {
        const error = err as Error;
        return {
          content: [{ type: "text" as const, text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "lvgl_render_full",
    "Compile and render a complete LVGL C file. The file must define: void create_ui(void). Include lvgl.h and use lv_screen_active() to get the screen.",
    {
      code: z
        .string()
        .describe(
          "Complete C source file with #include \"lvgl.h\" and a void create_ui(void) function."
        ),
    },
    async ({ code }) => {
      try {
        const result = await manager.render(code, true);

        const content: Array<
          | { type: "image"; data: string; mimeType: string }
          | { type: "text"; text: string }
        > = [];

        content.push({
          type: "image" as const,
          data: result.pngBase64,
          mimeType: "image/png",
        });

        if (result.widgetTree) {
          content.push({
            type: "text" as const,
            text:
              "Widget tree:\n" +
              JSON.stringify(result.widgetTree, null, 2),
          });
        }

        content.push({
          type: "text" as const,
          text: `Render time: ${result.executionTime}ms`,
        });

        return { content };
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
