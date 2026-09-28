import { encodePng } from "../../src/diff.js";
import { SimulatorError } from "../../src/simulator/errors.js";
import type {
  CaptureImage,
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

/** Solid-colour PNG (for diff tests). */
export function solidPng(width: number, height: number, rgb: [number, number, number], rect?: { x: number; y: number; w: number; h: number; rgb: [number, number, number] }): Buffer {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inRect = rect && x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
      const c = inRect ? rect!.rgb : rgb;
      const i = (y * width + x) * 4;
      data[i] = c[0];
      data[i + 1] = c[1];
      data[i + 2] = c[2];
      data[i + 3] = 255;
    }
  }
  return encodePng({ width, height, data });
}

/**
 * Scriptable stand-in for SimulatorManager. Behaviour is selected by
 * markers in the code: COMPILE_ERROR, CRASH, TIMEOUT, HUGE_TREE, SLOW,
 * MOVED (button at another position), DIAG (v3 diagnostics); a JSON UI with
 * name "BAD" fails like exit 5, a click on name "missing" like exit 6.
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
    req.code = req.code ?? "";
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
    if (req.code.includes("MOVED")) {
      children[1] = { ...children[1]!, x: 110, abs: { x1: 110, y1: 50, x2: 189, y2: 89 }, name: "ok_btn" };
    } else {
      children[1] = { ...children[1]!, name: "ok_btn" };
    }
    if (req.mode === "ui" && req.ui?.["name"] === "BAD") {
      throw new SimulatorError("ui", "The JSON UI document was rejected (1 problem):\nui: children[0].type: unknown widget \"lv_meter\"");
    }
    if (req.actions?.some((a) => JSON.stringify(a).includes('"missing"'))) {
      throw new SimulatorError("action", 'Action script error:\nobject "missing" not found; known names: title, ok_btn');
    }
    const output = makeOutput(width, height, children);
    if (req.code.includes("DIAG") || req.mode === "ui" || req.actions || req.frames || req.annotate || req.board || req.fonts || req.memBudgetKb) {
      output.format_version = 3;
      output.diagnostics = req.code.includes("DIAG")
        ? [
            { code: "LABEL_CLIPPED", severity: "warn", name: "title", path: "lv_label#0", abs: { x1: 10, y1: 10, x2: 109, y2: 29 }, message: "label text 'Hello LVGL' needs 112 px, has 100 px (long_mode clip)" },
            { code: "MISSING_GLYPH", severity: "error", name: "title", path: "lv_label#0", message: "char U+010D not in font montserrat_14" },
            { code: "OVERLAP", severity: "info", path: "lv_button#0", message: "overlaps lv_label#0 by 10x10 px" },
          ]
        : [];
      output.mem = { peak_bytes: 72704, used_bytes: 60000, frag_pct: 3, ...(req.memBudgetKb ? { budget_bytes: req.memBudgetKb * 1024, over_budget: 72704 > req.memBudgetKb * 1024 } : {}) };
      output.fonts_used = ["montserrat_14"];
      if (req.actions) {
        output.events = [{ t_ms: 93, name: "ok_btn", event: "clicked" }];
        output.input = { pointer: true, keypad: true, focused: null };
      }
    }
    const png = solidPng(4, 3, [255, 255, 255], req.code.includes("MOVED") ? { x: 2, y: 0, w: 1, h: 1, rgb: [0, 0, 255] } : undefined);
    const labels: string[] = [];
    for (const a of req.actions ?? []) if (typeof a["capture"] === "string") labels.push(a["capture"] as string);
    for (const f of req.frames ?? []) labels.push(`t${f}`);
    labels.push("final");
    const captures: CaptureImage[] = labels.map((label, i) => ({
      n: i + 1,
      label,
      elapsedMs: 330 + i * 100,
      png,
      ...(req.annotate ? { annotated: png } : {}),
      screen: output.screen,
    }));
    if (captures.length > 1 || req.annotate) {
      output.captures = captures.map((c) => ({ n: c.n, label: c.label, elapsed_ms: c.elapsedMs, png: `capture-${c.n}-${c.label}.png`, screen: c.screen }));
    }
    const result: RenderResult = {
      png,
      pngWidth: width,
      pngHeight: height,
      captures,
      output,
      params: {
        full: req.full,
        mode: req.mode ?? (req.full ? "full" : "snippet"),
        width,
        height,
        timeMs: req.timeMs ?? 330,
        settle: req.settle ?? false,
        rotation: req.rotation ?? 0,
        theme: req.theme ?? "light",
        dpi: req.dpi ?? 130,
        assetsDir: req.assetsDir ?? process.cwd(),
        board: req.board,
        colorFormat: req.colorFormat,
        scale: req.scale,
        fonts: req.fonts,
        memBudgetKb: req.memBudgetKb,
        annotate: req.annotate ?? false,
        frames: req.frames,
        actions: req.actions,
        espShims: req.espShims ?? false,
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
