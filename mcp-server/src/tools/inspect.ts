import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { RenderResult, SimulatorBackend } from "../simulator/types.js";
import { errorResult } from "./render.js";
import { findNodes, fitJson, INSPECT_TEXT_BUDGET, pruneNode, treeForOutput, type PruneOptions } from "./format.js";

export interface InspectArgs {
  code?: string;
  full: boolean;
  type?: string;
  name?: string;
  max_depth?: number;
  include_styles: boolean;
}

export function inspectResult(r: RenderResult, args: InspectArgs, source: string): CallToolResult {
  const out = r.output;
  const req: PruneOptions = { maxDepth: args.max_depth, includeStyles: args.include_styles };
  const filtered = !!(args.type || args.name);
  const matches = filtered ? findNodes(out, args.type, args.name) : [];

  const build = (o: PruneOptions): unknown =>
    filtered ? matches.map((m) => ({ path: m.path, ...pruneNode(m.node, o) })) : treeForOutput(out, o);
  const fitted = fitJson(build, req, INSPECT_TEXT_BUDGET);

  const header =
    `Widget tree of ${source} (LVGL ${out.lvgl_version}, display ${out.display.width}x${out.display.height}` +
    `, format_version ${out.format_version}). Coordinates: x/y/w/h relative to the parent's content area, abs = absolute screen px.` +
    (filtered
      ? `\n${matches.length} widget(s) match${args.type ? ` type=${args.type}` : ""}${args.name ? ` name=${args.name}` : ""}.`
      : "");
  const note = fitted.note ? `\n[Note: ${fitted.note}; narrow the query with type/name/max_depth or include_styles=false]` : "";

  const structured: Record<string, unknown> = {
    lvgl_version: out.lvgl_version,
    format_version: out.format_version,
    display: out.display,
    match_count: filtered ? matches.length : undefined,
    truncated: !!fitted.note,
  };
  if (fitted.opts) structured["result"] = build(fitted.opts);
  return {
    content: [{ type: "text", text: `${header}\n${fitted.text}${note}` }],
    structuredContent: structured,
  };
}

export function registerInspectTools(server: McpServer, backend: SimulatorBackend): void {
  server.registerTool(
    "lvgl_inspect",
    {
      title: "Inspect LVGL widget tree",
      description: [
        "Return the widget tree as compact JSON: type, name, position (x/y/w/h relative to parent, abs screen coords), hidden/visible, states, flags, text, values, layout, scroll overflow and main/indicator/knob styles (colors, font, paddings).",
        "Without `code` it inspects the most recent lvgl_render/lvgl_render_full result (no recompilation). With `code` it renders that code first (snippet mode unless full=true, default resolution).",
        "Filter with `type` (e.g. \"lv_label\" or \"label\") and/or `name` (lv_obj_set_name; `*` wildcards) to get just the matching widgets with their paths; limit depth with max_depth. Large trees are trimmed to fit ~60k characters.",
      ].join("\n\n"),
      inputSchema: {
        code: z
          .string()
          .optional()
          .describe("Optional LVGL code to render first. Omit to inspect the last render."),
        full: z
          .boolean()
          .default(false)
          .describe("Treat `code` as a complete C file defining create_ui() (like lvgl_render_full)."),
        type: z.string().optional().describe("Only widgets of this class, e.g. \"lv_button\", \"label\"."),
        name: z.string().optional().describe("Only widgets with this name (set via lv_obj_set_name); `*` is a wildcard."),
        max_depth: z
          .number()
          .int()
          .min(0)
          .max(64)
          .optional()
          .describe("Maximum depth below each returned node (0 = the node only). Default: unlimited."),
        include_styles: z
          .boolean()
          .default(true)
          .describe("Include styles/indicator/knob objects. Set false for a much smaller tree."),
      },
      outputSchema: {
        lvgl_version: z.string(),
        format_version: z.number(),
        display: z.record(z.unknown()),
        match_count: z.number().int().optional(),
        truncated: z.boolean(),
        result: z.unknown().optional().describe("Tree object (screen/layer_top/layer_sys) or list of matches"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (rawArgs, extra) => {
      const args = rawArgs as InspectArgs;
      try {
        let r: RenderResult | null;
        let source = "the last render";
        if (args.code) {
          r = await backend.render({ code: args.code, full: args.full }, extra.signal);
          source = "the rendered code";
        } else {
          r = backend.getLastResult();
        }
        if (!r) {
          return {
            content: [
              {
                type: "text",
                text: "No render yet. Call lvgl_render / lvgl_render_full first, or pass `code` to lvgl_inspect.",
              },
            ],
            isError: true,
          };
        }
        return inspectResult(r, args, source);
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}
