#!/usr/bin/env node
// Entry point for `npx lvgl-mcp-server`. stdout carries JSON-RPC, so every
// diagnostic here goes to stderr.
import { existsSync } from "node:fs";

const major = Number(process.versions.node.split(".")[0]);
if (major < 20) {
  process.stderr.write(
    `[lvgl-mcp] Node.js >= 20 is required (found ${process.versions.node}).\n` +
      "[lvgl-mcp] Install a current LTS release from https://nodejs.org/ and try again.\n"
  );
  process.exit(1);
}

const entry = new URL("../dist/index.js", import.meta.url);
if (!existsSync(entry)) {
  process.stderr.write(
    "[lvgl-mcp] dist/index.js is missing. In a git checkout, run `npm run build` in mcp-server/ first.\n"
  );
  process.exit(1);
}

await import(entry.href);
