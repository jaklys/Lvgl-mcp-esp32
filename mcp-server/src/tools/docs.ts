import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DOC_TOPIC_IDS, getDocTopic, topicList } from "../resources/docs/index.js";

export function registerDocsTools(server: McpServer): void {
  server.registerTool(
    "lvgl_docs",
    {
      title: "LVGL 9.6 docs by topic",
      description: [
        "Return LVGL 9.6 reference text for one topic - accurate 9.6 names and signatures instead of guessing (v8 names and signatures differ). Per-widget pages \"widgets/<name>\" list every public function of that widget (generated from the LVGL headers) with parts, events and an example.",
        "Topics:\n" + topicList(),
        "The resource lvgl://api-reference is the concatenation of the top-level topics.",
      ].join("\n\n"),
      inputSchema: {
        topic: z.enum(DOC_TOPIC_IDS).describe("Topic id, e.g. \"styles\", \"actions\", \"ui-json\", \"esp32\", \"boards\" or \"widgets/slider\"."),
      },
      outputSchema: {
        topic: z.string(),
        chars: z.number().int().describe("Length of the returned text (the text itself is the content)"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ topic }) => {
      const text = getDocTopic(topic);
      if (!text) {
        return { content: [{ type: "text", text: `Unknown topic "${topic}". Topics:\n${topicList()}` }], isError: true };
      }
      return { content: [{ type: "text", text }], structuredContent: { topic, chars: text.length } };
    }
  );
}
