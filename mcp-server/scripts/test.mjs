#!/usr/bin/env node
/**
 * Test runner: `node --test --import tsx <files>`.
 *
 * Enumerates tests/**\/*.test.ts itself because glob patterns in `node --test`
 * arguments are only expanded by Node >= 21 (engines allows Node 20).
 * Extra arguments are passed to `node --test` (e.g. --test-name-pattern=...).
 * LVGL_E2E=1 enables the end-to-end tests (see tests/e2e).
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function findTests(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findTests(full));
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

const files = findTests(path.join(packageDir, "tests"))
  .map((f) => path.relative(packageDir, f))
  .sort();
if (files.length === 0) {
  console.error("[test] no tests/**/*.test.ts files found");
  process.exit(1);
}

const res = spawnSync(
  process.execPath,
  ["--test", "--import", "tsx", ...process.argv.slice(2), ...files],
  { cwd: packageDir, stdio: "inherit" }
);
if (res.error) {
  console.error(`[test] failed to start node: ${res.error.message}`);
  process.exit(1);
}
process.exit(res.status ?? 1);
