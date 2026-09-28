import { test } from "node:test";
import assert from "node:assert/strict";
import { decodePng, flattenTree, formatObjectDiff, objectDiff, pixelDiff } from "../../src/diff.js";
import { RenderHistory } from "../../src/history.js";
import type { SimOutput, WidgetNode } from "../../src/simulator/types.js";
import { solidPng } from "../helpers/fake-backend.js";

function node(type: string, x: number, y: number, w: number, h: number, extra: Partial<WidgetNode> = {}): WidgetNode {
  return { type, x, y, w, h, abs: { x1: x, y1: y, x2: x + w - 1, y2: y + h - 1 }, ...extra };
}

function out(children: WidgetNode[], layerTop?: WidgetNode): SimOutput {
  return {
    format_version: 3,
    lvgl_version: "9.6.0",
    display: { width: 320, height: 240 },
    elapsed_ms: 330,
    anims_running: 0,
    logs: [],
    screen: node("lv_obj", 0, 0, 320, 240, { children }),
    ...(layerTop ? { layer_top: layerTop } : {}),
  };
}

test("pixelDiff: identical images", () => {
  const a = solidPng(8, 6, [255, 255, 255]);
  const d = pixelDiff(a, a);
  assert.equal(d.changed, 0);
  assert.equal(d.total, 48);
  assert.equal(d.percent, 0);
  assert.equal(d.bbox, null);
  const img = decodePng(d.png);
  assert.deepEqual([img.width, img.height], [8, 6]);
  assert.deepEqual([...img.data.subarray(0, 4)], [127, 127, 127, 255], "unchanged pixels are dimmed 50%");
});

test("pixelDiff: changed rectangle -> count, percentage, bbox and magenta pixels", () => {
  const a = solidPng(10, 10, [255, 255, 255]);
  const b = solidPng(10, 10, [255, 255, 255], { x: 2, y: 3, w: 4, h: 2, rgb: [0, 0, 0] });
  const d = pixelDiff(a, b);
  assert.equal(d.changed, 8);
  assert.equal(d.percent, 8);
  assert.deepEqual(d.bbox, { x1: 2, y1: 3, x2: 5, y2: 4 });
  const img = decodePng(d.png);
  const px = (x: number, y: number) => [...img.data.subarray((y * 10 + x) * 4, (y * 10 + x) * 4 + 4)];
  assert.deepEqual(px(2, 3), [255, 0, 255, 255]);
  assert.deepEqual(px(0, 0), [127, 127, 127, 255]);
});

test("pixelDiff: threshold ignores small differences", () => {
  const a = solidPng(4, 4, [100, 100, 100]);
  const b = solidPng(4, 4, [104, 100, 100]);
  assert.equal(pixelDiff(a, b).changed, 16);
  assert.equal(pixelDiff(a, b, 4).changed, 0);
  assert.equal(pixelDiff(a, b, 3).changed, 16);
});

test("pixelDiff: different sizes compare over the union", () => {
  const a = solidPng(4, 4, [0, 0, 0]);
  const b = solidPng(6, 4, [0, 0, 0]);
  const d = pixelDiff(a, b);
  assert.deepEqual([d.width, d.height], [6, 4]);
  assert.equal(d.changed, 8);
  assert.deepEqual(d.sizeMismatch, { a: { width: 4, height: 4 }, b: { width: 6, height: 4 } });
});

test("flattenTree: names when unique, structural paths otherwise", () => {
  const t = out([
    node("lv_label", 0, 0, 10, 10, { name: "title" }),
    node("lv_label", 0, 20, 10, 10),
    node("lv_button", 0, 40, 10, 10, { name: "dup", children: [node("lv_label", 0, 40, 5, 5)] }),
    node("lv_button", 0, 60, 10, 10, { name: "dup" }),
  ]);
  const keys = [...flattenTree(t).keys()];
  assert.deepEqual(keys, ["screen", "title", "screen/lv_label#1", "screen/lv_button#0", "screen/lv_button#0/lv_label#0", "screen/lv_button#1"]);
});

test("objectDiff: added, removed, moved, resized, text, style and state changes", () => {
  const a = out(
    [
      node("lv_label", 10, 10, 100, 20, { name: "title", text: "Hello", styles: { text_color: "#000000", font: "montserrat_14" } }),
      node("lv_button", 10, 50, 80, 40, { name: "ok_btn" }),
      node("lv_switch", 10, 100, 50, 25, { name: "wifi_sw", states: [] }),
      node("lv_label", 10, 150, 50, 20, { name: "old" }),
      node("lv_slider", 10, 200, 100, 10, { name: "s", indicator: { bg_color: "#ff0000" } }),
    ],
    node("lv_obj", 0, 0, 320, 240)
  );
  const b = out(
    [
      node("lv_label", 10, 10, 100, 20, { name: "title", text: "Hello!", styles: { text_color: "#ffffff", font: "montserrat_14" } }),
      node("lv_button", 110, 50, 120, 40, { name: "ok_btn" }),
      node("lv_switch", 10, 100, 50, 25, { name: "wifi_sw", states: ["checked"] }),
      node("lv_label", 10, 180, 60, 20, { name: "new", text: "added" }),
      node("lv_slider", 10, 200, 100, 10, { name: "s", indicator: { bg_color: "#00ff00" } }),
    ],
    node("lv_obj", 0, 0, 320, 240)
  );
  const d = objectDiff(a, b);
  assert.deepEqual(d.added.map((x) => x.key), ["new"]);
  assert.deepEqual(d.removed.map((x) => x.key), ["old"]);
  assert.deepEqual(d.moved, [{ key: "ok_btn", type: "lv_button", from: { x1: 10, y1: 50, x2: 89, y2: 89 }, to: { x1: 110, y1: 50, x2: 229, y2: 89 } }]);
  assert.deepEqual(d.resized, [{ key: "ok_btn", type: "lv_button", from: { w: 80, h: 40 }, to: { w: 120, h: 40 } }]);
  assert.deepEqual(d.text, [{ key: "title", type: "lv_label", from: "Hello", to: "Hello!" }]);
  assert.deepEqual(
    d.styles.map((s) => [s.key, s.changes.map((c) => `${c.part}.${c.key}`)]),
    [
      ["title", ["main.text_color"]],
      ["s", ["indicator.bg_color"]],
    ]
  );
  assert.deepEqual(d.other, [{ key: "wifi_sw", type: "lv_switch", prop: "states", from: [], to: ["checked"] }]);
  assert.equal(d.unchanged, 2, "screen and layer_top");
  const t = formatObjectDiff(d);
  assert.match(t, /1 added, 1 removed, 1 moved, 1 resized, 1 text changed, 2 with style changes, 1 other property changes, 2 unchanged/);
  assert.match(t, /~ moved "ok_btn" \(lv_button\): 10,50 80x40 -> 110,50 120x40/);
  assert.match(t, /~ text "title" \(lv_label\): "Hello" -> "Hello!"/);
  assert.match(t, /~ style "s" \(lv_slider\): indicator\.bg_color "#ff0000" -> "#00ff00"/);
  assert.match(t, /~ states "wifi_sw" \(lv_switch\): \[\] -> \["checked"\]/);
  assert.match(t, /\+ added "new" \(lv_label\) @ 10,180 60x20 text "added"/);
});

test("objectDiff: identical trees", () => {
  const t = out([node("lv_label", 0, 0, 10, 10, { name: "a", text: "x" })]);
  const d = objectDiff(t, t);
  assert.equal(d.unchanged, 2);
  assert.equal(d.added.length + d.removed.length + d.moved.length + d.text.length + d.styles.length + d.other.length, 0);
});

test("RenderHistory keeps the last N renders with increasing ids", () => {
  const h = new RenderHistory(3);
  const fake = { pngWidth: 1, pngHeight: 1 } as never;
  for (let i = 0; i < 5; i++) h.add(fake, "lvgl_render");
  assert.deepEqual(h.ids(), ["r3", "r4", "r5"]);
  assert.equal(h.get("r1"), undefined);
  assert.equal(h.get("r4")?.id, "r4");
  assert.equal(h.get("4")?.id, "r4", "bare numbers work too");
  assert.equal(h.latest()?.id, "r5");
  assert.match(h.describe(), /r3 \(lvgl_render, 1x1\)/);
});
