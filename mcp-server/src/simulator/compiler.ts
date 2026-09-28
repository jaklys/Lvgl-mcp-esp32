import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import * as os from "node:os";
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
import { detectPrebuilt, isPrebuiltFailure, usePrebuiltLibrary, type PrebuiltInfo } from "./prebuilt.js";
import { isWindows, resolveExecutable, runProcess, type RunResult } from "./process.js";
import { ESP_SHIM_PRELUDE, withEspShims, writeEspShimStubs } from "./project.js";

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
  /** Non-fatal notes (e.g. the prebuilt library fallback). */
  notes?: string[];
}

/**
 * Where macOS package managers put cmake/ninja. MCP clients started from the
 * Dock or Finder (Claude Desktop, VS Code, Cursor) get launchd's minimal PATH
 * (/usr/bin:/bin:/usr/sbin:/sbin), which does not include Homebrew.
 */
export const DARWIN_TOOL_DIRS = [
  "/opt/homebrew/bin", // Homebrew, Apple Silicon
  "/usr/local/bin", // Homebrew, Intel
  "/opt/local/bin", // MacPorts
  "/Applications/CMake.app/Contents/bin", // cmake.org installer
];

/**
 * A build tool for the POSIX path: the bare name when it is on PATH (resolved
 * again at run time), else on macOS an absolute path from DARWIN_TOOL_DIRS,
 * else the bare name (the doctor then reports it as missing).
 */
export function findPosixTool(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  isFile: (p: string) => boolean = (p) => resolveExecutable(p, env) !== undefined
): string {
  if (resolveExecutable(name, env)) return name;
  if (platform === "darwin") {
    for (const dir of DARWIN_TOOL_DIRS) {
      const candidate = path.posix.join(dir, name);
      if (isFile(candidate)) return candidate;
    }
  }
  return name;
}

/**
 * Detect build tools for a simulator directory.
 * Windows: MSVC via vcvarsall (VCVARSALL_PATH > vswhere > known paths), Ninja.
 * POSIX (Linux, macOS): cmake/ninja from CMAKE_PATH/NINJA_PATH or PATH (on
 * macOS also the Homebrew/MacPorts/CMake.app locations); Ninja when
 * available, otherwise Unix Makefiles. The C compiler is CMake's default
 * (`cc`: gcc or clang on Linux, Apple clang on macOS) unless CC is set.
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

  const ninjaPath = env["NINJA_PATH"] || findPosixTool("ninja", env);
  const generator = env["LVGL_CMAKE_GENERATOR"] || (resolveExecutable(ninjaPath, env) ? "Ninja" : "Unix Makefiles");
  return {
    cmakePath: env["CMAKE_PATH"] || findPosixTool("cmake", env),
    ninjaPath,
    compilerPath: env["CC"] || undefined,
    cxxCompilerPath: env["CXX"] || undefined,
    simulatorDir,
    buildDir,
    generator,
    vcvarsallPath: undefined,
  };
}

/**
 * CMake cache variables that select what is built (see mcp-server/CMAKE-REQUIREMENTS.md):
 * the prebuilt LVGL library and the user sources/include dirs/defines of
 * project mode (and of the ESP-IDF shims).
 */
export interface ConfigureOptions {
  /** <simulator>/prebuilt/<platform> - link the prebuilt liblvgl instead of building LVGL. */
  prebuiltDir?: string | null;
  /** Extra user sources (absolute), compiled with the user warning flags next to user_code.c. */
  userSources?: string[];
  /** Include directories for the user sources (absolute). */
  includeDirs?: string[];
  /** Compile definitions for the user sources ("NAME" / "NAME=value"). */
  defines?: string[];
}

/** CMake list value: forward slashes, ';'-separated. */
function cmakeList(items: string[] | undefined): string {
  return (items ?? []).map((i) => i.replace(/\\/g, "/")).join(";");
}

/**
 * Arguments for the `cmake` configure step. With `opts`, the 2.2.0 cache
 * variables are always passed (empty lists clear an earlier project) and
 * LVGL_PREBUILT_DIR is set or removed (-U) so switching back and forth works
 * in one build directory.
 */
export function buildConfigureArgs(cfg: CompilerConfig, opts?: ConfigureOptions): string[] {
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
  if (opts) {
    if (opts.prebuiltDir) args.push(`-DLVGL_PREBUILT_DIR=${opts.prebuiltDir.replace(/\\/g, "/")}`);
    else args.push("-ULVGL_PREBUILT_DIR");
    args.push(`-DUSER_SOURCES=${cmakeList(opts.userSources)}`);
    args.push(`-DUSER_INCLUDE_DIRS=${cmakeList(opts.includeDirs)}`);
    args.push(`-DUSER_DEFINES=${(opts.defines ?? []).join(";")}`);
  }
  return args;
}

/**
 * Arguments for `cmake --build`. Ninja parallelizes on its own; Make builds
 * serially unless told otherwise, which would make the first full LVGL build
 * (hundreds of files) far slower than the compile timeout allows.
 */
export function buildBuildArgs(cfg: CompilerConfig, jobs: number = os.availableParallelism()): string[] {
  const args = ["--build", cfg.buildDir];
  if (cfg.generator !== "Ninja") args.push("--parallel", String(Math.max(1, jobs)));
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
  /** Prebuilt artifacts (default: detected in <simulatorDir>/prebuilt/<platform>). */
  prebuilt?: PrebuiltInfo;
  /** Environment for LVGL_NO_PREBUILT (default process.env). */
  env?: NodeJS.ProcessEnv;
  /** Warning sink (default: stderr). */
  log?: (msg: string) => void;
}

/** One compilation: user_code.c plus (project mode) extra sources and settings. */
export interface CompileUnit {
  /** Exact contents of user_code.c. */
  source: string;
  /** Snippet text (snippet mode) written as snippet.c so compilers can show the source line. */
  snippet: string | null;
  /** Complete-file mode (affects hints only). */
  fullFile: boolean;
  /** Extra absolute sources (project mode). */
  sources?: string[];
  includeDirs?: string[];
  defines?: string[];
  /** File names (relative paths and base names) whose warnings are kept. Default: snippet.c, user_code.c. */
  userFiles?: string[];
  /** Directories stripped from paths in diagnostics (project roots). */
  stripDirs?: string[];
  /** Reuse the previous build when nothing changed (default true; project mode relies on ninja instead). */
  cacheable?: boolean;
}

const PREBUILT_FALLBACK_NOTE =
  "The prebuilt LVGL library did not link with this toolchain; LVGL was rebuilt from source instead (automatic one-time fallback, remembered for this session).";

export class SimulatorCompiler {
  readonly config: CompilerConfig;
  private readonly opts: CompilerOptions;
  readonly prebuilt: PrebuiltInfo;
  private readonly env: NodeJS.ProcessEnv;
  private readonly log: (msg: string) => void;
  /** Set after a failed link with the prebuilt library: build LVGL from source from now on. */
  prebuiltDisabled = false;
  /** Configure options (serialised) the build dir was last configured with in this process. */
  private configuredKey: string | null = null;
  /** True once any build succeeded in this process (the binary in the build dir is current). */
  builtThisSession = false;
  private templateContent: string | null = null;
  private lastKey: string | null = null;
  private lastResult: CompileResult | null = null;

  constructor(config: CompilerConfig, opts: CompilerOptions) {
    this.config = config;
    this.opts = opts;
    this.env = opts.env ?? process.env;
    this.prebuilt = opts.prebuilt ?? detectPrebuilt(config.simulatorDir);
    this.log = opts.log ?? ((m) => console.error(`[lvgl-mcp] ${m}`));
  }

  /** True when the next configure links the prebuilt LVGL library. */
  get usingPrebuiltLibrary(): boolean {
    return usePrebuiltLibrary(this.prebuilt, this.prebuiltDisabled, this.env);
  }

  pathShortening(stripDirs: string[] = []): PathShortening {
    return { buildDir: this.config.buildDir, simulatorDir: this.config.simulatorDir, stripDirs };
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

  /**
   * Run the CMake configure step when the build dir has not been configured
   * by this process yet, or with different options (prebuilt library, user
   * sources, include dirs, defines).
   */
  async ensureConfigured(deadline: number, signal?: AbortSignal, opts: ConfigureOptions = this.configureOptions({})): Promise<void> {
    const key = JSON.stringify(opts);
    if (this.configuredKey === key) return;
    await fs.mkdir(this.config.buildDir, { recursive: true });
    await this.clearStaleCache();

    const args = buildConfigureArgs(this.config, opts);
    let res = await this.run(args, deadline, signal, "CMake configure");
    if (res.code !== 0 && GENERATOR_MISMATCH_RE.test(res.stdout + res.stderr)) {
      await this.wipeCache();
      res = await this.run(args, deadline, signal, "CMake configure");
    }
    if (res.code !== 0) {
      this.configuredKey = null;
      const text = cleanBuildOutput(`${res.stdout}\n${res.stderr}`, this.pathShortening());
      throw new SimulatorError(
        "configure",
        `CMake configure failed (exit ${res.code ?? res.signal}):\n${text.length > 6000 ? "...\n" + text.slice(-6000) : text}`
      );
    }
    this.configuredKey = key;
  }

  /** Configure options for a unit (prebuilt library when usable). */
  configureOptions(unit: Pick<CompileUnit, "sources" | "includeDirs" | "defines">): ConfigureOptions {
    return {
      prebuiltDir: this.usingPrebuiltLibrary ? this.prebuilt.dir : null,
      userSources: unit.sources ?? [],
      includeDirs: unit.includeDirs ?? [],
      defines: unit.defines ?? [],
    };
  }

  private async template(): Promise<string> {
    if (this.templateContent === null) {
      const templatePath = path.join(this.config.simulatorDir, "templates", "user_code_wrapper.c");
      this.templateContent = await fs.readFile(templatePath, "utf-8");
    }
    return this.templateContent;
  }

  /** Produce the exact contents of user_code.c for a request. */
  async sourceFor(code: string, isFullFile: boolean, espShims = false): Promise<string> {
    if (isFullFile) return espShims ? withEspShims(code, "user_code.c") : code;
    const wrapped = wrapSnippet(await this.template(), code);
    return espShims ? [...ESP_SHIM_PRELUDE, wrapped].join("\n") : wrapped;
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

  /** True when a simulator binary exists in the build directory. */
  hasBuiltBinary(): boolean {
    return existsSync(this.executablePath());
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
  async compile(code: string, isFullFile: boolean, signal?: AbortSignal, espShims = false): Promise<CompileResult> {
    const source = await this.sourceFor(code, isFullFile, espShims);
    const shim = espShims ? await this.espShimSettings() : { includeDirs: [], defines: [] };
    return this.compileUnit(
      { source, snippet: isFullFile ? null : code, fullFile: isFullFile, includeDirs: shim.includeDirs, defines: shim.defines },
      signal
    );
  }

  /** Include dirs/defines for the ESP-IDF shims (stub headers are generated in the build dir). */
  async espShimSettings(): Promise<{ includeDirs: string[]; defines: string[] }> {
    const stubDir = path.join(this.config.buildDir, "esp_idf_shims");
    await writeEspShimStubs(stubDir);
    return {
      includeDirs: [stubDir, path.join(this.config.simulatorDir, "templates")],
      defines: ["LVGL_SIM_ESP_SHIMS=1"],
    };
  }

  async compileUnit(unit: CompileUnit, signal?: AbortSignal): Promise<CompileResult> {
    let deadline = Date.now() + this.opts.timeoutMs;
    let confOpts = this.configureOptions(unit);
    const key = JSON.stringify(confOpts) + "\n" + unit.source;
    const cacheable = unit.cacheable !== false;

    // Identical source + successful previous build: nothing to do, but keep
    // the warnings of that build (ninja would print nothing this time).
    if (
      cacheable &&
      this.configuredKey === JSON.stringify(confOpts) &&
      this.lastKey === key &&
      this.lastResult?.success &&
      (await this.upToDate(unit.source))
    ) {
      return { ...this.lastResult, cached: true, notes: [] };
    }

    const notes: string[] = [];
    const fallback = async (why: string): Promise<void> => {
      this.prebuiltDisabled = true;
      this.log(`Warning: ${why} with the prebuilt LVGL library (${this.prebuilt.dir}); reconfiguring to build LVGL from source (once per session).`);
      notes.push(PREBUILT_FALLBACK_NOTE);
      confOpts = this.configureOptions(unit);
      this.configuredKey = null;
      deadline = Date.now() + this.opts.timeoutMs; // building LVGL from source takes a while
    };

    await this.writeSource(unit.source, unit.snippet);
    try {
      await this.ensureConfigured(deadline, signal, confOpts);
    } catch (err) {
      if (!(err instanceof SimulatorError) || err.kind !== "configure" || !confOpts.prebuiltDir) throw err;
      if (!isPrebuiltFailure(err.message, confOpts.prebuiltDir)) throw err;
      await fallback("CMake configure failed");
      await this.ensureConfigured(deadline, signal, confOpts);
    }

    const build = async (): Promise<RunResult> => {
      let res = await this.run(buildBuildArgs(this.config), deadline, signal, "Build");
      if (res.code !== 0 && CACHE_MISSING_RE.test(res.stdout + res.stderr)) {
        // Build dir was deleted/corrupted while we were running: reconfigure once.
        this.configuredKey = null;
        await this.writeSource(unit.source, unit.snippet);
        await this.ensureConfigured(deadline, signal, confOpts);
        res = await this.run(buildBuildArgs(this.config), deadline, signal, "Build");
      }
      return res;
    };

    let res = await build();
    if (res.code !== 0 && confOpts.prebuiltDir && isPrebuiltFailure(`${res.stdout}\n${res.stderr}`, confOpts.prebuiltDir)) {
      await fallback("Linking failed");
      await this.ensureConfigured(deadline, signal, confOpts);
      res = await build();
    }

    const userFiles = unit.userFiles ?? USER_FILES;
    const output = focusOnUserFiles(
      cleanBuildOutput(`${res.stdout}\n${res.stderr}`, this.pathShortening(unit.stripDirs)),
      userFiles
    );
    const all = parseDiagnostics(output);
    const diagnostics = all.filter((d) => d.severity === "error" || userFiles.includes(d.file) || d.file === "");
    const success = res.code === 0;
    if (success) this.builtThisSession = true;
    const result: CompileResult = {
      success,
      executablePath: success ? this.executablePath() : undefined,
      diagnostics,
      output: truncate(output, 8000),
      hints: diagnosticHints(diagnostics, unit.fullFile),
      cached: false,
      notes,
    };
    this.lastKey = success && cacheable ? key : null;
    this.lastResult = success && cacheable ? result : null;
    return result;
  }

  /**
   * Make sure the build dir holds a current simulator binary (JSON UI mode
   * does not run create_ui(), so a placeholder user_code.c is fine).
   */
  async ensureBinary(signal?: AbortSignal): Promise<CompileResult> {
    if (this.builtThisSession && this.hasBuiltBinary()) {
      return { success: true, executablePath: this.executablePath(), diagnostics: [], output: "", hints: [], cached: true, notes: [] };
    }
    return this.compileUnit({ source: PLACEHOLDER_SOURCE, snippet: null, fullFile: true }, signal);
  }
}

const PLACEHOLDER_SOURCE =
  '#include "lvgl.h"\nvoid create_ui(void) {\n    lv_obj_t *label = lv_label_create(lv_screen_active());\n    lv_label_set_text(label, "LVGL Simulator Ready");\n    lv_obj_center(label);\n}\n';

/** Keep at most `max` characters, preferring the start (first errors matter most). */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n... (${text.length - max} more characters truncated)`;
}
