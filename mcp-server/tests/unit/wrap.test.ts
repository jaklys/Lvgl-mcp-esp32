import { test } from "node:test";
import assert from "node:assert/strict";
import { wrapSnippet, buildConfigureArgs, type CompilerConfig } from "../../src/simulator/compiler.js";

const OLD_TEMPLATE = `#include "lvgl.h"

void create_ui(void)
{
    lv_obj_t *screen = lv_screen_active();

    /* === USER CODE BEGIN === */
    %USER_CODE%
    /* === USER CODE END === */
}
`;

const NEW_TEMPLATE = `#include "lvgl.h"
#include <stdio.h>

void create_ui(void)
{
    lv_obj_t *screen = lv_screen_active();
    (void)screen;
#line 1 "snippet.c"
%USER_CODE%
}
`;

test("wrapSnippet keeps $-patterns verbatim", () => {
  const snippet = 'lv_label_set_text(l, "costs $5, $& and $1 and $$ and $\' and $`");';
  const out = wrapSnippet(OLD_TEMPLATE, snippet);
  assert.ok(out.includes(snippet), "snippet must be inserted verbatim");
  assert.ok(!out.includes("%USER_CODE%"));
});

test("wrapSnippet inserts #line 1 \"snippet.c\" directly before the snippet (old template)", () => {
  const out = wrapSnippet(OLD_TEMPLATE, "int a = 1;\nint b = 2;");
  const lines = out.split("\n");
  const idx = lines.indexOf('#line 1 "snippet.c"');
  assert.ok(idx >= 0, "directive present");
  assert.equal(lines[idx + 1], "int a = 1;", "snippet line 1 follows the directive");
  assert.equal(lines[idx + 2], "int b = 2;");
  assert.ok(out.trimEnd().endsWith("}"));
});

test("wrapSnippet does not duplicate an existing #line directive (new template)", () => {
  const out = wrapSnippet(NEW_TEMPLATE, "foo();");
  assert.equal(out.match(/#line 1 "snippet\.c"/g)?.length, 1);
  const lines = out.split("\n");
  assert.equal(lines[lines.indexOf('#line 1 "snippet.c"') + 1], "foo();");
});

test("wrapSnippet always ends the snippet with a newline before the rest of the template", () => {
  const out = wrapSnippet(NEW_TEMPLATE, "// trailing comment");
  // the comment must not swallow the closing brace of create_ui()
  assert.ok(out.includes("// trailing comment\n\n}"));
});

test("wrapSnippet rejects templates without placeholder", () => {
  assert.throws(() => wrapSnippet("void create_ui(void){}", "x"));
});

test("configure args request a Release build", () => {
  const cfg: CompilerConfig = {
    cmakePath: "cmake",
    ninjaPath: "/usr/bin/ninja",
    simulatorDir: "/sim",
    buildDir: "/sim/build",
    generator: "Ninja",
  };
  const args = buildConfigureArgs(cfg);
  assert.deepEqual(args.slice(0, 7), ["-S", "/sim", "-B", "/sim/build", "-G", "Ninja", "-DCMAKE_BUILD_TYPE=Release"]);
  assert.ok(args.includes("-DCMAKE_MAKE_PROGRAM=/usr/bin/ninja"));
  assert.ok(!args.some((a) => a.startsWith("-DCMAKE_C_COMPILER")), "no compiler override unless CC is set");

  const bare = buildConfigureArgs({ ...cfg, ninjaPath: "ninja", compilerPath: "cl" });
  assert.ok(!bare.some((a) => a.startsWith("-DCMAKE_MAKE_PROGRAM")), "bare ninja is found by CMake on PATH");
  assert.ok(bare.includes("-DCMAKE_C_COMPILER=cl"));
});
