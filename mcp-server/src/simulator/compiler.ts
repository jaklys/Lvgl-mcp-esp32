import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";
import {
  cleanBuildOutput,
  diagnosticHints,
  focusOnUserFiles,
  parseDiagnostics,
  type Diagnostic,
  type PathShortening,
} from "./diagnostics.js";
import { SimulatorError } from "./errors.js";
import { captureVcvarsEnv, findVcvarsall } from "./msvc.js";
import { isWindows, resolveExecutable, runProcess, type RunResult } from "./process.js";

/** `lvgl_sim.exe` on Windows, `lvgl_sim` on POSIX. */
export function simBinaryName(): string {
  return isWindows ? "lvgl_sim.exe" : "lvgl_sim";
}

/** Files that belong to the user (diagnostics in other files are LVGL noise). */
export const USER_FILES = ["snippet.c", "user_code.c"];

export interface CompilerConfig {
  cmakePath: string;
  /** Explicit ninja binary (absolute) or bare name resolved via PATH. */
  ninjaPath: string;
  /** Explicit C compiler (from CC, or "cl" on Windows); undefined = CMake default. */
  compilerPath?: string;
  /** Explicit C++ compiler (from CXX); undefined = CMake default. */
  cxxCompilerPath?: string;
  simulatorDir: string;
  buildDir: string;
  /** CMake generator: "Ninja" or "Unix Makefiles". */
  generator: string;
  /** vcvarsall.bat used to set up the MSVC environment (Windows only). */
  vcvarsallPath?: string;
}

export interface CompileResult {
  success: boolean;
  executablePath?: string;
  /** Structured diagnostics (errors from anywhere, warnings/notes from user files only). */
  diagnostics: Diagnostic[];
  /** Cleaned compiler output (no command lines / progress, short paths). */
  output: string;
  /** Hints for common mistakes derived from the diagnostics. */
  hints: string[];
  /** True when the code was unchanged and the previous build was reused. */
  cached: boolean;
}

/**
 * Detect build tools for a simulator directory.
 * Windows: MSVC via vcvarsall (VCVARSALL_PATH > vswhere > known paths), Ninja.
 * POSIX: cmake/ninja from CMAKE_PATH/NINJA_PATH or PATH; Ninja when available,
 * otherwise Unix Makefiles.
 */
export function detectCompilerConfig(
  simulatorDir: string,
  env: NodeJS.ProcessEnv = process.env
): CompilerConfig {
  const buildDir = env["LVGL_BUILD_DIR"]
    ? path.resolve(env["LVGL_BUILD_DIR"])
    : path.join(simulatorDir, "build");

  if (isWindows) {
    const pick = (envVar: string, espIdf: string, name: string): string => {
      if (env[envVar]) return env[envVar]!;
      if (existsSync(espIdf)) return espIdf;
      return name;
    };
    return {
      cmakePath: pick("CMAKE_PATH", "C:\\Espressif\\tools\\cmake\\3.30.2\\bin\\cmake.exe", "cmake"),
      ninjaPath: pick("NINJA_PATH", "C:\\Espressif\\tools\\ninja\\1.12.1\\ninja.exe", "ninja"),
      compilerPath: env["CC"] || "cl",
      cxxCompilerPath: env["CXX"] || (env["CC"] ? undefined : "cl"),
      simulatorDir,
      buildDir,
      generator: "Ninja",
      vcvarsallPath: env["CC"] ? env["VCVARSALL_PATH"] : findVcvarsall(env),
    };
  }

  const ninjaPath = env["NINJA_PATH"] || "ninja";
  const generator = env["LVGL_CMAKE_GENERATOR"] || (resolveExecutable(ninjaPath, env) ? "Ninja" : "Unix Makefiles");
  return {
    cmakePath: env["CMAKE_PATH"] || "cmake",
    ninjaPath,
    compilerPath: env["CC"] || undefined,
    cxxCompilerPath: env["CXX"] || undefined,
    simulatorDir,
    buildDir,
    generator,
    vcvarsallPath: undefined,
  };
}

/** Arguments for the one-time `cmake` configure step. */
export function buildConfigureArgs(cfg: CompilerConfig): string[] {
  const args = [
    "-S",
    cfg.simulatorDir,
    "-B",
    cfg.buildDir,
    "-G",
    cfg.generator,
    "-DCMAKE_BUILD_TYPE=Release",
  ];
  if (cfg.generator === "Ninja" && path.isAbsolute(cfg.ninjaPath)) {
    args.push(`-DCMAKE_MAKE_PROGRAM=${cfg.ninjaPath}`);
  }
  if (cfg.compilerPath) args.push(`-DCMAKE_C_COMPILER=${cfg.compilerPath}`);
  if (cfg.cxxCompilerPath) args.push(`-DCMAKE_CXX_COMPILER=${cfg.cxxCompilerPath}`);
  return args;
}

export const SNIPPET_LINE_DIRECTIVE = '#line 1 "snippet.c"';

/**
 * Insert a snippet into the wrapper template.
 * - Inserts the code verbatim (`$&`, `$1`, `$$` in user code are not expanded).
 * - Guarantees `#line 1 "snippet.c"` right before the snippet so compiler
 *   diagnostics reference snippet line numbers (older templates lack it).
 */
export function wrapSnippet(template: string, snippet: string): string {
  const marker = "%USER_CODE%";
  const idx = template.indexOf(marker);
  if (idx < 0) throw new Error("user_code_wrapper.c template has no %USER_CODE% placeholder");
  let before = template.slice(0, idx);
  const after = template.slice(idx + marker.length);
  // Is the placeholder already directly preceded by the #line directive?
  const hasLine = /#line\s+1\s+"snippet\.c"[ \t]*\r?\n[ \t]*$/.test(before);
  if (!hasLine) {
    // Drop indentation before the placeholder, then add the directive on its own line.
    before = before.replace(/[ \t]*$/, "");
    if (before.length > 0 && !before.endsWith("\n")) before += "\n";
    before += SNIPPET_LINE_DIRECTIVE + "\n";
  }
  const body = snippet.endsWith("\n") ? snippet : snippet + "\n";
  // Plain concatenation: String.replace with a string replacement would
  // expand `$&`, `$'`, `$$` ... inside the user's code.
  return before + body + after;
}

const CACHE_MISSING_RE =
  /not a CMake build directory|CMakeCache\.txt.*(missing|not found|does not exist)|could not load cache|Error: could not find CMAKE_PROJECT_NAME/i;
const GENERATOR_MISMATCH_RE = /Does not match the generator used previously|CMAKE_C_COMPILER.*has changed|is different than the directory .* where CMakeCache\.txt was created/i;

export interface CompilerOptions {
  /** Budget for configure + build, in ms. */
  timeoutMs: number;
}

export class SimulatorCompiler {
  readonly config: CompilerConfig;
  private readonly opts: CompilerOptions;
  private configured = false;
  private templateContent: string | null = null;
  private lastSource: string | null = null;
  private lastResult: CompileResult | null = null;

  constructor(config: CompilerConfig, opts: CompilerOptions) {
    this.config = config;
    this.opts = opts;
  }

  get pathShortening(): PathShortening {
    return { buildDir: this.config.buildDir, simulatorDir: this.config.simulatorDir };
  }

  /** Full environment for build tools (MSVC needs the vcvarsall environment). */
  async buildEnv(): Promise<NodeJS.ProcessEnv> {
    if (isWindows && this.config.vcvarsallPath) {
      const vc = await captureVcvarsEnv(this.config.vcvarsallPath);
      return { ...process.env, ...vc };
    }
    return { ...process.env };
  }

  private async run(
    args: string[],
    deadline: number,
    signal: AbortSignal | undefined,
    what: string
  ): Promise<RunResult> {
    const env = await this.buildEnv();
    const cmake = resolveExecutable(this.config.cmakePath, env) ?? this.config.cmakePath;
    const remaining = Math.max(1000, deadline - Date.now());
    const res = await runProcess(cmake, args, { env, timeoutMs: remaining, signal });
    if (res.spawnError) {
      throw new SimulatorError(
        "setup",
        `Could not start cmake (${this.config.cmakePath}): ${res.spawnError.message}. Install CMake >= 3.16 and make sure it is on PATH, or set CMAKE_PATH.`
      );
    }
    if (res.aborted) throw new SimulatorError("cancelled", `${what} cancelled by the client.`);
    if (res.timedOut) {
      throw new SimulatorError(
        "timeout",
        `${what} timed out after ${Math.round(this.opts.timeoutMs / 1000)} s. The first build compiles all of LVGL and can take several minutes on slow machines; raise LVGL_COMPILE_TIMEOUT_MS if needed.`
      );
    }
    return res;
  }

  private async wipeCache(): Promise<void> {
    await fs.rm(path.join(this.config.buildDir, "CMakeCache.txt"), { force: true });
    await fs.rm(path.join(this.config.buildDir, "CMakeFiles"), { recursive: true, force: true });
  }

  /**
   * Delete a CMakeCache.txt that belongs to a different source tree (e.g. a
   * build/ copied from another machine) so configure can regenerate cleanly.
   */
  private async clearStaleCache(): Promise<void> {
    const cachePath = path.join(this.config.buildDir, "CMakeCache.txt");
    let cache: string;
    try {
      cache = await fs.readFile(cachePath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      await this.wipeCache().catch(() => undefined);
      return;
    }
    const normalize = (p: string): string =>
      path.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const home = /^CMAKE_HOME_DIRECTORY:INTERNAL=(.*)$/m.exec(cache);
    if (!home || normalize(home[1].trim()) !== normalize(this.config.simulatorDir)) {
      await this.wipeCache().catch(() => undefined);
    }
  }

  /** Run the CMake configure step once per process (or after the build dir vanished). */
  async ensureConfigured(deadline: number, signal?: AbortSignal): Promise<void> {
    if (this.configured) return;
    await fs.mkdir(this.config.buildDir, { recursive: true });
    await this.clearStaleCache();

    const args = buildConfigureArgs(this.config);
    let res = await this.run(args, deadline, signal, "CMake configure");
    if (res.code !== 0 && GENERATOR_MISMATCH_RE.test(res.stdout + res.stderr)) {
      await this.wipeCache();
      res = await this.run(args, deadline, signal, "CMake configure");
    }
    if (res.code !== 0) {
      const text = cleanBuildOutput(`${res.stdout}\n${res.stderr}`, this.pathShortening);
      throw new SimulatorError(
        "configure",
        `CMake configure failed (exit ${res.code ?? res.signal}):\n${text.length > 6000 ? "...\n" + text.slice(-6000) : text}`
      );
    }
    this.configured = true;
  }

  private async template(): Promise<string> {
    if (this.templateContent === null) {
      const templatePath = path.join(this.config.simulatorDir, "templates", "user_code_wrapper.c");
      this.templateContent = await fs.readFile(templatePath, "utf-8");
    }
    return this.templateContent;
  }

  /** Produce the exact contents of user_code.c for a request. */
  async sourceFor(code: string, isFullFile: boolean): Promise<string> {
    return isFullFile ? code : wrapSnippet(await this.template(), code);
  }

  private async writeSource(source: string, snippet: string | null): Promise<void> {
    await fs.mkdir(this.config.buildDir, { recursive: true });
    await fs.writeFile(path.join(this.config.buildDir, "user_code.c"), source, "utf-8");
    // The compiler runs in the build dir; with `#line 1 "snippet.c"` gcc/clang
    // look for snippet.c there to print the offending source line + caret.
    if (snippet !== null) {
      await fs.writeFile(path.join(this.config.buildDir, "snippet.c"), snippet, "utf-8");
    }
  }

  executablePath(): string {
    const direct = path.join(this.config.buildDir, simBinaryName());
    if (existsSync(direct)) return direct;
    const multi = path.join(this.config.buildDir, "Release", simBinaryName());
    return existsSync(multi) ? multi : direct;
  }

  /**
   * True when user_code.c on disk still holds `source` and the binary is newer
   * (another server process sharing the build dir may have rebuilt it).
   */
  private async upToDate(source: string): Promise<boolean> {
    try {
      const file = path.join(this.config.buildDir, "user_code.c");
      const [onDisk, srcStat, exeStat] = await Promise.all([
        fs.readFile(file, "utf-8"),
        fs.stat(file),
        fs.stat(this.executablePath()),
      ]);
      return onDisk === source && exeStat.mtimeMs >= srcStat.mtimeMs;
    } catch {
      return false;
    }
  }

  /**
   * Write user code into the build dir and build the simulator.
   * Resolves with success=false for compile/link errors; throws
   * SimulatorError for configure failures, timeouts and cancellation.
   */
  async compile(code: string, isFullFile: boolean, signal?: AbortSignal): Promise<CompileResult> {
    const deadline = Date.now() + this.opts.timeoutMs;
    const source = await this.sourceFor(code, isFullFile);

    // Identical source + successful previous build: nothing to do, but keep
    // the warnings of that build (ninja would print nothing this time).
    if (this.configured && this.lastSource === source && this.lastResult?.success && (await this.upToDate(source))) {
      return { ...this.lastResult, cached: true };
    }

    await this.writeSource(source, isFullFile ? null : code);
    await this.ensureConfigured(deadline, signal);

    let res = await this.run(["--build", this.config.buildDir], deadline, signal, "Build");
    if (res.code !== 0 && CACHE_MISSING_RE.test(res.stdout + res.stderr)) {
      // Build dir was deleted/corrupted while we were running: reconfigure once.
      this.configured = false;
      await this.writeSource(source, isFullFile ? null : code);
      await this.ensureConfigured(deadline, signal);
      res = await this.run(["--build", this.config.buildDir], deadline, signal, "Build");
    }

    const output = focusOnUserFiles(cleanBuildOutput(`${res.stdout}\n${res.stderr}`, this.pathShortening), USER_FILES);
    const all = parseDiagnostics(output);
    const diagnostics = all.filter(
      (d) => d.severity === "error" || USER_FILES.includes(d.file) || d.file === ""
    );
    const success = res.code === 0;
    const result: CompileResult = {
      success,
      executablePath: success ? this.executablePath() : undefined,
      diagnostics,
      output: truncate(output, 8000),
      hints: diagnosticHints(diagnostics, isFullFile),
      cached: false,
    };
    this.lastSource = success ? source : null;
    this.lastResult = success ? result : null;
    return result;
  }
}

/** Keep at most `max` characters, preferring the start (first errors matter most). */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n... (${text.length - max} more characters truncated)`;
}
