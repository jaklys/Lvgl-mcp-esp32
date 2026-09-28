#!/usr/bin/env node
// Smoke test for a built simulator binary (used by setup.sh / setup.ps1).
//
//   node scripts/smoke-test.mjs <path/to/lvgl_sim[.exe]> [width] [height]
//
// Runs the binary with the v2.1 CLI in a temporary directory, then checks the
// exit code, the PNG signature + IHDR size and the JSON format_version.
// Exits non-zero with a message on stderr on any failure. Leaves no files.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [bin, w = "320", h = "240"] = process.argv.slice(2);
if (!bin) {
  process.stderr.write("usage: node scripts/smoke-test.mjs <lvgl_sim> [width] [height]\n");
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), "lvgl-smoke-"));
const png = join(dir, "smoke.png");
const json = join(dir, "smoke.json");
try {
  try {
    execFileSync(
      bin,
      ["--width", w, "--height", h, "--time-ms", "330", "--output-png", png, "--output-json", json],
      { stdio: ["ignore", "ignore", "pipe"], timeout: 60_000 }
    );
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
  if (pw !== Number(w) || ph !== Number(h)) throw new Error(`PNG is ${pw}x${ph}, expected ${w}x${h}`);

  const doc = JSON.parse(readFileSync(json, "utf8"));
  if (doc.format_version !== 2) throw new Error(`JSON format_version is ${doc.format_version}, expected 2`);
  if (!doc.screen) throw new Error("JSON has no screen node");

  process.stderr.write(`[OK] Smoke test: ${pw}x${ph} PNG, JSON v2, LVGL ${doc.lvgl_version ?? "?"}\n`);
} catch (err) {
  process.stderr.write(`[ERROR] Smoke test failed: ${err.message}\n`);
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
