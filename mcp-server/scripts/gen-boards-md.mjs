#!/usr/bin/env node
/**
 * Print the board presets (src/boards.ts, the single source of truth) as a
 * Markdown table, or write it into files between the markers
 *   <!-- BOARDS:BEGIN -->
 *   <!-- BOARDS:END -->
 *
 * Usage:
 *   node scripts/gen-boards-md.mjs                     print the table
 *   node scripts/gen-boards-md.mjs --write [file ...]  update the files (default: ../docs/boards.md)
 *   node scripts/gen-boards-md.mjs --check [file ...]  exit 1 when a file is out of date
 *
 * Loads src/boards.ts through tsx (dev dependency) and falls back to the
 * compiled dist/boards.js.
 */
import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadBoards() {
  try {
    const { register } = await import("tsx/esm/api");
    register();
    return await import(pathToFileURL(path.join(packageDir, "src", "boards.ts")).href);
  } catch {
    return await import(pathToFileURL(path.join(packageDir, "dist", "boards.js")).href);
  }
}

const BEGIN = "<!-- BOARDS:BEGIN -->";
const END = "<!-- BOARDS:END -->";

const { boardsMarkdownTable } = await loadBoards();
const table = boardsMarkdownTable();
const mode = process.argv[2];
if (mode !== "--write" && mode !== "--check") {
  process.stdout.write(table + "\n");
  process.exit(0);
}
const files = process.argv.slice(3);
if (files.length === 0) files.push(path.join(packageDir, "..", "docs", "boards.md"));
let stale = 0;
for (const f of files) {
  const text = readFileSync(f, "utf-8");
  const a = text.indexOf(BEGIN);
  const b = text.indexOf(END);
  if (a < 0 || b < a) {
    console.error(`${f}: markers ${BEGIN} ... ${END} not found`);
    process.exit(1);
  }
  const next = text.slice(0, a + BEGIN.length) + "\n" + table + "\n" + text.slice(b);
  if (next === text) continue;
  if (mode === "--check") {
    console.error(`${f}: board table is out of date (run node mcp-server/scripts/gen-boards-md.mjs --write ${f})`);
    stale++;
  } else {
    writeFileSync(f, next);
    console.error(`updated ${f}`);
  }
}
process.exit(stale ? 1 : 0);
