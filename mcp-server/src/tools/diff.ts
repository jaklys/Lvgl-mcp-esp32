import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { formatObjectDiff, objectDiff, pixelDiff } from "../diff.js";
import type { RenderHistory } from "../history.js";
import { errorResult } from "./render.js";

const idSchema = z.string().regex(/^r?\d{1,6}$/, "render id like \"r3\"");

export function registerDiffTools(server: McpServer, history: RenderHistory): void {
  server.registerTool(
    "lvgl_diff",
    {
      title: "Compare two renders",
      description: [
        "Compare two earlier renders by render_id (printed by every render tool; the last 20 are kept): a pixel diff (changed pixel count and percentage, bounding box of the change, and a diff image - the newer render dimmed with changed pixels in magenta) plus an object-level diff of the final widget trees matched by name (else tree path): added, removed, moved (old -> new rectangle), resized, text changed, style keys changed, and other property changes such as states (checked, pressed).",
        "Use it to verify that an edit changed only what you intended, to see what a click did (render with and without actions), or to catch layout regressions. Only the final captures are compared.",
      ].join("\n\n"),
      inputSchema: {
        a: idSchema.describe("The earlier/baseline render, e.g. \"r1\"."),
        b: idSchema.describe("The later render, e.g. \"r2\"."),
        threshold: z
          .number()
          .int()
          .min(0)
          .max(255)
          .default(0)
          .describe("Per-channel difference (0..255) a pixel may have and still count as unchanged. 0 = exact; ~8 ignores anti-aliasing noise."),
      },
      outputSchema: {
        a: z.string(),
        b: z.string(),
        pixel: z.object({
          width: z.number().int(),
          height: z.number().int(),
          changed: z.number().int(),
          total: z.number().int(),
          percent: z.number(),
          bbox: z.object({ x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number() }).nullable(),
          size_mismatch: z.record(z.unknown()).optional(),
        }),
        objects: z.object({
          added: z.array(z.record(z.unknown())),
          removed: z.array(z.record(z.unknown())),
          moved: z.array(z.record(z.unknown())),
          resized: z.array(z.record(z.unknown())),
          text: z.array(z.record(z.unknown())),
          styles: z.array(z.record(z.unknown())),
          other: z.array(z.record(z.unknown())),
          unchanged: z.number().int(),
        }),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ a, b, threshold }): Promise<CallToolResult> => {
      try {
        const ea = history.get(a);
        const eb = history.get(b);
        const missing = [!ea ? a : "", !eb ? b : ""].filter(Boolean);
        if (missing.length) {
          return {
            content: [{ type: "text", text: `Unknown render_id ${missing.join(", ")}. Available: ${history.describe()}.` }],
            isError: true,
          };
        }
        const px = pixelDiff(ea!.result.png, eb!.result.png, threshold);
        const od = objectDiff(ea!.result.output, eb!.result.output);
        const lines: string[] = [];
        const bbox = px.bbox
          ? `bounding box x ${px.bbox.x1}..${px.bbox.x2}, y ${px.bbox.y1}..${px.bbox.y2} (${px.bbox.x2 - px.bbox.x1 + 1}x${px.bbox.y2 - px.bbox.y1 + 1} px)`
          : "no changed pixels";
        lines.push(
          `Pixel diff ${ea!.id} -> ${eb!.id}: ${px.changed} of ${px.total} px changed (${px.percent}%), ${bbox}; threshold ${threshold}. The image shows ${eb!.id} dimmed with changed pixels in magenta.`
        );
        if (px.sizeMismatch) {
          lines.push(
            `Note: the images have different sizes (${px.sizeMismatch.a.width}x${px.sizeMismatch.a.height} vs ${px.sizeMismatch.b.width}x${px.sizeMismatch.b.height}); pixels outside one of them count as changed.`
          );
        }
        lines.push(formatObjectDiff(od));
        return {
          content: [
            { type: "image", data: px.png.toString("base64"), mimeType: "image/png" },
            { type: "text", text: lines.join("\n\n") },
          ],
          structuredContent: {
            a: ea!.id,
            b: eb!.id,
            pixel: {
              width: px.width,
              height: px.height,
              changed: px.changed,
              total: px.total,
              percent: px.percent,
              bbox: px.bbox,
              ...(px.sizeMismatch ? { size_mismatch: px.sizeMismatch } : {}),
            },
            objects: od as unknown as Record<string, unknown>,
          },
        };
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}
