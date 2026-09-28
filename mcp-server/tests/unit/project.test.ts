import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  collectSources,
  defaultAllowedRoots,
  entryWrapperSource,
  globToRegExp,
  isInside,
  isValidDefine,
  resolveProjectRoot,
  stageInlineFiles,
  validateRelativePath,
  writeEspShimStubs,
  withEspShims,
} from "../../src/simulator/project.js";
import { buildProjectRequest } from "../../src/tools/render.js";

test("validateRelativePath: normalises good paths, rejects absolute paths and traversal", () => {
  assert.equal(validateRelativePath("ui/ui.c"), "ui/ui.c");
  assert.equal(validateRelativePath("./ui//screens\\home.c"), "ui/screens/home.c");
  assert.equal(validateRelativePath("a/./b.h"), "a/b.h");
  for (const bad of ["", "   ", "/etc/passwd", "\\\\server\\share\\x.c", "C:\\x.c", "c:/x.c", "../x.c", "a/../../x.c", "a/..", "..", "a\u0000b.c", "a;b.c", "./", "."]) {
    assert.throws(() => validateRelativePath(bad), /./, JSON.stringify(bad));
  }
});

test("isInside", () => {
  assert.equal(isInside("/a/b", "/a/b"), true);
  assert.equal(isInside("/a/b", "/a/b/c/d"), true);
  assert.equal(isInside("/a/b", "/a/bc"), false);
  assert.equal(isInside("/a/b", "/a"), false);
  assert.equal(isInside("/a/b", "/a/b/../c"), false);
});

test("defaultAllowedRoots: client roots, LVGL_PROJECT_ROOT, cwd unless / or home", () => {
  assert.deepEqual(defaultAllowedRoots(["/c1"], { LVGL_PROJECT_ROOT: "/proj" }, "/work/app", "/home/u"), ["/c1", path.resolve("/proj"), path.resolve("/work/app")]);
  assert.deepEqual(defaultAllowedRoots([], {}, "/", "/home/u"), []);
  assert.deepEqual(defaultAllowedRoots([], {}, "/home/u", "/home/u"), []);
});

test("resolveProjectRoot: realpath inside an allowed root; symlink escapes and traversal rejected", async () => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lvgl-roots-")));
  try {
    const allowed = path.join(base, "allowed");
    const outside = path.join(base, "outside");
    await fs.mkdir(path.join(allowed, "proj"), { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    assert.equal(await resolveProjectRoot(path.join(allowed, "proj"), [allowed]), path.join(allowed, "proj"));
    assert.equal(await resolveProjectRoot(allowed, [allowed]), allowed);
    await assert.rejects(resolveProjectRoot(outside, [allowed]), /outside the allowed directories/);
    await assert.rejects(resolveProjectRoot(path.join(allowed, "..", "outside"), [allowed]), /outside the allowed directories/);
    await assert.rejects(resolveProjectRoot("relative", [allowed]), /absolute/);
    await assert.rejects(resolveProjectRoot(path.join(allowed, "missing"), [allowed]), /does not exist/);
    await assert.rejects(resolveProjectRoot(outside, []), /\(none\)/);
    if (process.platform !== "win32") {
      await fs.symlink(outside, path.join(allowed, "link"));
      await assert.rejects(resolveProjectRoot(path.join(allowed, "link"), [allowed]), /outside the allowed directories/);
    }
    await fs.writeFile(path.join(allowed, "file.c"), "");
    await assert.rejects(resolveProjectRoot(path.join(allowed, "file.c"), [allowed]), /not a directory/);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("globToRegExp", () => {
  assert.ok(globToRegExp("main.c").test("main/main.c"));
  assert.ok(globToRegExp("main.c").test("main.c"));
  assert.ok(!globToRegExp("main.c").test("mymain.c"));
  assert.ok(globToRegExp("*_test.c").test("a/b_test.c"));
  assert.ok(globToRegExp("drivers/**").test("drivers/lcd/st7789.c"));
  assert.ok(!globToRegExp("drivers/**").test("ui/drivers.c"));
  assert.ok(globToRegExp("**/hw_*.c").test("a/b/hw_x.c"));
  assert.ok(globToRegExp("**/hw_*.c").test("hw_x.c"));
  assert.ok(globToRegExp("src/?.c").test("src/a.c"));
  assert.ok(!globToRegExp("src/?.c").test("src/ab.c"));
});

test("collectSources: sources, header dirs, excluded build dirs and globs, no symlinks", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lvgl-col-")));
  try {
    const w = async (rel: string, content = "") => {
      await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
      await fs.writeFile(path.join(root, rel), content);
    };
    await w("ui/ui.c");
    await w("ui/ui.h");
    await w("ui/screens/home.c");
    await w("ui/components/widget.cpp");
    await w("main/main.c");
    await w("build/CMakeFiles/x.c");
    await w("managed_components/lvgl/lv_obj.c");
    await w(".git/hooks/x.c");
    await w("drivers/lcd.c");
    await w("docs/readme.md");
    if (process.platform !== "win32") await fs.symlink(path.join(root, "ui", "ui.c"), path.join(root, "link.c"));
    const c = await collectSources(root, ["main/main.c", "drivers/**"]);
    assert.deepEqual(c.relSources, ["ui/components/widget.cpp", "ui/screens/home.c", "ui/ui.c"]);
    assert.deepEqual(c.sources, c.relSources.map((r) => path.join(root, r)));
    assert.deepEqual(c.headerDirs, [path.join(root, "ui")]);
    assert.deepEqual(c.relHeaders, ["ui/ui.h"]);
    assert.equal(c.hasCxx, true);
    await assert.rejects(collectSources(path.join(root, "docs")), /no \.c\/\.cpp sources/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("stageInlineFiles: writes files, keeps unchanged mtimes, removes stale files, rejects traversal", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lvgl-stage-"));
  try {
    await stageInlineFiles(dir, [
      { path: "ui/ui.c", content: "A" },
      { path: "ui/old.c", content: "B" },
    ]);
    const st1 = await fs.stat(path.join(dir, "ui", "ui.c"));
    await new Promise((r) => setTimeout(r, 20));
    const rels = await stageInlineFiles(dir, [
      { path: "ui/ui.c", content: "A" },
      { path: "ui/screens/new.c", content: "C" },
    ]);
    assert.deepEqual(rels, ["ui/ui.c", "ui/screens/new.c"]);
    const st2 = await fs.stat(path.join(dir, "ui", "ui.c"));
    assert.equal(st2.mtimeMs, st1.mtimeMs, "unchanged file not rewritten");
    await assert.rejects(fs.stat(path.join(dir, "ui", "old.c")), "stale file removed");
    assert.equal(await fs.readFile(path.join(dir, "ui", "screens", "new.c"), "utf-8"), "C");
    await assert.rejects(stageInlineFiles(dir, [{ path: "../evil.c", content: "" }]), /\.\./);
    await assert.rejects(stageInlineFiles(dir, [{ path: "/abs.c", content: "" }]), /relative/);
    await assert.rejects(
      stageInlineFiles(dir, [
        { path: "a.c", content: "" },
        { path: "A.c", content: "" },
      ]),
      /duplicate/
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("entry wrapper and ESP-IDF shims", async () => {
  const w = entryWrapperSource("ui_init", false);
  assert.match(w, /void ui_init\(void\);/);
  assert.match(w, /void create_ui\(void\)\n\{\n {4}ui_init\(\);\n\}/);
  assert.doesNotMatch(w, /esp_shim/);
  const s = entryWrapperSource("ui_init", true);
  assert.match(s, /#include "esp_shim\.h"/);
  const self = entryWrapperSource("create_ui", false);
  assert.doesNotMatch(self, /void create_ui\(void\)\n\{/);
  assert.throws(() => entryWrapperSource("ui init", false));
  assert.throws(() => entryWrapperSource("1abc", false));
  const full = withEspShims("int x;\n", "user_code.c");
  assert.match(full, /#include "esp_shim\.h"\n#line 1 "user_code\.c"\nint x;/);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lvgl-shim-"));
  try {
    await writeEspShimStubs(dir);
    for (const h of ["esp_log.h", "freertos/FreeRTOS.h", "freertos/task.h", "freertos/semphr.h", "esp_lvgl_port.h", "esp_timer.h", "esp_err.h"]) {
      const text = await fs.readFile(path.join(dir, ...h.split("/")), "utf-8");
      assert.match(text, /#include "esp_shim\.h"/, h);
    }
    assert.match(await fs.readFile(path.join(dir, "esp_lvgl_port.h"), "utf-8"), /lvgl_port_lock\(uint32_t timeout_ms\)/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("isValidDefine", () => {
  for (const d of ["A", "LV_CONF_INCLUDE_SIMPLE", "X=1", "S=\"str\"", "_x=a b"]) assert.equal(isValidDefine(d), true, d);
  for (const d of ["", "1A", "A;B", "A=1;B=2", "A=\n", "-DA", "A B"]) assert.equal(isValidDefine(d), false, d);
});

test("buildProjectRequest: exactly one source, inline paths validated, root checked, include dirs", async () => {
  const none = async () => [] as string[];
  await assert.rejects(buildProjectRequest({ entry: "ui_init" }, none), /exactly one/);
  await assert.rejects(buildProjectRequest({ entry: "ui_init", files: [{ path: "a.c", content: "" }], root: "/x" }, none), /exactly one/);
  await assert.rejects(buildProjectRequest({ entry: "ui init", files: [{ path: "a.c", content: "" }] }, none), /C identifier/);
  await assert.rejects(buildProjectRequest({ entry: "ui_init", files: [{ path: "../a.c", content: "" }] }, none), /\.\./);
  await assert.rejects(buildProjectRequest({ entry: "ui_init", files: [{ path: "a.h", content: "" }] }, none), /no \.c\/\.cpp/);
  await assert.rejects(
    buildProjectRequest({ entry: "ui_init", files: [{ path: "a.c", content: "" }], include_dirs: ["/usr/include"] }, none),
    /relative/
  );
  const r = await buildProjectRequest({ entry: "ui_init", files: [{ path: "src\\a.c", content: "x" }], include_dirs: ["inc"], defines: ["A=1"] }, none);
  assert.deepEqual(r.files, [{ path: "src/a.c", content: "x" }]);
  assert.deepEqual(r.includeDirs, ["inc"]);

  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lvgl-bpr-")));
  try {
    await fs.mkdir(path.join(base, "proj", "inc"), { recursive: true });
    await fs.mkdir(path.join(base, "other"), { recursive: true });
    const allowed = async () => [path.join(base, "proj")];
    const ok = await buildProjectRequest({ entry: "ui_init", root: path.join(base, "proj"), include_dirs: ["inc", path.join(base, "proj", "inc")] }, allowed);
    assert.equal(ok.root, path.join(base, "proj"));
    assert.deepEqual(ok.includeDirs, ["inc", path.join(base, "proj", "inc")]);
    await assert.rejects(buildProjectRequest({ entry: "ui_init", root: path.join(base, "other") }, allowed), /outside the allowed/);
    await assert.rejects(
      buildProjectRequest({ entry: "ui_init", root: path.join(base, "proj"), include_dirs: [path.join(base, "other")] }, allowed),
      /outside the allowed/
    );
    await assert.rejects(buildProjectRequest({ entry: "ui_init", root: path.join(base, "proj"), include_dirs: ["../other"] }, allowed), /\.\./);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});
