import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanBuildOutput,
  diagnosticHints,
  focusOnUserFiles,
  formatDiagnostic,
  parseDiagnostics,
  shortenPaths,
} from "../../src/simulator/diagnostics.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(path.join(here, "..", "fixtures", name), "utf-8");

const POSIX = { buildDir: "/home/u/sim/build", simulatorDir: "/home/u/sim" };
const WIN = { buildDir: "C:\\Users\\dev\\lvgl-mcp\\simulator\\build", simulatorDir: "C:\\Users\\dev\\lvgl-mcp\\simulator" };

test("gcc: parses errors and warnings with snippet line numbers", () => {
  const d = parseDiagnostics(cleanBuildOutput(fixture("gcc-snippet.txt"), POSIX));
  const errs = d.filter((x) => x.severity === "error");
  assert.deepEqual(errs[0], {
    file: "snippet.c",
    line: 2,
    col: 1,
    severity: "error",
    message: "implicit declaration of function 'undefined_fn' [-Werror=implicit-function-declaration]",
  });
  assert.equal(errs.length, 2);
  assert.ok(d.some((x) => x.severity === "warning" && x.line === 3 && /int-conversion/.test(x.message)));
});

test("clang: parses errors including column", () => {
  const d = parseDiagnostics(fixture("clang-snippet.txt"));
  assert.equal(d.length, 3);
  assert.equal(d[0].file, "snippet.c");
  assert.equal(d[0].line, 2);
  assert.equal(d[2].line, 4);
  assert.equal(d[2].col, 6);
  assert.match(d[2].message, /expected ';'/);
});

test("clean output keeps caret lines, drops summaries", () => {
  const out = cleanBuildOutput(fixture("clang-snippet.txt"), POSIX);
  assert.match(out, /\n\s+2 \| undefined_fn\(l\);/);
  assert.doesNotMatch(out, /errors generated/);
});

test("ninja + GNU ld: strips progress, FAILED, link command, ninja footer; parses undefined reference", () => {
  const raw = fixture("ninja-gcc-link.txt");
  const out = cleanBuildOutput(raw, POSIX);
  assert.doesNotMatch(out, /\[\d+\/\d+\]/);
  assert.doesNotMatch(out, /^FAILED:/m);
  assert.doesNotMatch(out, /ninja: build stopped/);
  assert.doesNotMatch(out, /-O3 -DNDEBUG/);
  const d = parseDiagnostics(out);
  const link = d.find((x) => /undefined reference/.test(x.message));
  assert.ok(link, "linker error parsed");
  assert.equal(link.severity, "error");
  assert.equal(link.file, "user_code.c");
  assert.ok(d.some((x) => x.file === "snippet.c" && x.line === 1 && x.severity === "warning"));
});

test("MSVC: parses file(line) and file(line,col) diagnostics, shortens paths, strips cl command", () => {
  const out = cleanBuildOutput(fixture("msvc-ninja.txt"), WIN);
  assert.doesNotMatch(out, /cl\.exe/);
  assert.doesNotMatch(out, /C:\\Users/);
  const d = parseDiagnostics(out);
  assert.deepEqual(d[0], {
    file: "snippet.c",
    line: 2,
    severity: "error",
    message: "'undefined_fn' undefined; assuming extern returning int",
    code: "C4013",
  });
  assert.equal(d[1].severity, "warning");
  assert.equal(d[1].code, "C4047");
  assert.deepEqual(
    { file: d[2].file, line: d[2].line, col: d[2].col, code: d[2].code },
    { file: "user_code.c", line: 12, col: 5, code: "C2143" }
  );
  assert.equal(d[3].severity, "note");
  assert.equal(d[3].file, "lvgl/src/core/lv_obj.h");
});

test("MSVC linker errors are parsed and the command echo removed", () => {
  const out = cleanBuildOutput(fixture("msvc-link.txt"), WIN);
  assert.doesNotMatch(out, /vs_link_exe|LINK: command/);
  const d = parseDiagnostics(out);
  assert.ok(d.some((x) => x.code === "LNK2019" && x.severity === "error" && /create_ui/.test(x.message)));
  assert.ok(d.some((x) => x.code === "LNK1120"));
  const hints = diagnosticHints(d, true);
  assert.ok(hints.some((h) => /void create_ui\(void\)/.test(h)));
});

test("shortenPaths handles mixed separators and case on Windows paths", () => {
  const s = shortenPaths("c:/users/DEV/lvgl-mcp/simulator/build/user_code.c(3): error", WIN);
  assert.equal(s, "user_code.c(3): error");
  const t = shortenPaths("/home/u/sim/lib/lvgl/src/core/lv_obj.h:12:1: note: x", POSIX);
  assert.equal(t, "lvgl/src/core/lv_obj.h:12:1: note: x");
  const u = shortenPaths("/home/u/sim/main.c:1:1: error", POSIX);
  assert.equal(u, "simulator/main.c:1:1: error");
});

test("shortenPaths: project-relative names use / on Windows (MSVC) and POSIX", () => {
  const root = "C:\\Users\\dev\\proj";
  const s = shortenPaths(`${root}\\ui\\screens\\home.c(2): error C4013: 'nope' undefined`, { ...WIN, stripDirs: [root] });
  assert.equal(s, "ui/screens/home.c(2): error C4013: 'nope' undefined");
  assert.deepEqual(
    { file: parseDiagnostics(s)[0]!.file, line: parseDiagnostics(s)[0]!.line },
    { file: "ui/screens/home.c", line: 2 }
  );
  const t = shortenPaths("/home/u/proj/ui/screens/home.c:2:3: error: x", { ...POSIX, stripDirs: ["/home/u/proj"] });
  assert.equal(t, "ui/screens/home.c:2:3: error: x");
});

test("hints for v8 names and helper functions in snippets", () => {
  const d = parseDiagnostics(
    "snippet.c:1:17: error: implicit declaration of function 'lv_btn_create'; did you mean 'lv_button_create'? [-Werror=implicit-function-declaration]\n" +
      "snippet.c:4:1: error: invalid storage class for function 'cb'"
  );
  const hints = diagnosticHints(d, false);
  assert.ok(hints.some((h) => h.includes("lv_btn_create") && h.includes("rename table")));
  assert.ok(hints.some((h) => h.includes("lvgl_render_full")));
});

test("formatDiagnostic", () => {
  assert.equal(
    formatDiagnostic({ file: "snippet.c", line: 2, col: 5, severity: "error", message: "boom" }),
    "snippet.c:2:5: error: boom"
  );
  assert.equal(
    formatDiagnostic({ file: "snippet.c", line: 2, severity: "error", message: "boom", code: "C4013" }),
    "snippet.c:2: error: C4013: boom"
  );
});

test("focusOnUserFiles drops LVGL library warnings but keeps user diagnostics and errors", () => {
  const text = [
    "lvgl/src/misc/lv_foo.c: In function 'x':",
    "lvgl/src/misc/lv_foo.c:10:3: warning: unused variable 'q' [-Wunused-variable]",
    "   10 |   int q;",
    "      |       ^",
    "snippet.c: In function 'create_ui':",
    "snippet.c:2:1: warning: unused variable 'y'",
    "    2 | int y;",
    "lvgl/src/core/lv_obj.h:5:1: error: something broke",
    "collect2: error: ld returned 1 exit status",
  ].join("\n");
  const out = focusOnUserFiles(text, ["snippet.c", "user_code.c"]);
  assert.doesNotMatch(out, /lv_foo\.c/);
  assert.doesNotMatch(out, /int q/);
  assert.match(out, /snippet\.c:2:1: warning/);
  assert.match(out, / {4}2 \| int y;/);
  assert.match(out, /lv_obj\.h:5:1: error/);
  assert.match(out, /collect2/);
});
