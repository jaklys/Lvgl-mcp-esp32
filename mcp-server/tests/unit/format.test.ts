import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findNodes,
  fitJson,
  formatTreeSummary,
  nameMatches,
  pruneNode,
  summarizeTree,
  treeForOutput,
  typeMatches,
} from "../../src/tools/format.js";
import type { SimOutput, WidgetNode } from "../../src/simulator/types.js";

function node(type: string, x1: number, y1: number, w: number, h: number, extra: Partial<WidgetNode> = {}): WidgetNode {
  return { type, x: x1, y: y1, w, h, abs: { x1, y1, x2: x1 + w - 1, y2: y1 + h - 1 }, ...extra };
}

export const sampleOutput: SimOutput = {
  format_version: 2,
  lvgl_version: "9.6.0",
  display: { width: 320, height: 240, rotation: 0, dpi: 130, color_format: "XRGB8888", theme: "light" },
  elapsed_ms: 330,
  anims_running: 0,
  logs: [],
  screen: node("lv_obj", 0, 0, 320, 240, {
    children: [
      node("lv_label", 10, 10, 100, 20, { text: "Hello", name: "title", styles: { text_color: "#000000" } }),
      node("lv_button", 10, 50, 80, 40, { name: "ok_btn", children: [node("lv_label", 20, 60, 30, 16, { text: "OK" })] }),
      node("lv_label", 400, 10, 50, 20, { text: "Far away" }),
      node("lv_label", 300, 10, 50, 20, { text: "Clipped" }),
      node("lv_obj", 0, 100, 100, 50, { hidden: true, children: [node("lv_label", 0, 100, 10, 10, { text: "inside hidden" })] }),
      node("lv_obj", 0, 160, 200, 60, {
        scroll: { x: 0, y: 0, overflow_x: false, overflow_y: true },
        children: [node("lv_label", 0, 200, 50, 100, { text: "long" })],
      }),
    ],
  }),
  layer_top: node("lv_obj", 0, 0, 320, 240, { children: [node("lv_msgbox", 60, 60, 200, 100)] }),
};

test("summarizeTree counts widgets by type including layers", () => {
  const s = summarizeTree(sampleOutput);
  assert.equal(s.widget_count, 12);
  assert.equal(s.counts_by_type["lv_label"], 6);
  assert.equal(s.counts_by_type["lv_msgbox"], 1);
  assert.deepEqual(
    s.named.map((n) => n.name),
    ["title", "ok_btn"]
  );
  assert.ok(s.texts.includes("Hello"));
});

test("summarizeTree flags hidden, off-screen, clipped and overflowing widgets", () => {
  const { issues } = summarizeTree(sampleOutput);
  assert.equal(issues.hidden.length, 1, "descendants of hidden widgets are not listed separately");
  assert.match(issues.hidden[0], /^lv_obj @ 0,100 100x50/);
  assert.equal(issues.offscreen.length, 1);
  assert.match(issues.offscreen[0], /'Far away'/);
  assert.equal(issues.clipped.length, 1);
  assert.match(issues.clipped[0], /'Clipped'/);
  assert.equal(issues.overflowing.length, 1);
  assert.match(issues.overflowing[0], /overflows vertically/);
  const text = formatTreeSummary(summarizeTree(sampleOutput));
  assert.match(text, /12 widgets: lv_label x6, lv_obj x4/);
  assert.match(text, /Named: title \(lv_label @ 10,10 100x20\)/);
  assert.match(text, /Hidden \(1\)/);
});

test("pruneNode strips styles and limits depth", () => {
  const p = pruneNode(sampleOutput.screen, { includeStyles: false, maxDepth: 0 });
  assert.equal(p.children, undefined);
  assert.equal(p["children_omitted"], 9);
  const q = pruneNode(sampleOutput.screen, { includeStyles: false });
  assert.equal(q.children?.[0].styles, undefined);
});

test("fitJson degrades gracefully to fit the budget", () => {
  const full = JSON.stringify(treeForOutput(sampleOutput, { includeStyles: true }));
  const ok = fitJson((o) => treeForOutput(sampleOutput, o), { includeStyles: true }, full.length);
  assert.equal(ok.note, undefined);
  const small = fitJson((o) => treeForOutput(sampleOutput, o), { includeStyles: true }, 300);
  assert.ok(small.text.length <= 300);
  assert.ok(small.note);
  if (small.opts) JSON.parse(small.text); // valid JSON unless hard-truncated
});

test("type and name filters", () => {
  assert.ok(typeMatches("lv_label", "label"));
  assert.ok(typeMatches("lv_label", "LV_LABEL"));
  assert.ok(!typeMatches("lv_label", "lv_button"));
  assert.ok(nameMatches("ok_btn", "ok_btn"));
  assert.ok(nameMatches("ok_btn", "*_btn"));
  assert.ok(!nameMatches(undefined, "*"));
  const m = findNodes(sampleOutput, "label");
  assert.equal(m.length, 6);
  assert.equal(m[0].path, "screen/title");
  assert.equal(findNodes(sampleOutput, undefined, "ok_*")[0].path, "screen/ok_btn");
  assert.equal(findNodes(sampleOutput, "msgbox")[0].path, "layer_top/lv_msgbox[0]");
});
