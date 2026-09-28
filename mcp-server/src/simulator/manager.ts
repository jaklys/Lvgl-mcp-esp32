import * as fs from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { boardDefaults } from "../boards.js";
import { formatDoctorReport, runDoctor, type DoctorReport } from "../doctor.js";
import {
  SimulatorCompiler,
  USER_FILES,
  detectCompilerConfig,
  type CompileResult,
  type CompileUnit,
  type CompilerConfig,
} from "./compiler.js";
import { formatDiagnostic } from "./diagnostics.js";
import { SimulatorError } from "./errors.js";
import { withDirLock } from "./lock.js";
import { pngSize } from "./png.js";
import type { PrebuiltInfo } from "./prebuilt.js";
import { envGet, isWindows, runProcess, type RunResult } from "./process.js";
import {
  ProjectPathError,
  collectSources,
  entryWrapperSource,
  isValidDefine,
  stageInlineFiles,
  validateRelativePath,
} from "./project.js";
import type {
  CaptureImage,
  CheckResult,
  ProjectConfig,
  ProjectRequest,
  RenderMode,
  RenderRequest,
  RenderResult,
  ResolvedRenderParams,
  SimOutput,
  SimulatorBackend,
  WidgetNode,
} from "./types.js";

export const DEFAULT_WIDTH = 800;
export const DEFAULT_HEIGHT = 480;
export const DEFAULT_TIME_MS = 330;
export const DEFAULT_DPI = 130;
export const DEFAULT_COMPILE_TIMEOUT_MS = 180_000;
export const DEFAULT_RUN_TIMEOUT_MS = 15_000;

function envInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface SimArgPaths {
  /** Directory for multi-capture outputs (capture-<n>-<label>.png, annotated-...). */
  outputDir?: string;
  /** JSON action script file. */
  actionsPath?: string;
  /** JSON UI document file (UI mode). */
  uiPath?: string;
}

/**
 * Build the command line for the simulator binary (contract sections 1 and
 * 10). 2.2.0 flags are only passed when used, so plain renders keep working
 * with an older simulator binary.
 */
export function buildSimArgs(p: ResolvedRenderParams, pngPath: string, jsonPath: string, extra: SimArgPaths = {}): string[] {
  const args = [
    "--width",
    String(p.width),
    "--height",
    String(p.height),
    "--output-png",
    pngPath,
    "--output-json",
    jsonPath,
    "--time-ms",
    String(p.timeMs),
    "--rotation",
    String(p.rotation),
    "--theme",
    p.theme,
    "--dpi",
    String(p.dpi),
    "--assets-dir",
    p.assetsDir,
  ];
  if (p.settle) args.push("--settle");
  if (extra.outputDir) args.push("--output-dir", extra.outputDir);
  if (extra.actionsPath) args.push("--actions", extra.actionsPath);
  if (p.frames && p.frames.length) args.push("--frames", p.frames.join(","));
  if (p.annotate) args.push("--annotate");
  if (p.scale !== undefined && p.scale !== 1) args.push("--scale", String(p.scale));
  if (p.colorFormat) args.push("--color-format", p.colorFormat);
  if (p.fonts && p.fonts.length) args.push("--fonts", p.fonts.join(","));
  if (p.memBudgetKb !== undefined) args.push("--mem-budget-kb", String(p.memBudgetKb));
  if (extra.uiPath) args.push("--ui", extra.uiPath);
  return args;
}

/** Whether a render produces several captures / annotated images (needs --output-dir). */
export function needsOutputDir(p: ResolvedRenderParams): boolean {
  return !!(p.annotate || (p.frames && p.frames.length) || (p.actions && p.actions.length));
}

/** Font names as the tree prints them: "lv_font_montserrat_14" -> "montserrat_14". */
export function normalizeFontName(f: string): string {
  return f.trim().replace(/^&?lv_font_/, "");
}

/**
 * Minimal environment for running user code: no secrets from the server's
 * environment leak into the simulator process.
 */
export function simulatorEnv(src: NodeJS.ProcessEnv = process.env, windows = isWindows): NodeJS.ProcessEnv {
  // TMPDIR: per-user temp dir on macOS (/var/folders/...), also used on Linux.
  const keys = ["PATH", "SystemRoot", "TEMP", "TMP", "TMPDIR", "HOME"];
  if (windows) keys.push("windir", "ComSpec", "USERPROFILE", "LOCALAPPDATA");
  const env: NodeJS.ProcessEnv = {};
  for (const k of keys) {
    const v = envGet(src, k);
    if (v !== undefined) env[k] = v;
  }
  env["LANG"] = "C";
  return env;
}

const PHASE_RE = /^\[sim\]\s*phase=(\S+)/;

/** Split simulator stderr into LVGL log lines and the last phase marker. */
export function splitStderr(stderr: string): { logs: string[]; phase?: string; other: string[] } {
  const logs: string[] = [];
  const other: string[] = [];
  let phase: string | undefined;
  for (const raw of stderr.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    if (!line) continue;
    const m = PHASE_RE.exec(line);
    if (m) {
      phase = m[1];
      continue;
    }
    if (line.startsWith("[sim]")) continue;
    if (/^\[(Trace|Info|Warn|Error|User)\]/.test(line)) logs.push(line);
    else other.push(line);
  }
  return { logs, phase, other };
}

const PHASE_TEXT: Record<string, string> = {
  create_ui: "while running create_ui() (your code)",
  ui: "while building the JSON UI document",
  actions: "while running the action script",
  advance: "while advancing simulated time (timers, animations, event callbacks, layout or drawing)",
  capture: "while rendering the screenshot",
  export: "while exporting the PNG/JSON",
};

function phaseText(phase: string | undefined): string {
  if (!phase) return "";
  return PHASE_TEXT[phase] ?? `in phase ${phase}`;
}

const WINDOWS_CRASH: Record<number, string> = {
  0xc0000005: "ACCESS_VIOLATION (0xC0000005) (NULL or deleted object?)",
  0xc00000fd: "STACK_OVERFLOW (0xC00000FD) (infinite recursion or huge local array?)",
  0xc0000409: "STACK_BUFFER_OVERRUN / fail-fast (0xC0000409) (abort() or buffer overflow?)",
  0xc0000094: "INTEGER_DIVIDE_BY_ZERO (0xC0000094)",
  0xc000001d: "ILLEGAL_INSTRUCTION (0xC000001D)",
  0xc0000374: "HEAP_CORRUPTION (0xC0000374) (double free or buffer overflow?)",
  0xc0000008: "INVALID_HANDLE (0xC0000008)",
  0x80000003: "BREAKPOINT (0x80000003) (debug assert?)",
};

const SIGNAL_HINT: Record<string, string> = {
  SIGSEGV: "(NULL or deleted object?)",
  // macOS reports some invalid accesses (e.g. to protected pages) as SIGBUS.
  SIGBUS: "(invalid memory access: NULL or deleted object?)",
  SIGTRAP: "(trap instruction: __builtin_trap() or undefined behavior?)",
  SIGABRT: "(abort(), failed assert() or heap corruption?)",
  SIGFPE: "(division by zero?)",
  SIGILL: "(illegal instruction)",
  SIGKILL: "(killed - out of memory?)",
};

function tailBlock(title: string, lines: string[], max: number): string {
  if (lines.length === 0) return "";
  const shown = lines.slice(-max);
  const more = lines.length > shown.length ? ` (last ${shown.length} of ${lines.length})` : "";
  return `\n\n${title}${more}:\n${shown.join("\n")}`;
}

/** Map a failed simulator run to a SimulatorError with an actionable message. */
export function mapRunFailure(res: RunResult, runTimeoutMs: number): SimulatorError {
  const { logs, phase, other } = splitStderr(res.stderr);
  const stderrLines = [...logs, ...other];
  const stdoutLines = res.stdout.replace(/\r\n?/g, "\n").split("\n").filter((l) => l.trim());
  const extra = { logs: stderrLines.slice(-40), stdout: res.stdout.slice(-4000) };
  const suffix = () =>
    tailBlock("LVGL log / stderr", stderrLines, 20) + tailBlock("printf output", stdoutLines, 10);

  if (res.timedOut) {
    return new SimulatorError(
      "timeout",
      `Simulator timed out after ${Math.round(runTimeoutMs / 1000)} s (infinite loop?)${phase ? " " + phaseText(phase) : ""}. ` +
        "There is no real event loop: do not busy-wait or loop forever; use lv_timer/lv_anim and the time_ms parameter instead." +
        suffix(),
      extra
    );
  }
  if (res.signal) {
    const hint = SIGNAL_HINT[res.signal] ?? "";
    return new SimulatorError(
      "crash",
      `Simulator crashed with ${res.signal} ${hint} ${phaseText(phase)}.`.replace(/\s+\./, ".") + suffix(),
      extra
    );
  }
  const code = res.code ?? -1;
  const unsigned = code >>> 0;
  if (WINDOWS_CRASH[unsigned]) {
    return new SimulatorError(
      "crash",
      `Simulator crashed with ${WINDOWS_CRASH[unsigned]} ${phaseText(phase)}.`.replace(/\s+\./, ".") + suffix(),
      extra
    );
  }
  switch (code) {
    case 3: {
      const last = stderrLines.slice(-6).join("\n") || "(no log output)";
      return new SimulatorError(
        "assertion",
        `LVGL assertion failed${phase ? " " + phaseText(phase) : ""}:\n${last}\n` +
          "Typical causes: NULL/deleted object passed to an lv_* function, invalid argument, or out of memory." +
          tailBlock("printf output", stdoutLines, 10),
        extra
      );
    }
    case 2:
      return new SimulatorError("output", "Simulator could not write its output files (PNG/JSON)." + suffix(), extra);
    case 1: {
      const unknown = /Unknown (?:argument|option):?\s*(--[\w-]+)/i.exec(res.stderr);
      if (unknown) {
        return new SimulatorError(
          "args",
          `The simulator binary does not support ${unknown[1]} - it is older than this server (2.2.0 features need a 2.2.0 simulator). ` +
            "Rebuild it (delete the build directory) or reinstall the npm package so the matching simulator is downloaded." +
            suffix(),
          extra
        );
      }
      return new SimulatorError("args", "Simulator rejected its arguments (exit 1)." + suffix(), extra);
    }
    case 5: {
      // One line per problem: "ui: <json-path>: <message>" (contract section 10).
      const problems = stderrLines.filter((l) => /^ui: /.test(l));
      const body = problems.length ? problems.join("\n") : stderrLines.slice(-30).join("\n") || "(no details on stderr)";
      return new SimulatorError(
        "ui",
        `The JSON UI document was rejected (${problems.length || "unknown number of"} problem${problems.length === 1 ? "" : "s"}):\n${body}\n` +
          "Fix every listed path and render again. The vocabulary (widget types, keys, style names) is in lvgl_docs topic \"ui-json\"; it is the same as the widget tree the renders return." +
          tailBlock("printf output", stdoutLines, 10),
        extra
      );
    }
    case 6: {
      // stderr carries the problem and the list of known object names. The
      // simulator prefixes them with "[sim] " like its progress lines:
      // "[sim] actions[0] (click): no object named ...", "[sim] invalid action script ...".
      const simErrors = res.stderr
        .replace(/\r\n?/g, "\n")
        .split("\n")
        .filter((l) => /^\[sim\] (actions\[\d+\]|invalid action script|action script|out of memory)/.test(l))
        .map((l) => l.replace(/^\[sim\] /, "").trimEnd());
      const detail = [...simErrors, ...(other.length ? other : simErrors.length ? [] : stderrLines)];
      return new SimulatorError(
        "action",
        `Action script error${phase ? " " + phaseText(phase) : ""}:\n${detail.slice(-30).join("\n") || "(no details on stderr)"}\n` +
          "Targets are object names set with lv_obj_set_name (or \"name\" in a JSON UI) or tree paths like \"lv_button#2\"; see lvgl_docs topic \"actions\"." +
          tailBlock("LVGL log", logs, 10),
        extra
      );
    }
    default:
      return new SimulatorError(
        "runtime",
        `Simulator exited with code ${code}${phase ? " " + phaseText(phase) : ""} (did the code call exit()?).` + suffix(),
        extra
      );
  }
}

/**
 * Parse the simulator JSON. Accepts format_version 2 and 3 (3 adds captures,
 * mem, fonts_used, diagnostics, input, events - malformed optional fields are
 * dropped rather than failing the render); a legacy (v1) file whose root is
 * the screen node is wrapped so callers see one shape.
 */
export function parseSimJson(text: string, fallback: { width: number; height: number }): SimOutput {
  const raw = JSON.parse(text) as Record<string, unknown>;
  if (typeof raw["format_version"] === "number" && raw["screen"]) {
    const out = raw as unknown as SimOutput;
    return {
      ...out,
      lvgl_version: String(out.lvgl_version ?? "unknown"),
      display: out.display ?? { width: fallback.width, height: fallback.height },
      elapsed_ms: Number(out.elapsed_ms ?? 0),
      anims_running: Number(out.anims_running ?? 0),
      logs: Array.isArray(out.logs) ? out.logs.map(String) : [],
      captures: Array.isArray(out.captures)
        ? out.captures.filter((c) => c && typeof c === "object" && typeof c.png === "string")
        : undefined,
      mem: out.mem && typeof out.mem === "object" && typeof out.mem.peak_bytes === "number" ? out.mem : undefined,
      fonts_used: Array.isArray(out.fonts_used) ? out.fonts_used.map(String) : undefined,
      diagnostics: Array.isArray(out.diagnostics)
        ? out.diagnostics.filter((d) => d && typeof d === "object" && typeof d.code === "string")
        : undefined,
      input: out.input && typeof out.input === "object" ? out.input : undefined,
      events: Array.isArray(out.events) ? out.events.filter((e) => e && typeof e === "object") : undefined,
    };
  }
  if (typeof raw["type"] === "string") {
    return {
      format_version: 1,
      lvgl_version: "unknown",
      display: { width: fallback.width, height: fallback.height },
      elapsed_ms: 0,
      anims_running: 0,
      logs: [],
      screen: raw as unknown as WidgetNode,
    };
  }
  throw new Error("unrecognised widget tree JSON (no format_version/screen)");
}


/** Safe file name inside the output dir (the binary reports names relative to --output-dir). */
function outputFile(dir: string, name: string): string {
  return path.join(dir, path.basename(name));
}

/**
 * Read every capture listed in the JSON `captures` array (plain + annotated
 * PNGs). Without a captures array the final PNG is the only capture; an
 * annotated image is then looked up by file name (annotated-*.png).
 */
export async function collectCaptures(
  output: SimOutput,
  outputDir: string,
  finalPng: Buffer,
  readFile: (p: string) => Promise<Buffer> = (p) => fs.readFile(p)
): Promise<{ captures: CaptureImage[]; missing: string[] }> {
  const missing: string[] = [];
  const read = async (name: string | undefined): Promise<Buffer | undefined> => {
    if (!name) return undefined;
    try {
      const buf = await readFile(outputFile(outputDir, name));
      if (pngSize(buf)) return buf;
    } catch {
      /* reported below */
    }
    missing.push(name);
    return undefined;
  };
  const captures: CaptureImage[] = [];
  for (const [i, c] of (output.captures ?? []).entries()) {
    const png = await read(c.png);
    if (!png) continue;
    captures.push({
      n: typeof c.n === "number" ? c.n : i + 1,
      label: String(c.label ?? `capture${i + 1}`),
      elapsedMs: Number(c.elapsed_ms ?? 0),
      png,
      annotated: await read(c.annotated),
      screen: c.screen,
      layerTop: c.layer_top,
    });
  }
  if (captures.length === 0) {
    let annotated: Buffer | undefined;
    try {
      const names = (await fs.readdir(outputDir)).filter((n) => /^annotated-.*\.png$/i.test(n)).sort();
      if (names.length) annotated = await read(names[names.length - 1]);
    } catch {
      /* no output dir listing */
    }
    captures.push({
      n: 1,
      label: "final",
      elapsedMs: output.elapsed_ms,
      png: finalPng,
      annotated,
      screen: output.screen,
      layerTop: output.layer_top,
    });
  }
  return { captures, missing };
}

export interface ManagerOptions {
  simulatorDir: string;
  serverVersion?: string;
  env?: NodeJS.ProcessEnv;
  compileTimeoutMs?: number;
  runTimeoutMs?: number;
  /** Override tool detection (tests). */
  compilerConfig?: CompilerConfig;
  /** Toolchain check; default runDoctor(). */
  doctor?: (cfg: CompilerConfig) => Promise<DoctorReport>;
  /** Override prebuilt detection (tests). */
  prebuilt?: PrebuiltInfo;
}

/** Which simulator binary a JSON UI render uses (contract sections 7 and 10). */
export type UiBinaryChoice = "built" | "prebuilt" | "build-then-built" | "none";

/**
 * JSON UI mode needs no user code, so any current simulator binary works:
 *  - a binary built by this session is current -> use it;
 *  - no binary in the build dir but a prebuilt lvgl_sim -> prebuilt (no toolchain needed);
 *  - toolchain OK -> (re)build the build-dir binary (it may be stale from an older version);
 *  - toolchain broken: prebuilt if present, else an existing built binary, else nothing.
 */
export function chooseUiBinary(s: {
  builtThisSession: boolean;
  hasBuiltBinary: boolean;
  hasPrebuiltSim: boolean;
  toolchainOk: boolean;
}): UiBinaryChoice {
  if (s.builtThisSession && s.hasBuiltBinary) return "built";
  if (s.hasPrebuiltSim && !s.hasBuiltBinary) return "prebuilt";
  if (s.toolchainOk) return "build-then-built";
  if (s.hasPrebuiltSim) return "prebuilt";
  if (s.hasBuiltBinary) return "built";
  return "none";
}

export class SimulatorManager implements SimulatorBackend {
  readonly compilerConfig: CompilerConfig;
  readonly compiler: SimulatorCompiler;
  private readonly env: NodeJS.ProcessEnv;
  private readonly serverVersion: string;
  readonly compileTimeoutMs: number;
  readonly runTimeoutMs: number;
  private readonly doctorFn: (cfg: CompilerConfig) => Promise<DoctorReport>;
  private doctorReport: DoctorReport | null = null;
  private doctorRun: Promise<DoctorReport> | null = null;
  private width = DEFAULT_WIDTH;
  private height = DEFAULT_HEIGHT;
  private lastResult: RenderResult | null = null;
  private lastLvglVersion: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(opts: ManagerOptions) {
    this.env = opts.env ?? process.env;
    this.serverVersion = opts.serverVersion ?? "unknown";
    this.compileTimeoutMs = opts.compileTimeoutMs ?? envInt(this.env, "LVGL_COMPILE_TIMEOUT_MS", DEFAULT_COMPILE_TIMEOUT_MS);
    this.runTimeoutMs = opts.runTimeoutMs ?? envInt(this.env, "LVGL_RUN_TIMEOUT_MS", DEFAULT_RUN_TIMEOUT_MS);
    this.compilerConfig = opts.compilerConfig ?? detectCompilerConfig(opts.simulatorDir, this.env);
    this.compiler = new SimulatorCompiler(this.compilerConfig, {
      timeoutMs: this.compileTimeoutMs,
      prebuilt: opts.prebuilt,
      env: this.env,
    });
    this.doctorFn = opts.doctor ?? ((cfg) => runDoctor(cfg, this.env));
  }

  get prebuilt(): PrebuiltInfo {
    return this.compiler.prebuilt;
  }

  /** Run the toolchain doctor (cached once it passed; re-run after a failure). */
  doctor(): Promise<DoctorReport> {
    if (this.doctorReport?.ok) return Promise.resolve(this.doctorReport);
    if (!this.doctorRun) {
      this.doctorRun = this.doctorFn(this.compilerConfig)
        .then((r) => {
          this.doctorReport = r;
          return r;
        })
        .finally(() => {
          this.doctorRun = null;
        });
    }
    return this.doctorRun;
  }

  private async ensureReady(): Promise<void> {
    const report = await this.doctor();
    if (!report.ok) throw new SimulatorError("setup", formatDoctorReport(report));
  }

  /** Serialize all compile/run work: there is one build directory. */
  private enqueue<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const run = async () => {
      if (signal?.aborted) throw new SimulatorError("cancelled", "Request cancelled by the client.");
      return fn();
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  /** Hold the cross-process build-directory lock while compiling/running. */
  private locked<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const budget = this.compileTimeoutMs + this.runTimeoutMs;
    return withDirLock(this.compilerConfig.buildDir, { waitMs: budget, staleMs: budget + 60_000, signal }, fn);
  }

  /**
   * Resolve a request into concrete parameters. Precedence: explicit
   * parameter > board preset > session default (lvgl_set_resolution) >
   * built-in default.
   */
  resolveParams(req: RenderRequest): ResolvedRenderParams {
    const board = boardDefaults(req.board);
    const mode: RenderMode = req.mode ?? (req.full ? "full" : "snippet");
    const assetsDir = path.resolve(
      req.assetsDir ?? (mode === "project" && req.project?.root ? req.project.root : undefined) ?? this.env["LVGL_ASSETS_DIR"] ?? process.cwd()
    );
    if (req.frames?.length && req.actions?.length) {
      throw new SimulatorError(
        "args",
        'Pass either frames or actions, not both (add {"wait": ms} and {"capture": "label"} steps to the actions instead).'
      );
    }
    return {
      full: mode === "full",
      mode,
      width: req.width ?? board?.width ?? this.width,
      height: req.height ?? board?.height ?? this.height,
      timeMs: req.timeMs ?? DEFAULT_TIME_MS,
      settle: req.settle ?? false,
      rotation: req.rotation ?? board?.rotation ?? 0,
      theme: req.theme ?? "light",
      dpi: req.dpi ?? board?.dpi ?? DEFAULT_DPI,
      assetsDir,
      board: req.board,
      colorFormat: req.colorFormat ?? board?.colorFormat,
      scale: req.scale,
      fonts: req.fonts?.length ? [...new Set(req.fonts.map(normalizeFontName))] : undefined,
      memBudgetKb: req.memBudgetKb ?? board?.memBudgetKb,
      annotate: req.annotate ?? false,
      frames: req.frames?.length ? req.frames : undefined,
      actions: req.actions?.length ? req.actions : undefined,
      espShims: req.espShims ?? mode === "project",
    };
  }

  private compileFailure(res: CompileResult, extraHints: string[] = []): SimulatorError {
    const errors = res.diagnostics.filter((d) => d.severity === "error");
    const warnings = res.diagnostics.filter((d) => d.severity === "warning");
    let msg = `Compilation failed (${errors.length} error${errors.length === 1 ? "" : "s"}, ${warnings.length} warning${warnings.length === 1 ? "" : "s"}):\n`;
    msg += res.output || res.diagnostics.map(formatDiagnostic).join("\n") || "(no compiler output)";
    const hints = [...res.hints, ...extraHints];
    if (hints.length) msg += "\n\nHints:\n" + hints.map((h) => `- ${h}`).join("\n");
    return new SimulatorError("compile", msg, { diagnostics: res.diagnostics });
  }

  render(req: RenderRequest, signal?: AbortSignal): Promise<RenderResult> {
    let params: ResolvedRenderParams;
    try {
      params = this.resolveParams(req);
    } catch (err) {
      return Promise.reject(err instanceof SimulatorError ? err : new SimulatorError("args", (err as Error).message));
    }
    return this.enqueue(async () => {
      if (!existsSync(params.assetsDir) || !statSync(params.assetsDir).isDirectory()) {
        throw new SimulatorError("args", `assets_dir does not exist or is not a directory: ${params.assetsDir}`);
      }
      if (params.mode === "ui") return this.renderUi(req, params, signal);
      await this.ensureReady();
      return this.locked(() => this.compileAndRun(req, params, signal), signal);
    }, signal);
  }

  /** JSON UI mode: no compilation when a prebuilt (or this session's) binary is available. */
  private async renderUi(req: RenderRequest, params: ResolvedRenderParams, signal?: AbortSignal): Promise<RenderResult> {
    if (!req.ui || typeof req.ui !== "object") throw new SimulatorError("args", "UI mode needs a `ui` document (JSON object).");
    const hasBuilt = this.compiler.hasBuiltBinary();
    const hasPrebuiltSim = !!this.prebuilt.simulator;
    // Ask the doctor (slow on the first call) only when the answer matters.
    let choice: UiBinaryChoice;
    let report: DoctorReport | null = null;
    if (this.compiler.builtThisSession && hasBuilt) choice = "built";
    else if (hasPrebuiltSim && !hasBuilt) choice = "prebuilt";
    else {
      report = await this.doctor();
      choice = chooseUiBinary({ builtThisSession: false, hasBuiltBinary: hasBuilt, hasPrebuiltSim, toolchainOk: report.ok });
    }
    if (choice === "none") {
      throw new SimulatorError(
        "setup",
        `JSON UI rendering needs either the prebuilt simulator (${this.prebuilt.dir ?? `simulator/prebuilt/${this.prebuilt.platform ?? "<platform>"}`}/lvgl_sim, shipped in the release archives) or a working toolchain to build it.\n` +
          (report ? formatDoctorReport(report) : "")
      );
    }
    if (choice === "prebuilt") {
      return this.runSimulator(this.prebuilt.simulator!, req, params, signal, { compileMs: 0, cached: true, warnings: [], notes: [] }, "prebuilt");
    }
    return this.locked(async () => {
      const t0 = Date.now();
      let compiled: CompileResult | null = null;
      if (choice === "build-then-built") {
        compiled = await this.compiler.ensureBinary(signal);
        if (!compiled.success) throw this.compileFailure(compiled);
      }
      return this.runSimulator(
        this.compiler.executablePath(),
        req,
        params,
        signal,
        { compileMs: Date.now() - t0, cached: compiled?.cached ?? true, warnings: [], notes: compiled?.notes ?? [] },
        "built"
      );
    }, signal);
  }

  /** Build the compile unit for project mode (stage inline files / scan the root). */
  private async projectUnit(p: ProjectRequest, espShims: boolean): Promise<{ unit: CompileUnit; hints: string[] }> {
    try {
      let root: string;
      if (p.files && p.files.length) {
        root = path.join(this.compilerConfig.buildDir, "user_project");
        await stageInlineFiles(root, p.files);
        root = await fs.realpath(root);
      } else if (p.root) {
        root = p.root;
      } else {
        throw new ProjectPathError("pass either `files` (inline sources) or `root` (a project directory)");
      }
      const col = await collectSources(root, p.exclude ?? []);
      const includeDirs = [root, ...col.headerDirs];
      for (const d of p.includeDirs ?? []) {
        const abs = path.isAbsolute(d) ? d : path.join(root, ...validateRelativePath(d, "include dir").split("/"));
        if (!includeDirs.includes(abs)) includeDirs.push(abs);
      }
      const defines = [...(p.defines ?? [])];
      for (const d of defines) if (!isValidDefine(d)) throw new ProjectPathError(`invalid define "${d}" (expected NAME or NAME=value)`);
      const userFiles = [
        ...USER_FILES,
        ...col.relSources,
        ...col.relHeaders,
        ...col.relSources.map((f) => path.posix.basename(f)),
        ...col.relHeaders.map((f) => path.posix.basename(f)),
      ];
      const hints: string[] = [];
      if (col.hasCxx) hints.push(`In C++ files declare the entry function with C linkage: extern "C" void ${p.entry}(void);`);
      return {
        unit: {
          source: entryWrapperSource(await this.compiler.projectWrapperTemplate(), p.entry),
          snippet: null,
          fullFile: true,
          sources: col.sources,
          includeDirs,
          defines,
          espShims,
          userFiles,
          stripDirs: [root, p.root ?? root],
          cacheable: false,
        },
        hints,
      };
    } catch (err) {
      if (err instanceof ProjectPathError) throw new SimulatorError("project", err.message);
      throw err;
    }
  }

  private async compileAndRun(
    req: RenderRequest,
    params: ResolvedRenderParams,
    signal: AbortSignal | undefined
  ): Promise<RenderResult> {
    const t0 = Date.now();
    let compiled: CompileResult;
    if (params.mode === "project") {
      if (!req.project) throw new SimulatorError("args", "Project mode needs `files` or `root`.");
      const { unit, hints } = await this.projectUnit(req.project, params.espShims);
      compiled = await this.compiler.compileUnit(unit, signal);
      const undefinedEntry = compiled.diagnostics.some((d) => d.message.includes(req.project!.entry));
      if (!compiled.success) throw this.compileFailure(compiled, undefinedEntry ? hints : []);
    } else {
      compiled = await this.compiler.compile(req.code, params.mode === "full", signal, params.espShims);
      if (!compiled.success) throw this.compileFailure(compiled);
    }
    return this.runSimulator(
      compiled.executablePath!,
      req,
      params,
      signal,
      {
        compileMs: Date.now() - t0,
        cached: compiled.cached,
        warnings: compiled.diagnostics.filter((d) => d.severity !== "error"),
        notes: compiled.notes ?? [],
      },
      "built"
    );
  }

  private async runSimulator(
    exe: string,
    req: RenderRequest,
    params: ResolvedRenderParams,
    signal: AbortSignal | undefined,
    build: { compileMs: number; cached: boolean; warnings: CompileResult["diagnostics"]; notes: string[] },
    binary: "built" | "prebuilt"
  ): Promise<RenderResult> {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lvgl-mcp-"));
    try {
      const pngPath = path.join(tmp, "screenshot.png");
      const jsonPath = path.join(tmp, "tree.json");
      const extra: { outputDir?: string; actionsPath?: string; uiPath?: string } = {};
      if (needsOutputDir(params)) extra.outputDir = tmp;
      if (params.actions?.length) {
        extra.actionsPath = path.join(tmp, "actions.json");
        await fs.writeFile(extra.actionsPath, JSON.stringify(params.actions, null, 1), "utf-8");
      }
      if (params.mode === "ui") {
        extra.uiPath = path.join(tmp, "ui.json");
        await fs.writeFile(extra.uiPath, JSON.stringify(req.ui, null, 1), "utf-8");
      }
      const t1 = Date.now();
      const res = await runProcess(exe, buildSimArgs(params, pngPath, jsonPath, extra), {
        cwd: tmp,
        env: simulatorEnv(this.env),
        timeoutMs: this.runTimeoutMs,
        signal,
      });
      const runMs = Date.now() - t1;
      if (res.spawnError) {
        throw new SimulatorError("runtime", `Could not start the simulator binary ${exe}: ${res.spawnError.message}`);
      }
      if (res.aborted) throw new SimulatorError("cancelled", "Render cancelled by the client.");
      if (res.timedOut || res.code !== 0) throw mapRunFailure(res, this.runTimeoutMs);

      let png: Buffer;
      let jsonText: string;
      try {
        png = await fs.readFile(pngPath);
        jsonText = await fs.readFile(jsonPath, "utf-8");
      } catch (err) {
        const e = mapRunFailure({ ...res, code: 2 }, this.runTimeoutMs);
        throw new SimulatorError("output", `Simulator exited successfully but produced no output (${(err as Error).message}).` + e.message.replace(/^[^\n]*/, ""));
      }
      const size = pngSize(png);
      if (!size) throw new SimulatorError("output", "Simulator produced an invalid PNG file.");
      let output: SimOutput;
      try {
        output = parseSimJson(jsonText, { width: params.width, height: params.height });
      } catch (err) {
        throw new SimulatorError("output", `Simulator produced an invalid widget tree JSON: ${(err as Error).message}`);
      }
      const { captures, missing } = await collectCaptures(output, tmp, png);
      const notes = [...build.notes];
      if (missing.length) notes.push(`Capture image(s) listed in the JSON but missing or invalid: ${missing.join(", ")}`);
      if (binary === "prebuilt") notes.push("Rendered with the prebuilt simulator binary (no compilation).");
      const stderrLogs = splitStderr(res.stderr).logs;
      const result: RenderResult = {
        png,
        pngWidth: size.width,
        pngHeight: size.height,
        captures,
        output,
        params,
        warnings: build.warnings,
        logs: output.logs.length > 0 ? output.logs : stderrLogs,
        stdout: res.stdout,
        compileMs: build.compileMs,
        runMs,
        compileCached: build.cached,
        binary,
        notes,
      };
      this.lastResult = result;
      if (output.lvgl_version && output.lvgl_version !== "unknown") this.lastLvglVersion = output.lvgl_version;
      return result;
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  check(code: string, full: boolean, signal?: AbortSignal): Promise<CheckResult> {
    return this.enqueue(async () => {
      await this.ensureReady();
      const r = await this.locked(() => this.compiler.compile(code, full, signal), signal);
      return { success: r.success, diagnostics: r.diagnostics, output: r.output, hints: r.hints };
    }, signal);
  }

  getLastResult(): RenderResult | null {
    return this.lastResult;
  }

  getDefaults(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  setDefaults(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  getConfig(): ProjectConfig {
    const r = this.doctorReport;
    const pb = this.prebuilt;
    return {
      server_version: this.serverVersion,
      lvgl_version: this.lastLvglVersion ?? "unknown until first render",
      default_width: this.width,
      default_height: this.height,
      default_time_ms: DEFAULT_TIME_MS,
      default_dpi: DEFAULT_DPI,
      color_format: "XRGB8888 (32 bpp) by default; color_format=\"rgb565\" or a board preset renders like a 16 bpp panel",
      color_formats: ["xrgb8888", "rgb565"],
      themes: ["light", "dark"],
      rotations: [0, 90, 180, 270],
      simulator_dir: this.compilerConfig.simulatorDir,
      build_dir: this.compilerConfig.buildDir,
      compile_timeout_ms: this.compileTimeoutMs,
      run_timeout_ms: this.runTimeoutMs,
      platform_id: pb.platform,
      prebuilt: {
        dir: pb.dir,
        library: pb.library,
        simulator: pb.simulator,
        disabled: this.compiler.prebuiltDisabled,
      },
      ui_without_toolchain: !!pb.simulator,
      toolchain: r ? { ok: r.ok, problems: r.problems, notes: r.notes } : "not checked yet",
    };
  }
}
