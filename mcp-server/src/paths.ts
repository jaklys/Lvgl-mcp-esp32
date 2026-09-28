import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

export interface SimulatorLocation {
  simulatorDir: string;
  /** How the directory was chosen (for the startup log). */
  source: "LVGL_SIM_PATH" | "LVGL_PROJECT_ROOT" | "npm package" | "git checkout";
}

/**
 * Locate the simulator directory. Precedence:
 *   1. LVGL_SIM_PATH      - a simulator directory (contains CMakeLists.txt)
 *   2. LVGL_PROJECT_ROOT  - repository root containing simulator/
 *   3. <package>/simulator (npm install; downloaded by postinstall)
 *   4. <package>/../simulator (git checkout: mcp-server/ next to simulator/)
 *
 * @param packageDir the mcp-server package directory (parent of dist/)
 */
export function resolveSimulatorDir(
  packageDir: string,
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = existsSync
): SimulatorLocation {
  if (env["LVGL_SIM_PATH"]) {
    return { simulatorDir: path.resolve(env["LVGL_SIM_PATH"]), source: "LVGL_SIM_PATH" };
  }
  if (env["LVGL_PROJECT_ROOT"]) {
    return {
      simulatorDir: path.resolve(env["LVGL_PROJECT_ROOT"], "simulator"),
      source: "LVGL_PROJECT_ROOT",
    };
  }
  const npmDir = path.join(packageDir, "simulator");
  if (exists(path.join(npmDir, "CMakeLists.txt"))) return { simulatorDir: npmDir, source: "npm package" };
  return { simulatorDir: path.resolve(packageDir, "..", "simulator"), source: "git checkout" };
}

/** Read the version from the package.json in `packageDir`. */
export function readPackageVersion(packageDir: string): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf-8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
