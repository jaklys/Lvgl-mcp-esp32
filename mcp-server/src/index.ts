import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { formatDoctorReport } from "./doctor.js";
import { readPackageVersion, resolveSimulatorDir } from "./paths.js";
import { createServer } from "./server.js";
import { SimulatorManager } from "./simulator/manager.js";
import { killAllChildren } from "./simulator/process.js";

// CRITICAL: never write to stdout in a stdio MCP server - it carries JSON-RPC.
// All diagnostics go to stderr via console.error.
const log = (msg: string) => console.error(`[lvgl-mcp] ${msg}`);

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = readPackageVersion(packageDir);
const location = resolveSimulatorDir(packageDir);

log(`lvgl-mcp-server ${version} starting (node ${process.version}, ${process.platform}-${process.arch})`);
log(`Simulator directory: ${location.simulatorDir} (from ${location.source})`);

const manager = new SimulatorManager({ simulatorDir: location.simulatorDir, serverVersion: version });
log(`Build directory: ${manager.compilerConfig.buildDir} (generator ${manager.compilerConfig.generator})`);

const server = createServer({ backend: manager, version });

let shuttingDown = false;
async function shutdown(reason: string, code = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`Shutting down (${reason}).`);
  killAllChildren();
  try {
    await server.close();
  } catch {
    /* ignore */
  }
  process.exit(code);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGHUP", () => void shutdown("SIGHUP"));
process.stdin.on("end", () => void shutdown("stdin closed"));
process.stdin.on("close", () => void shutdown("stdin closed"));
process.on("exit", () => killAllChildren());

const transport = new StdioServerTransport();
await server.connect(transport);
log("Server connected and ready.");

// Toolchain check in the background: tools wait for it and report the
// diagnosis as an actionable error when it fails.
manager
  .doctor()
  .then((report) => {
    for (const line of formatDoctorReport(report).split("\n")) log(line);
  })
  .catch((err: unknown) => log(`Toolchain check crashed: ${(err as Error).message}`));
