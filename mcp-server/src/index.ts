import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SimulatorManager } from "./simulator/manager.js";
import { registerRenderTools } from "./tools/render.js";
import { registerInspectTools } from "./tools/inspect.js";
import { registerConfigTools } from "./tools/config.js";
import { registerResources } from "./resources/api-reference.js";
import * as path from "node:path";
import { existsSync } from "node:fs";

// Determine project root — supports two modes:
//
// 1. Dev mode (git clone): LVGL_PROJECT_ROOT env var, or auto-detect as grandparent
//    of dist/index.js → mcp-server/ → Lvgl-mcp-esp32/
//
// 2. npm mode (npx lvgl-mcp-server): simulator/ is downloaded by postinstall
//    next to dist/ inside the npm package directory.
const dirname =
  import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);
const packageDir = path.resolve(dirname, "..");

let projectRoot: string;
if (process.env["LVGL_PROJECT_ROOT"]) {
  // Explicit override — always wins
  projectRoot = process.env["LVGL_PROJECT_ROOT"];
} else if (existsSync(path.join(packageDir, "simulator"))) {
  // npm mode: simulator/ was downloaded by postinstall into the package dir
  projectRoot = packageDir;
} else {
  // Dev mode: dist/ is inside mcp-server/ which is inside the project root
  projectRoot = path.resolve(dirname, "..", "..");
}

// CRITICAL: Never use console.log in stdio MCP servers — it corrupts JSON-RPC.
// Use console.error for all debug/diagnostic output.
console.error(`[lvgl-mcp] Starting LVGL MCP server...`);
console.error(`[lvgl-mcp] Project root: ${projectRoot}`);

// Create simulator manager
const manager = new SimulatorManager(projectRoot);

// Create MCP server
const server = new McpServer({
  name: "lvgl-simulator",
  version: "1.0.0",
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
