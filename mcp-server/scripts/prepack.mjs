#!/usr/bin/env node
/**
 * prepack: copy the repository README.md and LICENSE into the package
 * directory so they ship in the npm tarball (they live at the repo root).
 * The copies are git-ignored (mcp-server/.gitignore).
 */
import { copyFileSync, existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageDir, "..");

for (const file of ["README.md", "LICENSE"]) {
  const src = path.join(repoRoot, file);
  const dst = path.join(packageDir, file);
  if (existsSync(src)) {
    copyFileSync(src, dst);
    console.error(`[prepack] copied ${file}`);
  } else if (!existsSync(dst)) {
    console.error(`[prepack] warning: ${src} not found; ${file} will be missing from the package`);
  }
}
