import { formatDiagnostic } from "../simulator/diagnostics.js";
import type { CaptureImage, RenderResult, SimOutput, UiDiagnostic, WidgetNode } from "../simulator/types.js";

/** Soft cap for the text returned by a render (images are separate). */
export const RENDER_TEXT_BUDGET = 24_000;
/** Soft cap for lvgl_inspect output. */
export const INSPECT_TEXT_BUDGET = 60_000;

export type IncludeTree = "summary" | "full" | "none";

export interface TreeIssues {
  hidden: string[];
  offscreen: string[];
  clipped: string[];
  overflowing: string[];
}

export interface TreeSummary {
  widget_count: number;
  counts_by_type: Record<string, number>;
  named: Array<{ name: string; type: string; x: number; y: number; w: number; h: number }>;
  texts: string[];
  issues: TreeIssues;
}

/** Iterate the screen and the non-empty layers. */
export function roots(out: SimOutput): Array<[string, WidgetNode]> {
  const r: Array<[string, WidgetNode]> = [["screen", out.screen]];
  if (out.layer_top) r.push(["layer_top", out.layer_top]);
  if (out.layer_sys) r.push(["layer_sys", out.layer_sys]);
  return r;
}

function shortText(s: string, max = 40): string {
  const one = s.replace(/\s*\n\s*/g, " / ");
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

function box(n: WidgetNode): { x: number; y: number; w: number; h: number } {
  if (n.abs) return { x: n.abs.x1, y: n.abs.y1, w: n.abs.x2 - n.abs.x1 + 1, h: n.abs.y2 - n.abs.y1 + 1 };
  return { x: n.x, y: n.y, w: n.w, h: n.h };
}

/** Human-readable identification of a widget: `lv_button "ok_btn" 'OK' @ 10,20 120x40`. */
export function describeNode(n: WidgetNode): string {
  const b = box(n);
  let s = n.type;
  if (n.name) s += ` "${n.name}"`;
  if (typeof n.text === "string" && n.text) s += ` '${shortText(n.text, 30)}'`;
  return `${s} @ ${b.x},${b.y} ${b.w}x${b.h}`;
}

/** Counts, names, texts and layout problems of a widget tree. */
export function summarizeTree(out: SimOutput): TreeSummary {
  const dispW = out.display?.width ?? 0;
  const dispH = out.display?.height ?? 0;
  const counts: Record<string, number> = {};
  const named: TreeSummary["named"] = [];
  const texts: string[] = [];
  const issues: TreeIssues = { hidden: [], offscreen: [], clipped: [], overflowing: [] };
  let total = 0;

  const walk = (n: WidgetNode, isRoot: boolean, underHidden: boolean, underScroll: boolean): void => {
    total++;
    counts[n.type] = (counts[n.type] ?? 0) + 1;
    const b = box(n);
    if (n.name) named.push({ name: n.name, type: n.type, ...b });
    if (typeof n.text === "string" && n.text && texts.length < 60) texts.push(shortText(n.text));

    const hidden = n.hidden === true;
    if (!isRoot && !underHidden) {
      if (hidden) issues.hidden.push(describeNode(n));
      else if (n.abs && dispW > 0 && !underScroll) {
        const { x1, y1, x2, y2 } = n.abs;
        const outside = x2 < 0 || y2 < 0 || x1 >= dispW || y1 >= dispH;
        if (outside) issues.offscreen.push(describeNode(n));
        else if (x1 < 0 || y1 < 0 || x2 >= dispW || y2 >= dispH) issues.clipped.push(describeNode(n));
        else if (n.visible === false) issues.offscreen.push(describeNode(n) + " (clipped by its parent)");
      } else if (n.visible === false && !underScroll) {
        issues.offscreen.push(describeNode(n) + " (not visible)");
      }
    }
    const scroll = n.scroll;
    const overflows = !!(scroll && (scroll.overflow_x || scroll.overflow_y));
    if (overflows && !underHidden && !hidden) {
      const dir = [scroll?.overflow_x ? "horizontally" : "", scroll?.overflow_y ? "vertically" : ""].filter(Boolean).join(" and ");
      issues.overflowing.push(`${describeNode(n)}: content overflows ${dir} (scrollable)`);
    }
    for (const c of n.children ?? []) walk(c, false, underHidden || hidden, underScroll || !!scroll);
  };
  for (const [, r] of roots(out)) walk(r, true, false, false);

  const sorted = Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
  return { widget_count: total, counts_by_type: sorted, named, texts, issues };
}

function listBlock(title: string, items: string[], max = 20): string[] {
  if (items.length === 0) return [];
  const lines = [`- ${title} (${items.length}):`];
  for (const i of items.slice(0, max)) lines.push(`    ${i}`);
  if (items.length > max) lines.push(`    ... ${items.length - max} more`);
  return lines;
}

export function formatTreeSummary(s: TreeSummary): string {
  const lines = ["Widget tree summary (include_tree=\"full\" or lvgl_inspect for the complete tree):"];
  const counts = Object.entries(s.counts_by_type)
    .map(([t, c]) => `${t} x${c}`)
    .join(", ");
  lines.push(`- ${s.widget_count} widgets: ${counts}`);
  if (s.named.length) {
    lines.push(
      `- Named: ${s.named
        .slice(0, 40)
        .map((n) => `${n.name} (${n.type} @ ${n.x},${n.y} ${n.w}x${n.h})`)
        .join(", ")}${s.named.length > 40 ? ", ..." : ""}`
    );
  }
  if (s.texts.length) lines.push(`- Texts: ${s.texts.map((t) => JSON.stringify(t)).join(", ")}`);
  const { hidden, offscreen, clipped, overflowing } = s.issues;
  lines.push(...listBlock("Hidden", hidden));
  lines.push(...listBlock("Off-screen / not visible", offscreen));
  lines.push(...listBlock("Partially off-screen", clipped));
  lines.push(...listBlock("Overflowing content", overflowing));
  if (!hidden.length && !offscreen.length && !clipped.length && !overflowing.length) {
    lines.push("- No hidden, off-screen or overflowing widgets.");
  }
  return lines.join("\n");
}

export interface PruneOptions {
  maxDepth?: number;
  includeStyles?: boolean;
}

/** Copy of a node with styles removed and/or depth limited. */
export function pruneNode(n: WidgetNode, opts: PruneOptions, depth = 0): WidgetNode {
  const copy: WidgetNode = { ...n };
  if (opts.includeStyles === false) {
    delete copy.styles;
    delete copy.indicator;
    delete copy.knob;
  }
  if (n.children?.length) {
    if (opts.maxDepth !== undefined && depth >= opts.maxDepth) {
      delete copy.children;
      copy.children_omitted = countNodes(n) - 1;
    } else {
      copy.children = n.children.map((c) => pruneNode(c, opts, depth + 1));
    }
  }
  return copy;
}

export function countNodes(n: WidgetNode): number {
  return 1 + (n.children ?? []).reduce((s, c) => s + countNodes(c), 0);
}

/**
 * Serialize `value(opts)` as compact JSON within `budget` characters:
 * first as requested, then without styles, then with decreasing depth,
 * finally hard-truncated. Returns the text and a note about what was cut.
 */
export function fitJson(
  build: (opts: PruneOptions) => unknown,
  requested: PruneOptions,
  budget: number
): { text: string; note?: string; opts?: PruneOptions } {
  const attempt = (o: PruneOptions) => JSON.stringify(build(o));
  let text = attempt(requested);
  if (text.length <= budget) return { text, opts: requested };
  const noStyles: PruneOptions = { ...requested, includeStyles: false };
  if (requested.includeStyles !== false) {
    text = attempt(noStyles);
    if (text.length <= budget) return { text, note: "styles omitted to fit the size limit", opts: noStyles };
  }
  const start = Math.min(requested.maxDepth ?? 16, 16);
  for (let d = start; d >= 1; d--) {
    text = attempt({ ...noStyles, maxDepth: d });
    if (text.length <= budget) {
      return {
        text,
        note: `styles omitted and tree cut at depth ${d} to fit the size limit ("children_omitted" counts hidden descendants)`,
        opts: { ...noStyles, maxDepth: d },
      };
    }
  }
  return {
    text: text.slice(0, budget),
    note: `output hard-truncated at ${budget} characters`,
  };
}

function kb(bytes: number): string {
  return bytes >= 10 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024).toFixed(1)} KB`;
}

/** Images in content order: plain capture, then its annotated version. */
export function imageList(r: RenderResult): Array<{ capture: CaptureImage; annotated: boolean; data: Buffer }> {
  const caps = r.captures?.length ? r.captures : [{ n: 1, label: "final", elapsedMs: r.output.elapsed_ms, png: r.png }];
  const out: Array<{ capture: CaptureImage; annotated: boolean; data: Buffer }> = [];
  for (const c of caps) {
    out.push({ capture: c, annotated: false, data: c.png });
    if (c.annotated) out.push({ capture: c, annotated: true, data: c.annotated });
  }
  return out;
}

const SEVERITY_ORDER: Array<[UiDiagnostic["severity"], string]> = [
  ["error", "Errors"],
  ["warn", "Warnings"],
  ["info", "Info"],
];

/** UI diagnostics grouped by severity; `max` lines in total. */
export function formatUiDiagnostics(diags: UiDiagnostic[] | undefined, max = 60): string | null {
  if (diags === undefined) return null;
  if (diags.length === 0) {
    return "UI diagnostics: none (checked: clipped/overflowing text, missing glyphs, off-screen and outside-parent objects, overlaps, contrast, touch-target size, zero size, device fonts, LVGL heap budget).";
  }
  // Accept "warning" as an alias of "warn" (robust against the binary's spelling).
  const sevOf = (d: UiDiagnostic): string => (String(d.severity) === "warning" ? "warn" : String(d.severity));
  const count = (sev: string) => diags.filter((d) => sevOf(d) === sev).length;
  const lines = [`UI diagnostics (${count("error")} error(s), ${count("warn")} warning(s), ${count("info")} info):`];
  let shown = 0;
  for (const [sev, title] of SEVERITY_ORDER) {
    const group = diags.filter((d) => sevOf(d) === sev);
    if (!group.length) continue;
    lines.push(`${title}:`);
    for (const d of group) {
      if (shown >= max) break;
      shown++;
      const who = [d.name ? `"${d.name}"` : "", d.path ?? ""].filter(Boolean).join(" ");
      const at = d.abs ? ` @ ${d.abs.x1},${d.abs.y1} ${d.abs.x2 - d.abs.x1 + 1}x${d.abs.y2 - d.abs.y1 + 1}` : "";
      lines.push(`  - ${d.code}${who ? ` ${who}` : ""}${at}: ${d.message}`);
    }
  }
  const others = diags.filter((d) => !["error", "warn", "info"].includes(sevOf(d)));
  for (const d of others.slice(0, Math.max(0, max - shown))) lines.push(`  - ${d.code} (${d.severity}): ${d.message}`);
  if (diags.length > max) lines.push(`  ... ${diags.length - max} more (structuredContent.diagnostics has all)`);
  return lines.join("\n");
}

/** "LVGL heap peak 71 KB / budget 64 KB (OVER BUDGET)". */
export function formatMem(out: SimOutput): string | null {
  const m = out.mem;
  if (!m) return null;
  let s = `LVGL heap peak ${kb(m.peak_bytes)}`;
  if (m.budget_bytes) {
    s += ` / budget ${kb(m.budget_bytes)}`;
    const over = m.over_budget ?? m.peak_bytes > m.budget_bytes;
    s += over ? " - OVER BUDGET: the UI would not fit in the device's LV_MEM_SIZE" : ` (${Math.round((m.peak_bytes / m.budget_bytes) * 100)} %)`;
  } else {
    s += " (no budget set: pass mem_budget_kb or a board to check it against the device's LV_MEM_SIZE)";
  }
  const extra = [
    m.used_bytes !== undefined ? `in use at the end ${kb(m.used_bytes)}` : "",
    m.frag_pct !== undefined ? `fragmentation ${m.frag_pct} %` : "",
  ].filter(Boolean);
  if (extra.length) s += `; ${extra.join(", ")}`;
  return s;
}

/** Everything the render tools put into their text content. */
export function formatRenderText(
  r: RenderResult,
  include: IncludeTree,
  summary: TreeSummary,
  renderId?: string
): { text: string; treeOpts?: PruneOptions } {
  const out = r.output;
  const p = r.params;
  const parts: string[] = [];
  const cached = r.compileCached ? ", cached" : "";
  const extras = [
    p.board ? `board ${p.board}` : "",
    p.colorFormat ? p.colorFormat.toUpperCase() : "",
    p.scale && p.scale > 1 ? `scale ${p.scale}x` : "",
  ].filter(Boolean);
  const modeText = { snippet: "snippet", full: "full-file", ui: "JSON UI", project: "project" }[p.mode ?? (p.full ? "full" : "snippet")];
  const build = p.mode === "ui" ? (r.binary === "prebuilt" ? "prebuilt binary, no compile" : `build ${(r.compileMs / 1000).toFixed(1)} s${cached}`) : `compile ${(r.compileMs / 1000).toFixed(1)} s${cached}`;
  parts.push(
    `Rendered ${r.pngWidth}x${r.pngHeight} px${renderId ? ` · render_id ${renderId}` : ""} (${p.width}x${p.height}, rotation ${p.rotation}, theme ${p.theme}, ${modeText} mode${extras.length ? ", " + extras.join(", ") : ""}) · LVGL ${out.lvgl_version} · ${out.elapsed_ms} ms simulated · ${summary.widget_count} widgets · ${out.anims_running} animations running · ${build}, run ${(r.runMs / 1000).toFixed(1)} s`
  );

  const images = imageList(r);
  if (images.length > 1) {
    const list = images.map((img, i) => `#${i + 1} ${img.capture.label}${img.annotated ? " (annotated)" : ""} @ ${img.capture.elapsedMs} ms`);
    parts.push(`Images in order (${images.length}): ${list.join(", ")}. The last capture is the final state.`);
  }
  const caps = r.captures ?? [];
  if (caps.length > 1) {
    const perCap = caps.map((c) => {
      const n = c.screen ? countNodes(c.screen) + (c.layerTop ? countNodes(c.layerTop) : 0) : undefined;
      return `${c.n} "${c.label}" @ ${c.elapsedMs} ms${n !== undefined ? `: ${n} widgets` : ""}`;
    });
    parts.push(
      `Captures: ${perCap.join("; ")}. Diagnostics and the tree below describe the final state only (per-capture trees are trimmed from this text).`
    );
  }
  if (out.anims_running > 0 && !p.settle) {
    parts.push("Note: animations were still running at capture time; pass settle=true or a larger time_ms (or frames) to see the final state.");
  }
  if (out.format_version !== 2 && out.format_version !== 3) {
    parts.push(`Note: simulator JSON format_version ${out.format_version} (expected 3); some fields may be missing.`);
  }
  for (const n of r.notes ?? []) parts.push(`Note: ${n}`);

  const diag = formatUiDiagnostics(out.diagnostics);
  if (diag) parts.push(diag);
  const mem = formatMem(out);
  if (mem) parts.push(mem);
  if (out.fonts_used?.length) {
    parts.push(`Fonts used: ${out.fonts_used.join(", ")}${p.fonts?.length ? ` (device fonts: ${p.fonts.join(", ")})` : ""}`);
  }
  if (p.actions?.length || p.frames?.length || out.events?.length) {
    const ev = out.events ?? [];
    const lines = ev.slice(0, 60).map((e) => `  t=${e.t_ms} ms ${e.name ?? e.path ?? "?"} ${e.event}`);
    if (ev.length > 60) lines.push(`  ... ${ev.length - 60} more`);
    const focused = out.input?.focused;
    parts.push(
      `Events (${ev.length})${ev.length ? ":\n" + lines.join("\n") : ": none fired"}` +
        (focused !== undefined ? `\nFocused object: ${focused ?? "none"}` : "")
    );
  }
  if (r.warnings.length) {
    parts.push(`Compiler warnings (${r.warnings.length}):\n` + r.warnings.slice(0, 30).map(formatDiagnostic).join("\n"));
  }
  const important = r.logs.filter((l) => /^\[(Warn|Error|User)\]/.test(l) || l.startsWith("..."));
  if (important.length) {
    const shown = important.slice(-40);
    parts.push(`LVGL log (${important.length} line${important.length === 1 ? "" : "s"}${shown.length < important.length ? `, last ${shown.length}` : ""}):\n` + shown.join("\n"));
  }
  const stdout = r.stdout.trim();
  if (stdout) {
    parts.push(`printf output:\n${stdout.length > 3000 ? stdout.slice(0, 3000) + "\n... (truncated)" : stdout}`);
  }

  let text = parts.join("\n\n");
  if (include === "summary") {
    const remaining = RENDER_TEXT_BUDGET - text.length - 100;
    let tree = formatTreeSummary(summary);
    if (tree.length > remaining) tree = tree.slice(0, Math.max(500, remaining)) + "\n... (summary truncated; use lvgl_inspect)";
    text += "\n\n" + tree;
  }
  let treeOpts: PruneOptions | undefined;
  if (include === "full") {
    const remaining = Math.max(2000, RENDER_TEXT_BUDGET - text.length - 200);
    const fitted = fitJson((o) => treeForOutput(out, o), { includeStyles: true }, remaining);
    text +=
      "\n\nWidget tree (compact JSON):\n" +
      fitted.text +
      (fitted.note ? `\n[Note: ${fitted.note}; use lvgl_inspect with type/name/max_depth filters for the rest]` : "");
    treeOpts = fitted.opts;
  }
  return { text, treeOpts };
}

/** The screen + layers as one JSON value. */
export function treeForOutput(out: SimOutput, opts: PruneOptions): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (const [k, n] of roots(out)) obj[k] = pruneNode(n, opts);
  return obj;
}

/** Match a widget type filter: "label", "lv_label" and "LV_LABEL" all match lv_label. */
export function typeMatches(nodeType: string, filter: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/^lv_/, "");
  return norm(nodeType) === norm(filter);
}

/** Exact name match, or glob with `*`. */
export function nameMatches(name: string | undefined, filter: string): boolean {
  if (name === undefined) return false;
  if (!filter.includes("*")) return name === filter;
  const re = new RegExp("^" + filter.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
  return re.test(name);
}

export interface Match {
  path: string;
  node: WidgetNode;
}

/** Find nodes matching type and/or name filters; path uses `type[index]` segments. */
export function findNodes(out: SimOutput, type?: string, name?: string): Match[] {
  const matches: Match[] = [];
  const walk = (n: WidgetNode, p: string) => {
    const ok = (!type || typeMatches(n.type, type)) && (!name || nameMatches(n.name, name));
    if (ok) matches.push({ path: p, node: n });
    (n.children ?? []).forEach((c, i) => walk(c, `${p}/${c.name ?? `${c.type}[${i}]`}`));
  };
  for (const [k, r] of roots(out)) walk(r, k);
  return matches;
}
