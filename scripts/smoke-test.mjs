#!/usr/bin/env node
// Smoke test for a built simulator binary (setup scripts, CI and release).
//
//   node scripts/smoke-test.mjs <path/to/lvgl_sim[.exe]> [width] [height]
//        [--ui FILE] [--expect-names a,b,c] [--no-toolchain]
//
// Runs the binary in a temporary directory, then checks the exit code, the
// PNG signature + IHDR size and the JSON format_version (3).
//   --ui FILE            render a JSON UI document (lvgl_sim --ui FILE)
//                        instead of the built-in placeholder screen
//   --expect-names a,b   these object names must appear in the widget tree
//   --no-toolchain       run the binary with a stripped environment whose PATH
//                        holds no compiler, CMake, Ninja or Make (asserted),
//                        proving it needs no toolchain at run time
// Exits non-zero with a message on stderr on any failure. Leaves no files.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const FORMAT_VERSION = 3;
const TOOLS = ["cc", "gcc", "clang", "c++", "g++", "clang++", "cl", "cmake", "ninja", "make"];

function usage() {
  process.stderr.write(
    "usage: node scripts/smoke-test.mjs <lvgl_sim> [width] [height] [--ui FILE] [--expect-names a,b] [--no-toolchain]\n"
  );
  process.exit(2);
}

const positional = [];
let uiFile = null;
let expectNames = [];
let noToolchain = false;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--ui") {
    uiFile = argv[++i];
    if (!uiFile) usage();
  } else if (a === "--expect-names") {
    if (argv[i + 1] === undefined) usage();
    expectNames = argv[++i].split(",").filter(Boolean);
  } else if (a === "--no-toolchain") {
    noToolchain = true;
  } else if (a.startsWith("--")) {
    usage();
  } else {
    positional.push(a);
  }
}
const [bin, w = "320", h = "240"] = positional;
if (!bin) usage();

/** Minimal environment with no build tools on PATH (throws if one is found). */
function strippedEnv(dir) {
  let env;
  if (process.platform === "win32") {
    const root = process.env.SystemRoot || "C:\\Windows";
    env = { SystemRoot: root, PATH: join(root, "System32"), TEMP: dir, TMP: dir };
  } else {
    const empty = join(dir, "empty-path");
    mkdirSync(empty);
    env = { PATH: empty, HOME: dir, TMPDIR: dir };
  }
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat"] : [""];
  for (const d of env.PATH.split(delimiter)) {
    for (const tool of TOOLS) {
      for (const ext of exts) {
        if (existsSync(join(d, tool + ext))) throw new Error(`stripped PATH still contains ${join(d, tool + ext)}`);
      }
    }
  }
  return env;
}

function collectNames(node, out) {
  if (!node || typeof node !== "object") return out;
  if (typeof node.name === "string") out.add(node.name);
  for (const child of node.children ?? []) collectNames(child, out);
  return out;
}

const dir = mkdtempSync(join(tmpdir(), "lvgl-smoke-"));
const png = join(dir, "smoke.png");
const json = join(dir, "smoke.json");
try {
  const args = ["--width", w, "--height", h, "--time-ms", "330", "--output-png", png, "--output-json", json];
  if (uiFile) args.push("--ui", resolve(uiFile));
  const options = { stdio: ["ignore", "ignore", "pipe"], timeout: 60_000, cwd: dir };
  if (noToolchain) options.env = strippedEnv(dir);
  try {
    execFileSync(resolve(bin), args, options);
  } catch (err) {
    const tail = err.stderr ? String(err.stderr).trim().split(/\r?\n/).slice(-15).join("\n") : "";
    throw new Error(`simulator failed (${err.status ?? err.signal ?? err.code})${tail ? `:\n${tail}` : ""}`);
  }

  const head = readFileSync(png).subarray(0, 24);
  if (!head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    throw new Error("output is not a PNG file");
  }
  if (head.toString("latin1", 12, 16) !== "IHDR") throw new Error("PNG has no IHDR chunk");
  const pw = head.readUInt32BE(16);
  const ph = head.readUInt32BE(20);
  // --scale may upscale the PNG; the smoke test never passes it.
  if (pw !== Number(w) || ph !== Number(h)) throw new Error(`PNG is ${pw}x${ph}, expected ${w}x${h}`);

  const doc = JSON.parse(readFileSync(json, "utf8"));
  if (doc.format_version !== FORMAT_VERSION) {
    throw new Error(`JSON format_version is ${doc.format_version}, expected ${FORMAT_VERSION}`);
  }
  if (!doc.screen) throw new Error("JSON has no screen node");
  if (doc.display?.width !== Number(w) || doc.display?.height !== Number(h)) {
    throw new Error(`JSON display is ${doc.display?.width}x${doc.display?.height}, expected ${w}x${h}`);
  }
  const names = collectNames(doc.screen, new Set());
  const missing = expectNames.filter((n) => !names.has(n));
  if (missing.length) {
    throw new Error(`widget tree lacks ${missing.join(", ")} (has: ${[...names].join(", ") || "no names"})`);
  }

  const what = [uiFile ? `UI ${uiFile}` : "placeholder", noToolchain ? "no toolchain on PATH" : ""].filter(Boolean);
  process.stderr.write(
    `[OK] Smoke test: ${pw}x${ph} PNG, JSON v${FORMAT_VERSION}, LVGL ${doc.lvgl_version ?? "?"} (${what.join(", ")})\n`
  );
} catch (err) {
  process.stderr.write(`[ERROR] Smoke test failed: ${err.message}\n`);
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
