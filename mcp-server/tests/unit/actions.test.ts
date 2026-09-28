import { test } from "node:test";
import assert from "node:assert/strict";
import { actionSchema, actionsSchema, framesSchema, renderOptionsShape } from "../../src/tools/schemas.js";

test("every action kind of the contract validates", () => {
  const ok = [
    { wait: 300 },
    { click: { x: 10, y: 20 } },
    { click: { name: "ok_btn" } },
    { click: { name: "lv_button#2" } },
    { press: { name: "ok_btn" } },
    { press: { x: 1, y: 2 } },
    { release: {} },
    { drag: { from: { x: 10, y: 10 }, to: { name: "target" }, steps: 10, duration: 300 } },
    { drag: { from: { name: "slider" }, to: { x: 300, y: 10 } } },
    { key: "ENTER" },
    { key: "BACKSPACE" },
    { key: "a" },
    { key: "č" },
    { type: "hello" },
    { focus: { name: "ssid" } },
    { capture: "after_click-1" },
    { settle: 3000 },
    { load_screen: { name: "settings" } },
    { load_screen: { name: "settings", anim: "fade", duration: 300 } },
    { load_screen: { name: "settings", anim: "move_left" } },
  ];
  for (const a of ok) assert.equal(actionSchema.safeParse(a).success, true, JSON.stringify(a));
});

test("malformed actions are rejected", () => {
  const bad: unknown[] = [
    {},
    { wait: -1 },
    { wait: 1.5 },
    { wait: 100000 },
    { click: {} },
    { click: { x: 1 } },
    { click: { name: "" } },
    { click: { name: "a", x: 1 } },
    { click: { name: "a" }, wait: 1 },
    { release: { x: 1 } },
    { drag: { from: { x: 1, y: 1 } } },
    { drag: { from: { x: 1, y: 1 }, to: { x: 2, y: 2 }, steps: 0 } },
    { key: "ENTERR" },
    { key: "ab" },
    { key: "" },
    { type: "" },
    { focus: { x: 1, y: 1 } },
    { capture: "" },
    { capture: "with space" },
    { capture: "../../etc" },
    { capture: "x".repeat(33) },
    { settle: -5 },
    { load_screen: { name: "s", anim: "spin" } },
    { load_screen: {} },
    { jump: 1 },
    "click",
    null,
  ];
  for (const a of bad) assert.equal(actionSchema.safeParse(a).success, false, JSON.stringify(a));
});

test("actions array limits: 1..200 entries, at most 20 captures", () => {
  assert.equal(actionsSchema.safeParse([]).success, false);
  assert.equal(actionsSchema.safeParse(Array.from({ length: 200 }, () => ({ wait: 1 }))).success, true);
  assert.equal(actionsSchema.safeParse(Array.from({ length: 201 }, () => ({ wait: 1 }))).success, false);
  assert.equal(actionsSchema.safeParse(Array.from({ length: 20 }, (_, i) => ({ capture: `c${i}` }))).success, true);
  const r = actionsSchema.safeParse(Array.from({ length: 21 }, (_, i) => ({ capture: `c${i}` })));
  assert.equal(r.success, false);
  assert.match(JSON.stringify(r.error?.issues), /at most 20 capture actions/);
});

test("frames: strictly ascending, 1..20 entries", () => {
  assert.equal(framesSchema.safeParse([0, 100, 300]).success, true);
  assert.equal(framesSchema.safeParse([0]).success, true);
  assert.equal(framesSchema.safeParse([100, 100]).success, false);
  assert.equal(framesSchema.safeParse([300, 100]).success, false);
  assert.equal(framesSchema.safeParse([]).success, false);
  assert.equal(framesSchema.safeParse([-1]).success, false);
  assert.equal(framesSchema.safeParse(Array.from({ length: 21 }, (_, i) => i)).success, false);
});

test("common option validation", () => {
  const s = renderOptionsShape;
  assert.equal(s.scale.safeParse(4).success, true);
  assert.equal(s.scale.safeParse(0).success, false);
  assert.equal(s.color_format.safeParse("rgb565").success, true);
  assert.equal(s.color_format.safeParse("RGB565").success, false);
  assert.equal(s.board.safeParse("m5stack-core2").success, true);
  assert.equal(s.board.safeParse("m5stack").success, false);
  assert.equal(s.fonts.safeParse(["montserrat_14", "lv_font_unscii_8"]).success, true);
  assert.equal(s.fonts.safeParse(["Montserrat 14"]).success, false);
  assert.equal(s.mem_budget_kb.safeParse(32).success, true);
  assert.equal(s.mem_budget_kb.safeParse(2).success, false);
});
