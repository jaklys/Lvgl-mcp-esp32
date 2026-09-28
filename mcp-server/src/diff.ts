/**
 * lvgl_diff: pixel diff of two PNGs and object-level diff of two widget trees.
 */
import { PNG } from "pngjs";
import type { SimOutput, WidgetNode } from "./simulator/types.js";

export interface Rgba {
  width: number;
  height: number;
  data: Buffer;
}

export function decodePng(buf: Buffer): Rgba {
  const png = PNG.sync.read(buf);
  return { width: png.width, height: png.height, data: png.data };
}

export function encodePng(img: Rgba): Buffer {
  const png = new PNG({ width: img.width, height: img.height });
  img.data.copy(png.data);
  return PNG.sync.write(png);
}

export interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface PixelDiff {
  width: number;
  height: number;
  changed: number;
  total: number;
  percent: number;
  /** Bounding box of the changed pixels (inclusive), null when nothing changed. */
  bbox: Box | null;
  /** Set when the images have different sizes (pixels outside one image count as changed). */
  sizeMismatch?: { a: { width: number; height: number }; b: { width: number; height: number } };
  /** Diff image: `b` dimmed to 50 %, changed pixels magenta. */
  png: Buffer;
}

/**
 * Compare two PNGs pixel by pixel. A pixel counts as changed when any
 * channel (RGBA) differs by more than `threshold` (0..255).
 */
export function pixelDiff(aPng: Buffer, bPng: Buffer, threshold = 0): PixelDiff {
  const a = decodePng(aPng);
  const b = decodePng(bPng);
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  const out = Buffer.alloc(width * height * 4);
  let changed = 0;
  let bbox: Box | null = null;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inA = x < a.width && y < a.height;
      const inB = x < b.width && y < b.height;
      const ia = (y * a.width + x) * 4;
      const ib = (y * b.width + x) * 4;
      let diff = !inA || !inB;
      if (!diff) {
        for (let c = 0; c < 4; c++) {
          if (Math.abs(a.data[ia + c]! - b.data[ib + c]!) > threshold) {
            diff = true;
            break;
          }
        }
      }
      const o = (y * width + x) * 4;
      if (diff) {
        changed++;
        out[o] = 255;
        out[o + 1] = 0;
        out[o + 2] = 255;
        out[o + 3] = 255;
        if (!bbox) bbox = { x1: x, y1: y, x2: x, y2: y };
        else {
          if (x < bbox.x1) bbox.x1 = x;
          if (x > bbox.x2) bbox.x2 = x;
          if (y < bbox.y1) bbox.y1 = y;
          if (y > bbox.y2) bbox.y2 = y;
        }
      } else {
        const src = inB ? b.data : a.data;
        const i = inB ? ib : ia;
        out[o] = src[i]! >> 1;
        out[o + 1] = src[i + 1]! >> 1;
        out[o + 2] = src[i + 2]! >> 1;
        out[o + 3] = 255;
      }
    }
  }
  const total = width * height;
  const result: PixelDiff = {
    width,
    height,
    changed,
    total,
    percent: total ? Math.round((changed / total) * 10000) / 100 : 0,
    bbox,
    png: encodePng({ width, height, data: out }),
  };
  if (a.width !== b.width || a.height !== b.height) {
    result.sizeMismatch = { a: { width: a.width, height: a.height }, b: { width: b.width, height: b.height } };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Object diff
// ---------------------------------------------------------------------------

export interface FlatNode {
  /** Match key: the object name when unique, else the structural path. */
  key: string;
  /** Structural path, e.g. "screen/lv_obj#0/lv_label#1" (index among same-type siblings). */
  path: string;
  node: WidgetNode;
  rect: Box | null;
}

function rectOf(n: WidgetNode): Box | null {
  if (n.abs) return { ...n.abs };
  return null;
}

/** Flatten the screen and layers into match keys. */
export function flattenTree(out: SimOutput): Map<string, FlatNode> {
  const all: FlatNode[] = [];
  const walk = (n: WidgetNode, p: string) => {
    all.push({ key: p, path: p, node: n, rect: rectOf(n) });
    const seen: Record<string, number> = {};
    for (const c of n.children ?? []) {
      const i = seen[c.type] ?? 0;
      seen[c.type] = i + 1;
      walk(c, `${p}/${c.type}#${i}`);
    }
  };
  walk(out.screen, "screen");
  if (out.layer_top) walk(out.layer_top, "layer_top");
  if (out.layer_sys) walk(out.layer_sys, "layer_sys");
  const nameCount: Record<string, number> = {};
  for (const f of all) if (f.node.name) nameCount[f.node.name] = (nameCount[f.node.name] ?? 0) + 1;
  const map = new Map<string, FlatNode>();
  for (const f of all) {
    const name = f.node.name;
    const key = name && nameCount[name] === 1 && !["screen", "layer_top", "layer_sys"].includes(f.path) ? name : f.path;
    map.set(key, { ...f, key });
  }
  return map;
}

export interface StyleChange {
  part: string;
  key: string;
  from: unknown;
  to: unknown;
}

export interface ObjectDiff {
  added: Array<{ key: string; type: string; rect: Box | null; text?: string }>;
  removed: Array<{ key: string; type: string; rect: Box | null; text?: string }>;
  moved: Array<{ key: string; type: string; from: Box; to: Box }>;
  resized: Array<{ key: string; type: string; from: { w: number; h: number }; to: { w: number; h: number } }>;
  text: Array<{ key: string; type: string; from: string | undefined; to: string | undefined }>;
  styles: Array<{ key: string; type: string; changes: StyleChange[] }>;
  /** Other property changes: states, hidden/visible, value, checked, flags ... */
  other: Array<{ key: string; type: string; prop: string; from: unknown; to: unknown }>;
  unchanged: number;
}

const STYLE_PARTS = ["styles", "indicator", "knob"];
const IGNORED = new Set(["type", "name", "x", "y", "w", "h", "abs", "children", "text", "scroll", ...STYLE_PARTS]);

function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function size(r: Box): { w: number; h: number } {
  return { w: r.x2 - r.x1 + 1, h: r.y2 - r.y1 + 1 };
}

/** Object-level diff of the final states of two renders (captures other than the final one are ignored). */
export function objectDiff(a: SimOutput, b: SimOutput): ObjectDiff {
  const ma = flattenTree(a);
  const mb = flattenTree(b);
  const d: ObjectDiff = { added: [], removed: [], moved: [], resized: [], text: [], styles: [], other: [], unchanged: 0 };
  for (const [key, fa] of ma) {
    const fb = mb.get(key);
    if (!fb) {
      d.removed.push({ key, type: fa.node.type, rect: fa.rect, ...(fa.node.text !== undefined ? { text: fa.node.text } : {}) });
      continue;
    }
    let changed = false;
    const type = fb.node.type;
    if (fa.rect && fb.rect) {
      if (fa.rect.x1 !== fb.rect.x1 || fa.rect.y1 !== fb.rect.y1) {
        d.moved.push({ key, type, from: fa.rect, to: fb.rect });
        changed = true;
      }
      const sa = size(fa.rect);
      const sb = size(fb.rect);
      if (sa.w !== sb.w || sa.h !== sb.h) {
        d.resized.push({ key, type, from: sa, to: sb });
        changed = true;
      }
    } else if (fa.node.w !== fb.node.w || fa.node.h !== fb.node.h) {
      d.resized.push({ key, type, from: { w: fa.node.w, h: fa.node.h }, to: { w: fb.node.w, h: fb.node.h } });
      changed = true;
    }
    if (fa.node.text !== fb.node.text) {
      d.text.push({ key, type, from: fa.node.text, to: fb.node.text });
      changed = true;
    }
    const styleChanges: StyleChange[] = [];
    for (const part of STYLE_PARTS) {
      const pa = (fa.node[part] ?? {}) as Record<string, unknown>;
      const pb = (fb.node[part] ?? {}) as Record<string, unknown>;
      for (const k of new Set([...Object.keys(pa), ...Object.keys(pb)])) {
        if (!eq(pa[k], pb[k])) styleChanges.push({ part: part === "styles" ? "main" : part, key: k, from: pa[k], to: pb[k] });
      }
    }
    if (styleChanges.length) {
      d.styles.push({ key, type, changes: styleChanges });
      changed = true;
    }
    for (const k of new Set([...Object.keys(fa.node), ...Object.keys(fb.node)])) {
      if (IGNORED.has(k)) continue;
      if (!eq(fa.node[k], fb.node[k])) {
        d.other.push({ key, type, prop: k, from: fa.node[k], to: fb.node[k] });
        changed = true;
      }
    }
    if (!changed) d.unchanged++;
  }
  for (const [key, fb] of mb) {
    if (!ma.has(key)) d.added.push({ key, type: fb.node.type, rect: fb.rect, ...(fb.node.text !== undefined ? { text: fb.node.text } : {}) });
  }
  return d;
}

function fmtRect(r: Box | null): string {
  if (!r) return "?";
  const s = size(r);
  return `${r.x1},${r.y1} ${s.w}x${s.h}`;
}

function fmtVal(v: unknown): string {
  if (v === undefined) return "(unset)";
  const s = typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v);
  return s.length > 60 ? s.slice(0, 57) + "..." : s;
}

/** Human-readable diff text, at most `maxLines` change lines. */
export function formatObjectDiff(d: ObjectDiff, maxLines = 120): string {
  const counts = `${d.added.length} added, ${d.removed.length} removed, ${d.moved.length} moved, ${d.resized.length} resized, ${d.text.length} text changed, ${d.styles.length} with style changes, ${d.other.length} other property changes, ${d.unchanged} unchanged`;
  const lines: string[] = [];
  const label = (key: string, type: string) => (key.includes("/") ? `${type} ${key}` : `"${key}" (${type})`);
  for (const x of d.added) lines.push(`+ added ${label(x.key, x.type)} @ ${fmtRect(x.rect)}${x.text !== undefined ? ` text ${fmtVal(x.text)}` : ""}`);
  for (const x of d.removed) lines.push(`- removed ${label(x.key, x.type)} (was @ ${fmtRect(x.rect)})`);
  for (const x of d.moved) lines.push(`~ moved ${label(x.key, x.type)}: ${fmtRect(x.from)} -> ${fmtRect(x.to)}`);
  for (const x of d.resized) lines.push(`~ resized ${label(x.key, x.type)}: ${x.from.w}x${x.from.h} -> ${x.to.w}x${x.to.h}`);
  for (const x of d.text) lines.push(`~ text ${label(x.key, x.type)}: ${fmtVal(x.from)} -> ${fmtVal(x.to)}`);
  for (const x of d.styles) {
    lines.push(`~ style ${label(x.key, x.type)}: ${x.changes.map((c) => `${c.part === "main" ? "" : c.part + "."}${c.key} ${fmtVal(c.from)} -> ${fmtVal(c.to)}`).join("; ")}`);
  }
  for (const x of d.other) lines.push(`~ ${x.prop} ${label(x.key, x.type)}: ${fmtVal(x.from)} -> ${fmtVal(x.to)}`);
  const shown = lines.slice(0, maxLines);
  if (lines.length > maxLines) shown.push(`... ${lines.length - maxLines} more (structuredContent.objects has all)`);
  return `Object diff (matched by name, else by tree path): ${counts}${shown.length ? "\n" + shown.join("\n") : ""}`;
}
