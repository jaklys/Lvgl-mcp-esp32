import { formatDiagnostic } from "../simulator/diagnostics.js";
import type { RenderResult, SimOutput, WidgetNode } from "../simulator/types.js";

/** Soft cap for the text returned by a render (images are separate). */
export const RENDER_TEXT_BUDGET = 20_000;
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

/** Everything the render tools put into their text content. */
export function formatRenderText(
  r: RenderResult,
  include: IncludeTree,
  summary: TreeSummary
): { text: string; treeOpts?: PruneOptions } {
  const out = r.output;
  const parts: string[] = [];
  const cached = r.compileCached ? ", cached" : "";
  parts.push(
    `Rendered ${r.pngWidth}x${r.pngHeight} px (${r.params.width}x${r.params.height}, rotation ${r.params.rotation}, theme ${r.params.theme}, ${r.params.full ? "full-file" : "snippet"} mode) · LVGL ${out.lvgl_version} · ${out.elapsed_ms} ms simulated · ${summary.widget_count} widgets · ${out.anims_running} animations running · compile ${(r.compileMs / 1000).toFixed(1)} s${cached}, run ${(r.runMs / 1000).toFixed(1)} s`
  );
  if (out.anims_running > 0 && !r.params.settle) {
    parts.push("Note: animations were still running at capture time; pass settle=true or a larger time_ms to see the final state.");
  }
  if (out.format_version !== 2) {
    parts.push(`Note: simulator JSON format_version ${out.format_version} (expected 2); some fields may be missing.`);
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

  if (include === "summary") parts.push(formatTreeSummary(summary));
  let text = parts.join("\n\n");
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
