import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { BOARDS, boardDefaults, boardsMarkdownTable, findBoard } from "../../src/boards.js";
import { apiReference, DOC_TOPIC_IDS, getDocTopic } from "../../src/resources/docs/index.js";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("board presets: the contract's boards exist with sane values", () => {
  const required = [
    "esp32-2432s028r",
    "esp32-8048s070",
    "wt32-sc01-plus",
    "lilygo-t-display-s3",
    "lilygo-t-display",
    "m5stack-core2",
    "m5stack-cores3",
    "waveshare-esp32-s3-touch-lcd-1.28",
    "esp32-s3-box-3",
    "esp32-c3-0.42-oled",
    "ssd1306-128x64",
    "st7735-160x80",
    "generic-320x240",
    "generic-480x320",
    "generic-800x480",
  ];
  for (const id of required) assert.ok(findBoard(id), id);
  assert.equal(new Set(BOARDS.map((b) => b.id)).size, BOARDS.length, "unique ids");
  for (const b of BOARDS) {
    assert.match(b.id, /^[a-z0-9.-]+$/);
    assert.ok(b.width >= 16 && b.width <= 4096 && b.height >= 16 && b.height <= 4096, b.id);
    assert.ok(b.dpi >= 50 && b.dpi <= 600, b.id);
    assert.ok(b.mem_kb >= 4, b.id);
    assert.ok(["rgb565", "xrgb8888"].includes(b.color_format), b.id);
    assert.ok(b.name && b.panel && b.notes, b.id);
  }
  const cyd = findBoard("esp32-2432s028r")!;
  assert.deepEqual([cyd.width, cyd.height, cyd.color_format, cyd.mem_kb], [320, 240, "rgb565", 48]);
  assert.deepEqual([findBoard("esp32-8048s070")!.width, findBoard("esp32-8048s070")!.mem_kb], [800, 64]);
  assert.deepEqual([findBoard("waveshare-esp32-s3-touch-lcd-1.28")!.width, findBoard("waveshare-esp32-s3-touch-lcd-1.28")!.height], [240, 240]);
  assert.deepEqual([findBoard("lilygo-t-display-s3")!.width, findBoard("lilygo-t-display-s3")!.height], [320, 170]);
  assert.deepEqual([findBoard("lilygo-t-display")!.width, findBoard("lilygo-t-display")!.height], [135, 240]);
  assert.deepEqual(boardDefaults("m5stack-core2"), { width: 320, height: 240, colorFormat: "rgb565", dpi: 200, rotation: 0, memBudgetKb: 64 });
  assert.equal(boardDefaults(undefined), undefined);
  assert.throws(() => boardDefaults("nope"), /Known boards: esp32-2432s028r/);
});

test("boards markdown: one row per board; docs/boards.md is up to date", () => {
  const table = boardsMarkdownTable();
  assert.equal(table.split("\n").length, BOARDS.length + 2);
  // A Windows checkout (core.autocrlf / text=auto) has CRLF line endings.
  const md = readFileSync(path.join(packageDir, "..", "docs", "boards.md"), "utf-8").replace(/\r\n/g, "\n");
  assert.ok(md.includes(table), "docs/boards.md contains the generated table - run: node scripts/gen-boards-md.mjs --write");
  const out = execFileSync(process.execPath, ["--import", "tsx", path.join(packageDir, "scripts", "gen-boards-md.mjs")], {
    cwd: packageDir,
    encoding: "utf-8",
  });
  assert.equal(out.trim(), table);
});

test("docs: every topic id resolves; api-reference is the concatenation", () => {
  const ref = apiReference();
  for (const id of DOC_TOPIC_IDS) {
    const t = getDocTopic(id);
    assert.ok(t && t.length > 100, id);
    if (!id.startsWith("widgets/")) assert.ok(ref.includes(t!.trim().split("\n")[0]!), `api-reference contains ${id}`);
  }
  assert.equal(getDocTopic("widgets/lv_label"), getDocTopic("widgets/label"), "lv_ prefix accepted");
  assert.equal(getDocTopic("nope"), undefined);
  assert.equal(getDocTopic("widgets/meter"), undefined);
  for (const w of ["label", "button", "slider", "switch", "arc", "chart", "dropdown", "textarea", "tabview", "msgbox", "scale", "obj"]) {
    assert.ok(DOC_TOPIC_IDS.includes(`widgets/${w}`), w);
  }
  assert.match(getDocTopic("widgets/list")!, /DEPRECATED/);
  assert.match(getDocTopic("esp32")!, /vTaskDelay/);
  assert.match(getDocTopic("esp32")!, /MEM_OVER_BUDGET/);
  assert.match(getDocTopic("simulator")!, /sim_advance_ms/);
  assert.match(getDocTopic("ui-json")!, /Example 3 - two screens/);
  assert.match(ref, /lvgl_render_ui/);
  assert.match(ref, /lvgl_diff/);
  assert.doesNotMatch(ref, /No input devices/);
});
