import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const execFileAsync = promisify(execFile);

const isWindows = process.platform === "win32";

/**
 * Platform-aware simulator binary name.
 * `lvgl_sim.exe` on Windows, `lvgl_sim` on POSIX.
 */
export function simBinaryName(): string {
  return isWindows ? "lvgl_sim.exe" : "lvgl_sim";
}

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
  generator: string; // CMake generator: "Ninja" or "Unix Makefiles"
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
 * Check whether a working ninja binary is available (POSIX detection).
 * Returns true if `ninjaPath --version` succeeds.
 */
function isNinjaAvailable(ninjaPath: string): boolean {
  try {
    execFileSync(ninjaPath, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Detects available build tools and returns a CompilerConfig.
 *
 * On Windows: prefers MSVC (vcvarsall.bat) with C:\Espressif tool fallbacks
 * and the Ninja generator.
 * On POSIX: uses cc/CC, cmake/ninja from env override or PATH, and picks the
 * Ninja generator when ninja is available, otherwise Unix Makefiles.
 */
export function detectCompilerConfig(projectRoot: string): CompilerConfig {
  const simulatorDir = path.join(projectRoot, "simulator");
  const buildDir = path.join(simulatorDir, "build");

  if (isWindows) {
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

    return {
      cmakePath,
      ninjaPath,
      compilerPath: process.env["CC"] || "cl",
      simulatorDir,
      buildDir,
      generator: "Ninja",
      vcvarsallPath: findVcvarsall(),
    };
  }

  // POSIX (Linux/macOS)
  const cmakePath = process.env["CMAKE_PATH"] || "cmake";
  const ninjaPath = process.env["NINJA_PATH"] || "ninja";
  const generator = isNinjaAvailable(ninjaPath) ? "Ninja" : "Unix Makefiles";

  return {
    cmakePath,
    ninjaPath,
    compilerPath: process.env["CC"] || "cc",
    simulatorDir,
    buildDir,
    generator,
    vcvarsallPath: undefined,
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
   * If a CMakeCache.txt exists in the build dir but points at a different
   * source tree than the current simulatorDir, delete it (and CMakeFiles/)
   * so cmake configure can regenerate cleanly. Robust: on any parse error
   * the cache is discarded to be safe.
   */
  private async clearStaleCache(): Promise<void> {
    const cachePath = path.join(this.config.buildDir, "CMakeCache.txt");
    try {
      const cache = await fs.readFile(cachePath, "utf-8");

      const normalize = (p: string): string =>
        path.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

      const expected = normalize(this.config.simulatorDir);

      // CMake writes CMAKE_HOME_DIRECTORY with forward slashes.
      const homeMatch = cache.match(/^CMAKE_HOME_DIRECTORY:INTERNAL=(.*)$/m);
      const headerMatch = cache.match(/^# For build in directory:\s*(.*)$/m);

      let matches = false;
      if (homeMatch) {
        matches = normalize(homeMatch[1].trim()) === expected;
      } else if (headerMatch) {
        // header points at the build dir; derive nothing useful — treat as stale
        matches = false;
      } else {
        // Cannot determine source — treat as stale.
        matches = false;
      }

      if (!matches) {
        await fs.rm(cachePath, { force: true });
        await fs.rm(path.join(this.config.buildDir, "CMakeFiles"), {
          recursive: true,
          force: true,
        });
      }
    } catch (err: unknown) {
      // No cache file (ENOENT) → nothing to do. Any other/parse error → wipe.
      const code = (err as { code?: string }).code;
      if (code === "ENOENT") return;
      try {
        await fs.rm(cachePath, { force: true });
        await fs.rm(path.join(this.config.buildDir, "CMakeFiles"), {
          recursive: true,
          force: true,
        });
      } catch {
        /* best effort */
      }
    }
  }

  /**
   * Ensure CMake is configured (first run or after config change).
   */
  async ensureConfigured(): Promise<void> {
    if (this.configured) return;

    await fs.mkdir(this.config.buildDir, { recursive: true });

    // Discard a foreign/stale CMake cache (e.g. a prebuilt build/ from a
    // different machine or a hand-extracted archive) before configuring.
    await this.clearStaleCache();

    const args = [
      "-S",
      this.config.simulatorDir,
      "-B",
      this.config.buildDir,
      "-G",
      this.config.generator,
    ];

    // CMAKE_MAKE_PROGRAM is only meaningful for the Ninja generator here;
    // the Makefiles generator locates `make` on its own.
    if (this.config.generator === "Ninja") {
      args.push(`-DCMAKE_MAKE_PROGRAM=${this.config.ninjaPath}`);
    }

    args.push(`-DCMAKE_C_COMPILER=${this.config.compilerPath}`);

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
        executablePath: path.join(this.config.buildDir, simBinaryName()),
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
