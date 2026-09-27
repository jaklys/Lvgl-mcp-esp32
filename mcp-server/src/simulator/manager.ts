import * as fs from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { formatDoctorReport, runDoctor, type DoctorReport } from "../doctor.js";
import { SimulatorCompiler, detectCompilerConfig, type CompileResult, type CompilerConfig } from "./compiler.js";
import { formatDiagnostic } from "./diagnostics.js";
import { SimulatorError } from "./errors.js";
import { withDirLock } from "./lock.js";
import { pngSize } from "./png.js";
import { envGet, isWindows, runProcess, type RunResult } from "./process.js";
import type {
  CheckResult,
  ProjectConfig,
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

/** Build the command line for the simulator binary (contract section 1). */
export function buildSimArgs(p: ResolvedRenderParams, pngPath: string, jsonPath: string): string[] {
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
  return args;
}

/**
 * Minimal environment for running user code: no secrets from the server's
 * environment leak into the simulator process.
 */
export function simulatorEnv(src: NodeJS.ProcessEnv = process.env, windows = isWindows): NodeJS.ProcessEnv {
  const keys = ["PATH", "SystemRoot", "TEMP", "TMP", "HOME"];
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
  SIGBUS: "(NULL or deleted object / misaligned access?)",
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
    case 1:
      return new SimulatorError("args", "Simulator rejected its arguments (exit 1)." + suffix(), extra);
    default:
      return new SimulatorError(
        "runtime",
        `Simulator exited with code ${code}${phase ? " " + phaseText(phase) : ""} (did the code call exit()?).` + suffix(),
        extra
      );
  }
}

/**
 * Parse the simulator JSON. Accepts format_version 2; a legacy (v1) file
 * whose root is the screen node is wrapped so callers see one shape.
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
}

export class SimulatorManager implements SimulatorBackend {
  readonly compilerConfig: CompilerConfig;
  private readonly compiler: SimulatorCompiler;
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
    this.compiler = new SimulatorCompiler(this.compilerConfig, { timeoutMs: this.compileTimeoutMs });
    this.doctorFn = opts.doctor ?? ((cfg) => runDoctor(cfg, this.env));
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

  resolveParams(req: RenderRequest): ResolvedRenderParams {
    const assetsDir = path.resolve(req.assetsDir ?? this.env["LVGL_ASSETS_DIR"] ?? process.cwd());
    return {
      full: req.full,
      width: req.width ?? this.width,
      height: req.height ?? this.height,
      timeMs: req.timeMs ?? DEFAULT_TIME_MS,
      settle: req.settle ?? false,
      rotation: req.rotation ?? 0,
      theme: req.theme ?? "light",
      dpi: req.dpi ?? DEFAULT_DPI,
      assetsDir,
    };
  }

  private compileFailure(res: CompileResult): SimulatorError {
    const errors = res.diagnostics.filter((d) => d.severity === "error");
    const warnings = res.diagnostics.filter((d) => d.severity === "warning");
    let msg = `Compilation failed (${errors.length} error${errors.length === 1 ? "" : "s"}, ${warnings.length} warning${warnings.length === 1 ? "" : "s"}):\n`;
    msg += res.output || res.diagnostics.map(formatDiagnostic).join("\n") || "(no compiler output)";
    if (res.hints.length) msg += "\n\nHints:\n" + res.hints.map((h) => `- ${h}`).join("\n");
    return new SimulatorError("compile", msg, { diagnostics: res.diagnostics });
  }

  render(req: RenderRequest, signal?: AbortSignal): Promise<RenderResult> {
    const params = this.resolveParams(req);
    return this.enqueue(async () => {
      if (!existsSync(params.assetsDir) || !statSync(params.assetsDir).isDirectory()) {
        throw new SimulatorError("args", `assets_dir does not exist or is not a directory: ${params.assetsDir}`);
      }
      await this.ensureReady();
      return this.locked(() => this.compileAndRun(req, params, signal), signal);
    }, signal);
  }

  private async compileAndRun(
    req: RenderRequest,
    params: ResolvedRenderParams,
    signal: AbortSignal | undefined
  ): Promise<RenderResult> {
    const t0 = Date.now();
    const compiled = await this.compiler.compile(req.code, req.full, signal);
    if (!compiled.success) throw this.compileFailure(compiled);
    const compileMs = Date.now() - t0;

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lvgl-mcp-"));
    try {
      const pngPath = path.join(tmp, "screenshot.png");
      const jsonPath = path.join(tmp, "tree.json");
      const t1 = Date.now();
      const res = await runProcess(compiled.executablePath!, buildSimArgs(params, pngPath, jsonPath), {
        cwd: tmp,
        env: simulatorEnv(this.env),
        timeoutMs: this.runTimeoutMs,
        signal,
      });
      const runMs = Date.now() - t1;
      if (res.spawnError) {
        throw new SimulatorError("runtime", `Could not start the simulator binary ${compiled.executablePath}: ${res.spawnError.message}`);
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
      const stderrLogs = splitStderr(res.stderr).logs;
      const result: RenderResult = {
        png,
        pngWidth: size.width,
        pngHeight: size.height,
        output,
        params,
        warnings: compiled.diagnostics.filter((d) => d.severity !== "error"),
        logs: output.logs.length > 0 ? output.logs : stderrLogs,
        stdout: res.stdout,
        compileMs,
        runMs,
        compileCached: compiled.cached,
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
    return {
      server_version: this.serverVersion,
      lvgl_version: this.lastLvglVersion ?? "unknown until first render",
      default_width: this.width,
      default_height: this.height,
      default_time_ms: DEFAULT_TIME_MS,
      default_dpi: DEFAULT_DPI,
      color_format: "XRGB8888 (32 bpp)",
      themes: ["light", "dark"],
      rotations: [0, 90, 180, 270],
      simulator_dir: this.compilerConfig.simulatorDir,
      build_dir: this.compilerConfig.buildDir,
      compile_timeout_ms: this.compileTimeoutMs,
      run_timeout_ms: this.runTimeoutMs,
      toolchain: r ? { ok: r.ok, problems: r.problems, notes: r.notes } : "not checked yet",
    };
  }
}
