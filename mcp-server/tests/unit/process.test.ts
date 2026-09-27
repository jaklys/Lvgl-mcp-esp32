import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveExecutable, runProcess } from "../../src/simulator/process.js";
import { parseSetOutput } from "../../src/simulator/msvc.js";
import { readPackageVersion, resolveSimulatorDir } from "../../src/paths.js";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const node = process.execPath;

test("runProcess captures stdout and stderr separately and never throws on exit code", async () => {
  const r = await runProcess(node, ["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"]);
  assert.equal(r.stdout, "out");
  assert.equal(r.stderr, "err");
  assert.equal(r.code, 3);
  assert.equal(r.timedOut, false);
});

test("runProcess kills the process tree on timeout", async () => {
  const t0 = Date.now();
  // Parent spawns a grandchild that would keep the pipes open for 60 s.
  const script =
    "const {spawn}=require('child_process');" +
    "spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'inherit'});" +
    "setTimeout(()=>{},60000);";
  const r = await runProcess(node, ["-e", script], { timeoutMs: 500 });
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - t0 < 10000, "returned promptly (grandchild did not keep pipes open)");
});

test("runProcess honours an AbortSignal", async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 200);
  const r = await runProcess(node, ["-e", "setTimeout(()=>{},60000)"], { signal: ac.signal });
  assert.equal(r.aborted, true);
});

test("runProcess reports spawn errors", async () => {
  const r = await runProcess("definitely-not-a-real-binary-xyz", []);
  assert.ok(r.spawnError);
  assert.equal(r.spawnError.code, "ENOENT");
});

test("runProcess truncates at maxBuffer", async () => {
  const r = await runProcess(node, ["-e", "process.stdout.write('x'.repeat(100000))"], { maxBuffer: 1000 });
  assert.ok(r.stdout.length <= 1000);
  assert.equal(r.truncated, true);
});

test("resolveExecutable finds node on PATH", () => {
  const dir = path.dirname(node);
  const found = resolveExecutable(path.basename(node, ".exe"), { PATH: dir, PATHEXT: ".EXE" });
  assert.ok(found);
  assert.equal(resolveExecutable("definitely-not-a-real-binary-xyz", { PATH: dir }), undefined);
});

test("parseSetOutput parses `set` output from vcvarsall", () => {
  const env = parseSetOutput("=C:=C:\\\r\nINCLUDE=C:\\VC\\include;C:\\SDK\r\nPath=C:\\a;C:\\b\r\nEMPTY=\r\n");
  assert.equal(env["INCLUDE"], "C:\\VC\\include;C:\\SDK");
  assert.equal(env["Path"], "C:\\a;C:\\b");
  assert.equal(env["EMPTY"], "");
  assert.equal(Object.keys(env).length, 3);
});

test("simulator dir precedence: LVGL_SIM_PATH > LVGL_PROJECT_ROOT > npm > git checkout", () => {
  const pkg = path.resolve("/opt/pkg");
  const none = () => false;
  const all = () => true;
  assert.deepEqual(resolveSimulatorDir(pkg, { LVGL_SIM_PATH: "/s", LVGL_PROJECT_ROOT: "/r" }, all), {
    simulatorDir: path.resolve("/s"),
    source: "LVGL_SIM_PATH",
  });
  assert.deepEqual(resolveSimulatorDir(pkg, { LVGL_PROJECT_ROOT: "/r" }, all), {
    simulatorDir: path.resolve("/r", "simulator"),
    source: "LVGL_PROJECT_ROOT",
  });
  assert.deepEqual(resolveSimulatorDir(pkg, {}, all), { simulatorDir: path.join(pkg, "simulator"), source: "npm package" });
  assert.deepEqual(resolveSimulatorDir(pkg, {}, none), {
    simulatorDir: path.resolve(pkg, "..", "simulator"),
    source: "git checkout",
  });
});

test("server version is read from package.json", () => {
  const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  assert.match(readPackageVersion(pkgDir), /^\d+\.\d+\.\d+/);
  assert.equal(readPackageVersion("/nonexistent"), "0.0.0");
});
