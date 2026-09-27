import type { Diagnostic } from "./diagnostics.js";

export type Rotation = 0 | 90 | 180 | 270;
export type Theme = "light" | "dark";

/** A widget node of the simulator's JSON tree (format_version 2). */
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

/** Top-level simulator JSON output (format_version 2). */
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
  };
  elapsed_ms: number;
  anims_running: number;
  logs: string[];
  screen: WidgetNode;
  layer_top?: WidgetNode;
  layer_sys?: WidgetNode;
}

export interface RenderRequest {
  code: string;
  /** true = complete C file defining create_ui(); false = snippet. */
  full: boolean;
  width?: number;
  height?: number;
  timeMs?: number;
  settle?: boolean;
  rotation?: Rotation;
  theme?: Theme;
  dpi?: number;
  assetsDir?: string;
}

export interface ResolvedRenderParams {
  full: boolean;
  width: number;
  height: number;
  timeMs: number;
  settle: boolean;
  rotation: Rotation;
  theme: Theme;
  dpi: number;
  assetsDir: string;
}

export interface RenderResult {
  png: Buffer;
  /** Size of the PNG image (logical, i.e. after rotation). */
  pngWidth: number;
  pngHeight: number;
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
