import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const execFileAsync = promisify(execFile);

export interface CompileResult {
  success: boolean;
  executablePath?: string;
  errors?: string;
  warnings?: string;
}

export interface CompilerConfig {
  cmakePath: string;
  ninjaPath: string;
  compilerPath: string;
  simulatorDir: string;
  buildDir: string;
  vcvarsallPath?: string; // For MSVC environment setup
}

import { existsSync } from "node:fs";

/**
 * Find vcvarsall.bat by scanning common Visual Studio install paths.
 */
function findVcvarsall(): string | undefined {
  if (process.env["VCVARSALL_PATH"]) {
    return process.env["VCVARSALL_PATH"];
  }

  const programFiles = "C:\\Program Files";
  const programFilesX86 = "C:\\Program Files (x86)";
  const editions = ["BuildTools", "Community", "Professional", "Enterprise"];
  const years = ["2022", "2019"];

  for (const year of years) {
    for (const edition of editions) {
      for (const root of [programFilesX86, programFiles]) {
        const candidate = path.join(
          root,
          "Microsoft Visual Studio",
          year,
          edition,
          "VC",
          "Auxiliary",
          "Build",
          "vcvarsall.bat"
        );
        if (existsSync(candidate)) {
          return candidate;
        }
      }
    }
  }
  return undefined;
}

/**
 * Find a tool on common paths or PATH.
 */
function findTool(envVar: string, espIdfPath: string, name: string): string {
  if (process.env[envVar]) return process.env[envVar]!;
  if (existsSync(espIdfPath)) return espIdfPath;
  // Fall back to bare name — will be resolved via PATH
  return name;
}

/**
 * Detects available build tools and returns a CompilerConfig.
 * Prefers MSVC if vcvarsall.bat is found, otherwise falls back to GCC.
 */
export function detectCompilerConfig(projectRoot: string): CompilerConfig {
  const simulatorDir = path.join(projectRoot, "simulator");
  const buildDir = path.join(simulatorDir, "build");

  const cmakePath = findTool(
    "CMAKE_PATH",
    "C:\\Espressif\\tools\\cmake\\3.30.2\\bin\\cmake.exe",
    "cmake"
  );
  const ninjaPath = findTool(
    "NINJA_PATH",
    "C:\\Espressif\\tools\\ninja\\1.12.1\\ninja.exe",
    "ninja"
  );

  const vcvarsallPath = findVcvarsall();

  return {
    cmakePath,
    ninjaPath,
    compilerPath: process.env["CC"] || "cl",
    simulatorDir,
    buildDir,
    vcvarsallPath,
  };
}

export class SimulatorCompiler {
  private config: CompilerConfig;
  private configured = false;
  private templateContent: string | null = null;

  constructor(config: CompilerConfig) {
    this.config = config;
  }

  /**
   * Run a command through MSVC vcvarsall environment if needed.
   * Uses a temporary batch file to avoid cmd.exe quoting issues.
   */
  private async runCommand(
    command: string,
    args: string[],
    timeout: number
  ): Promise<{ stdout: string; stderr: string }> {
    if (this.config.vcvarsallPath) {
      // Write a temporary batch file to avoid cmd.exe quoting nightmares
      const batchPath = path.join(this.config.buildDir, "_run.bat");
      const argStr = args.join(" ");
      const batchContent = [
        "@echo off",
        `call "${this.config.vcvarsallPath}" x64 >nul 2>&1`,
        `"${command}" ${argStr}`,
      ].join("\r\n");
      await fs.mkdir(this.config.buildDir, { recursive: true });
      await fs.writeFile(batchPath, batchContent, "utf-8");

      return execFileAsync("cmd.exe", ["/c", batchPath], {
        timeout,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
      });
    }
    return execFileAsync(command, args, {
      timeout,
      maxBuffer: 10 * 1024 * 1024,
    });
  }

  /**
   * Ensure CMake is configured (first run or after config change).
   */
  async ensureConfigured(): Promise<void> {
    if (this.configured) return;

    await fs.mkdir(this.config.buildDir, { recursive: true });

    const args = [
      "-S",
      this.config.simulatorDir,
      "-B",
      this.config.buildDir,
      "-G",
      "Ninja",
      `-DCMAKE_MAKE_PROGRAM=${this.config.ninjaPath}`,
      `-DCMAKE_C_COMPILER=${this.config.compilerPath}`,
    ];

    try {
      await this.runCommand(this.config.cmakePath, args, 60000);
      this.configured = true;
    } catch (err: unknown) {
      const error = err as { stderr?: string; message?: string };
      throw new Error(
        `CMake configure failed:\n${error.stderr || error.message}`
      );
    }
  }

  /**
   * Write user code to build dir and compile.
   */
  async compile(userCode: string, isFullFile: boolean): Promise<CompileResult> {
    // Write user code
    const codePath = path.join(this.config.buildDir, "user_code.c");

    if (isFullFile) {
      await fs.writeFile(codePath, userCode, "utf-8");
    } else {
      const wrapped = await this.wrapSnippet(userCode);
      await fs.writeFile(codePath, wrapped, "utf-8");
    }

    // Ensure configured
    await this.ensureConfigured();

    // Build
    try {
      const { stdout, stderr } = await this.runCommand(
        this.config.cmakePath,
        ["--build", this.config.buildDir],
        60000
      );
      return {
        success: true,
        executablePath: path.join(this.config.buildDir, "lvgl_sim.exe"),
        warnings: stderr || undefined,
      };
    } catch (err: unknown) {
      const error = err as { stderr?: string; stdout?: string; message?: string };
      return {
        success: false,
        errors: error.stderr || error.stdout || error.message,
      };
    }
  }

  /**
   * Wrap a code snippet in the user_code_wrapper.c template.
   */
  private async wrapSnippet(snippet: string): Promise<string> {
    if (!this.templateContent) {
      const templatePath = path.join(
        this.config.simulatorDir,
        "templates",
        "user_code_wrapper.c"
      );
      this.templateContent = await fs.readFile(templatePath, "utf-8");
    }
    return this.templateContent.replace("%USER_CODE%", snippet);
  }

  /**
   * Mark as needing reconfiguration (e.g., after resolution change).
   */
  markDirty(): void {
    this.configured = false;
  }
}
