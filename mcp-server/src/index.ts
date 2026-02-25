import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SimulatorManager } from "./simulator/manager.js";
import { registerRenderTools } from "./tools/render.js";
import { registerInspectTools } from "./tools/inspect.js";
import { registerConfigTools } from "./tools/config.js";
import { registerResources } from "./resources/api-reference.js";
import * as path from "node:path";

// Determine project root (grandparent of dist/ or src/)
// When running from dist/index.js, dirname is mcp-server/dist/, go up twice.
// When running from src/index.ts via tsx, dirname is mcp-server/src/, go up twice.
// Allow override via environment variable.
const projectRoot =
  process.env["LVGL_PROJECT_ROOT"] ??
  path.resolve(
    import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
    "..",
    ".."
  );

// CRITICAL: Never use console.log in stdio MCP servers — it corrupts JSON-RPC.
// Use console.error for all debug/diagnostic output.
console.error(`[lvgl-mcp] Starting LVGL MCP server...`);
console.error(`[lvgl-mcp] Project root: ${projectRoot}`);

// Create simulator manager
const manager = new SimulatorManager(projectRoot);

// Create MCP server
const server = new McpServer({
  name: "lvgl-simulator",
  version: "0.1.0",
});

// Register tools
registerRenderTools(server, manager);
registerInspectTools(server, manager);
registerConfigTools(server, manager);

// Register resources
registerResources(server, manager);

// Connect via stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);

console.error("[lvgl-mcp] Server connected and ready.");
