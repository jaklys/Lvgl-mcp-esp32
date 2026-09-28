import type { Diagnostic } from "./diagnostics.js";

export type Rotation = 0 | 90 | 180 | 270;
export type Theme = "light" | "dark";
export type ColorFormat = "xrgb8888" | "rgb565";
/** How the UI is produced: C snippet, complete C file, JSON UI document (contract section 10), multi-file C project. */
export type RenderMode = "snippet" | "full" | "ui" | "project";

/** A widget node of the simulator's JSON tree (format_version 2/3). */
export interface WidgetNode {
  type: string;
  name?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  abs?: { x1: number; y1: number; x2: number; y2: number };
  hidden?: boolean;
  visible?: boolean;
  states?: string[];
  flags?: string[];
  text?: string;
  scroll?: { x?: number; y?: number; overflow_x?: boolean; overflow_y?: boolean };
  styles?: Record<string, unknown>;
  indicator?: Record<string, unknown>;
  knob?: Record<string, unknown>;
  children?: WidgetNode[];
  [key: string]: unknown;
}

/** UI diagnostic computed by the simulator (JSON format_version 3, contract section 3). */
export interface UiDiagnostic {
  code: string;
  severity: "error" | "warn" | "info";
  /** null (or absent) for unnamed objects and for diagnostics about no object */
  name?: string | null;
  path?: string | null;
  abs?: { x1: number; y1: number; x2: number; y2: number } | null;
  message: string;
  [key: string]: unknown;
}

/** One capture listed in the JSON `captures` array (format_version 3). */
export interface SimCapture {
  n: number;
  label: string;
  elapsed_ms: number;
  /** PNG file name, relative to --output-dir. */
  png: string;
  /** Annotated PNG file name (only with --annotate). */
  annotated?: string;
  screen?: WidgetNode;
  layer_top?: WidgetNode;
  [key: string]: unknown;
}

export interface SimMem {
  peak_bytes: number;
  used_bytes?: number;
  frag_pct?: number;
  budget_bytes?: number;
  over_budget?: boolean;
}

export interface SimEvent {
  t_ms: number;
  name?: string;
  path?: string;
  event: string;
  [key: string]: unknown;
}

/** Top-level simulator JSON output (format_version 2, or 3 with the 2.2.0 additions). */
export interface SimOutput {
  format_version: number;
  lvgl_version: string;
  display: {
    width: number;
    height: number;
    rotation?: number;
    dpi?: number;
    color_format?: string;
    theme?: string;
    scale?: number;
  };
  elapsed_ms: number;
  anims_running: number;
  logs: string[];
  screen: WidgetNode;
  layer_top?: WidgetNode;
  layer_sys?: WidgetNode;
  // format_version 3
  captures?: SimCapture[];
  mem?: SimMem;
  fonts_used?: string[];
  diagnostics?: UiDiagnostic[];
  input?: { pointer?: boolean; keypad?: boolean; focused?: string | null };
  events?: SimEvent[];
}

/** One action of the action script (contract section 2); validated by the tool layer. */
export type SimAction = Record<string, unknown>;

/** Multi-file C project (lvgl_render_project). */
export interface ProjectRequest {
  /** Inline files, paths relative to the project root (validated: no absolute paths, no ".."). */
  files?: Array<{ path: string; content: string }>;
  /** Existing project directory (already realpath-checked against the allowed roots). */
  root?: string;
  /** Extra include directories, relative to the project root (absolute ones must lie inside it). */
  includeDirs?: string[];
  /** Preprocessor defines "NAME" or "NAME=value". */
  defines?: string[];
  /** Glob patterns (relative to the project root) of sources to skip. */
  exclude?: string[];
  /** Function with C linkage that builds the UI: void entry(void). */
  entry: string;
}

export interface RenderRequest {
  code: string;
  /** true = complete C file defining create_ui(); false = snippet. Ignored for ui/project. */
  full: boolean;
  /** Default: "full" when full=true, else "snippet". */
  mode?: RenderMode;
  /** JSON UI document (mode "ui"), written to a file and passed as --ui. */
  ui?: Record<string, unknown>;
  /** Project sources (mode "project"). */
  project?: ProjectRequest;
  width?: number;
  height?: number;
  timeMs?: number;
  settle?: boolean;
  rotation?: Rotation;
  theme?: Theme;
  dpi?: number;
  assetsDir?: string;
  // 2.2.0
  board?: string;
  colorFormat?: ColorFormat;
  scale?: number;
  fonts?: string[];
  memBudgetKb?: number;
  annotate?: boolean;
  frames?: number[];
  actions?: SimAction[];
  espShims?: boolean;
}

export interface ResolvedRenderParams {
  full: boolean;
  mode: RenderMode;
  width: number;
  height: number;
  timeMs: number;
  settle: boolean;
  rotation: Rotation;
  theme: Theme;
  dpi: number;
  assetsDir: string;
  board?: string;
  colorFormat?: ColorFormat;
  scale?: number;
  fonts?: string[];
  memBudgetKb?: number;
  annotate: boolean;
  frames?: number[];
  actions?: SimAction[];
  espShims: boolean;
}

/** A capture with its image data, as returned to the tool layer. */
export interface CaptureImage {
  n: number;
  label: string;
  elapsedMs: number;
  png: Buffer;
  annotated?: Buffer;
  screen?: WidgetNode;
  layerTop?: WidgetNode;
}

export interface RenderResult {
  /** The final capture (same bytes as the last entry of `captures`). */
  png: Buffer;
  /** Size of the PNG image (after rotation and scale). */
  pngWidth: number;
  pngHeight: number;
  /** Every capture in order; the last one is the final state. Empty only for legacy/fake backends. */
  captures?: CaptureImage[];
  output: SimOutput;
  params: ResolvedRenderParams;
  /** Compiler warnings for the user code (structured). */
  warnings: Diagnostic[];
  /** LVGL log lines (from the JSON, falling back to stderr). */
  logs: string[];
  /** User printf output (simulator stdout). */
  stdout: string;
  compileMs: number;
  runMs: number;
  compileCached: boolean;
  /** Which binary ran: "built" (compiled in the build dir) or "prebuilt" (shipped lvgl_sim). */
  binary?: "built" | "prebuilt";
  /** Non-fatal notes for the model (e.g. prebuilt fallback). */
  notes?: string[];
}

export interface CheckResult {
  success: boolean;
  diagnostics: Diagnostic[];
  output: string;
  hints: string[];
}

export interface ProjectConfig {
  server_version: string;
  lvgl_version: string;
  default_width: number;
  default_height: number;
  default_time_ms: number;
  default_dpi: number;
  color_format: string;
  themes: Theme[];
  rotations: Rotation[];
  simulator_dir: string;
  build_dir: string;
  compile_timeout_ms: number;
  run_timeout_ms: number;
  toolchain: { ok: boolean; problems: string[]; notes: string[] } | "not checked yet";
  // 2.2.0
  color_formats?: ColorFormat[];
  platform_id?: string | null;
  prebuilt?: { dir: string | null; library: string | null; simulator: string | null; disabled: boolean };
  ui_without_toolchain?: boolean;
}

/**
 * What the MCP layer needs from the simulator. Implemented by
 * SimulatorManager; tests substitute a fake.
 */
export interface SimulatorBackend {
  render(req: RenderRequest, signal?: AbortSignal): Promise<RenderResult>;
  check(code: string, full: boolean, signal?: AbortSignal): Promise<CheckResult>;
  getLastResult(): RenderResult | null;
  getDefaults(): { width: number; height: number };
  setDefaults(width: number, height: number): void;
  getConfig(): ProjectConfig;
}
