import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  SimulatorCompiler,
  CompilerConfig,
  detectCompilerConfig,
} from "./compiler.js";

const execFileAsync = promisify(execFile);

export interface RenderResult {
  pngBase64: string;
  widgetTree?: unknown;
  compilationWarnings?: string;
  executionTime: number;
}

export interface SimulatorConfig {
  width: number;
  height: number;
  colorDepth: number;
  lvglVersion: string;
}

export class SimulatorManager {
  private compiler: SimulatorCompiler;
  private compilerConfig: CompilerConfig;
  private width = 800;
  private height = 480;
  private lastResult: RenderResult | null = null;

  constructor(projectRoot: string) {
    this.compilerConfig = detectCompilerConfig(projectRoot);
    this.compiler = new SimulatorCompiler(this.compilerConfig);
  }

  /**
   * Compile and render LVGL code, returning PNG + widget tree.
   */
  async render(code: string, isFullFile: boolean): Promise<RenderResult> {
    const startTime = Date.now();

    // Compile
    const compileResult = await this.compiler.compile(code, isFullFile);
    if (!compileResult.success) {
      throw new Error(`Compilation failed:\n${compileResult.errors}`);
    }

    // Prepare output paths
    const outputDir = path.join(this.compilerConfig.buildDir, "output");
    await fs.mkdir(outputDir, { recursive: true });

    const pngPath = path.join(outputDir, "screenshot.png");
    const jsonPath = path.join(outputDir, "tree.json");

    // Run simulator
    const exePath = compileResult.executablePath!;
    const args = [
      "--width",
      String(this.width),
      "--height",
      String(this.height),
      "--output-png",
      pngPath,
      "--output-json",
      jsonPath,
    ];

    try {
      // For MSVC builds the exe needs MSVC runtime DLLs which should be in PATH
      // after vcvarsall, but the exe itself runs standalone
      await execFileAsync(exePath, args, {
        timeout: 15000,
        windowsHide: true,
      });
    } catch (err: unknown) {
      const error = err as { stderr?: string; message?: string };
      throw new Error(
        `Simulator runtime error:\n${error.stderr || error.message}`
      );
    }

    // Read outputs
    const pngBuffer = await fs.readFile(pngPath);
    const pngBase64 = pngBuffer.toString("base64");

    let widgetTree: unknown = undefined;
    try {
      const jsonStr = await fs.readFile(jsonPath, "utf-8");
      widgetTree = JSON.parse(jsonStr);
    } catch {
      /* no tree output or parse failure */
    }

    const result: RenderResult = {
      pngBase64,
      widgetTree,
      compilationWarnings: compileResult.warnings,
      executionTime: Date.now() - startTime,
    };

    this.lastResult = result;
    return result;
  }

  /**
   * Get the last render result (for re-inspection without recompiling).
   */
  getLastResult(): RenderResult | null {
    return this.lastResult;
  }

  /**
   * Set display resolution for rendering.
   */
  setResolution(width: number, height: number): void {
    this.width = width;
    this.height = height;
    // No need to reconfigure cmake — resolution is passed as CLI args to the exe
  }

  /**
   * Get the current simulator configuration.
   */
  getConfig(): SimulatorConfig {
    return {
      width: this.width,
      height: this.height,
      colorDepth: 32,
      lvglVersion: "9.2.x",
    };
  }
}
