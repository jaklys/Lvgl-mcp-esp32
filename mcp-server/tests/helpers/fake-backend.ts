import { SimulatorError } from "../../src/simulator/errors.js";
import type {
  CheckResult,
  ProjectConfig,
  RenderRequest,
  RenderResult,
  SimOutput,
  SimulatorBackend,
  WidgetNode,
} from "../../src/simulator/types.js";

/** 1x1 transparent PNG. */
export const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);

export function makeOutput(width: number, height: number, children: WidgetNode[] = []): SimOutput {
  return {
    format_version: 2,
    lvgl_version: "9.6.0",
    display: { width, height, rotation: 0, dpi: 130, color_format: "XRGB8888", theme: "light" },
    elapsed_ms: 330,
    anims_running: 0,
    logs: ["[Warn]\t(0.001, +1)\t lv_fs_open: can't open S:missing.png"],
    screen: {
      type: "lv_obj",
      x: 0,
      y: 0,
      w: width,
      h: height,
      abs: { x1: 0, y1: 0, x2: width - 1, y2: height - 1 },
      styles: { bg_color: "#ffffff", bg_opa: 255 },
      children,
    },
  };
}

/**
 * Scriptable stand-in for SimulatorManager. Behaviour is selected by
 * markers in the code: COMPILE_ERROR, CRASH, TIMEOUT, HUGE_TREE, SLOW.
 */
export class FakeBackend implements SimulatorBackend {
  calls: RenderRequest[] = [];
  lastSignal: AbortSignal | undefined;
  private defaults = { width: 800, height: 480 };
  private last: RenderResult | null = null;

  async render(req: RenderRequest, signal?: AbortSignal): Promise<RenderResult> {
    this.calls.push(req);
    this.lastSignal = signal;
    if (req.code.includes("SLOW")) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, 5000);
        signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new SimulatorError("cancelled", "Render cancelled by the client."));
        });
      });
    }
    if (req.code.includes("COMPILE_ERROR")) {
      throw new SimulatorError(
        "compile",
        "Compilation failed (1 error, 0 warnings):\nsnippet.c:2:1: error: implicit declaration of function 'nope'",
        { diagnostics: [{ file: "snippet.c", line: 2, col: 1, severity: "error", message: "implicit declaration of function 'nope'" }] }
      );
    }
    if (req.code.includes("CRASH")) {
      throw new SimulatorError("crash", "Simulator crashed with SIGSEGV (NULL or deleted object?) while running create_ui() (your code).");
    }
    if (req.code.includes("TIMEOUT")) {
      throw new SimulatorError("timeout", "Simulator timed out after 15 s (infinite loop?)");
    }
    const width = req.width ?? this.defaults.width;
    const height = req.height ?? this.defaults.height;
    let children: WidgetNode[] = [
      {
        type: "lv_label",
        name: "title",
        x: 10,
        y: 10,
        w: 100,
        h: 20,
        abs: { x1: 10, y1: 10, x2: 109, y2: 29 },
        text: "Hello LVGL",
        styles: { text_color: "#000000", font: "montserrat_14" },
      },
      { type: "lv_button", x: 10, y: 50, w: 80, h: 40, abs: { x1: 10, y1: 50, x2: 89, y2: 89 } },
    ];
    if (req.code.includes("HUGE_TREE")) {
      children = Array.from({ length: 3000 }, (_, i) => ({
        type: "lv_label",
        x: 0,
        y: i,
        w: 50,
        h: 10,
        abs: { x1: 0, y1: i, x2: 49, y2: i + 9 },
        text: `Label number ${i} with some text`,
        styles: { text_color: "#000000", bg_color: "#ffffff", font: "montserrat_14", pad_top: 1 },
      }));
    }
    const result: RenderResult = {
      png: TINY_PNG,
      pngWidth: width,
      pngHeight: height,
      output: makeOutput(width, height, children),
      params: {
        full: req.full,
        width,
        height,
        timeMs: req.timeMs ?? 330,
        settle: req.settle ?? false,
        rotation: req.rotation ?? 0,
        theme: req.theme ?? "light",
        dpi: req.dpi ?? 130,
        assetsDir: req.assetsDir ?? process.cwd(),
      },
      warnings: [{ file: "snippet.c", line: 3, col: 5, severity: "warning", message: "unused variable 'x' [-Wunused-variable]" }],
      logs: ["[Warn]\t(0.001, +1)\t lv_fs_open: can't open S:missing.png"],
      stdout: "hello from printf\n",
      compileMs: 1200,
      runMs: 80,
      compileCached: false,
    };
    this.last = result;
    return result;
  }

  async check(code: string): Promise<CheckResult> {
    if (code.includes("COMPILE_ERROR")) {
      return {
        success: false,
        diagnostics: [{ file: "snippet.c", line: 2, col: 1, severity: "error", message: "implicit declaration of function 'nope'" }],
        output: "snippet.c:2:1: error: implicit declaration of function 'nope'",
        hints: [],
      };
    }
    return { success: true, diagnostics: [], output: "", hints: [] };
  }

  getLastResult(): RenderResult | null {
    return this.last;
  }
  getDefaults() {
    return { ...this.defaults };
  }
  setDefaults(width: number, height: number): void {
    this.defaults = { width, height };
  }
  getConfig(): ProjectConfig {
    return {
      server_version: "test",
      lvgl_version: this.last?.output.lvgl_version ?? "unknown until first render",
      default_width: this.defaults.width,
      default_height: this.defaults.height,
      default_time_ms: 330,
      default_dpi: 130,
      color_format: "XRGB8888 (32 bpp)",
      themes: ["light", "dark"],
      rotations: [0, 90, 180, 270],
      simulator_dir: "/fake",
      build_dir: "/fake/build",
      compile_timeout_ms: 180000,
      run_timeout_ms: 15000,
      toolchain: "not checked yet",
    };
  }
}
