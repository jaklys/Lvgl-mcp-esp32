import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatDiagnostic } from "../simulator/diagnostics.js";
import type { SimulatorBackend } from "../simulator/types.js";
import { errorResult } from "./render.js";
import { diagnosticSchema } from "./schemas.js";

export function registerCheckTools(server: McpServer, backend: SimulatorBackend): void {
  server.registerTool(
    "lvgl_check",
    {
      title: "Compile-check LVGL code",
      description: [
        "Compile (and link) LVGL C code against the simulator's LVGL 9.6 build WITHOUT running it; returns structured diagnostics (file, line, col, severity, message). Faster than rendering when you only need to know whether code compiles, e.g. after porting v8 code.",
        "full=false (default): `code` is a snippet placed inside `void create_ui(void)` with `lv_obj_t *screen` defined; diagnostics use snippet.c line numbers. full=true: `code` is a complete C file that must define `void create_ui(void)`; diagnostics use user_code.c line numbers.",
        "Compiled as C11 with -Wall -Wextra (implicit function declarations, int-conversion and incompatible-pointer-types are errors). A failed compile is reported as a normal result with ok=false, not as a tool error.",
      ].join("\n\n"),
      inputSchema: {
        code: z.string().min(1).describe("Snippet (body of create_ui) or complete C file when full=true."),
        full: z.boolean().default(false).describe("true = complete C file defining void create_ui(void)."),
      },
      outputSchema: {
        ok: z.boolean(),
        errors: z.number().int(),
        warnings: z.number().int(),
        diagnostics: z.array(diagnosticSchema),
        hints: z.array(z.string()),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ code, full }, extra) => {
      try {
        const r = await backend.check(code, full, extra.signal);
        const errors = r.diagnostics.filter((d) => d.severity === "error").length;
        const warnings = r.diagnostics.filter((d) => d.severity === "warning").length;
        let text = r.success
          ? `Compiles OK (${warnings} warning${warnings === 1 ? "" : "s"}).`
          : `Compilation failed (${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}).`;
        // Prefer the cleaned compiler output (it has the source line + caret);
        // fall back to the structured list.
        if (!r.success && r.output) text += "\n" + r.output;
        else if (r.diagnostics.length) text += "\n" + r.diagnostics.map(formatDiagnostic).join("\n");
        if (r.hints.length) text += "\n\nHints:\n" + r.hints.map((h) => `- ${h}`).join("\n");
        return {
          content: [{ type: "text", text }],
          structuredContent: { ok: r.success, errors, warnings, diagnostics: r.diagnostics, hints: r.hints },
        };
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}
