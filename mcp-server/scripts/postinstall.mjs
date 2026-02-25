/**
 * postinstall.mjs — Downloads the prebuilt LVGL simulator from GitHub Releases.
 *
 * Runs automatically after `npm install lvgl-mcp-server`.
 * Only downloads on Windows x64. Skips if simulator already present or LVGL_SIM_PATH is set.
 * Uses only Node.js built-ins (no extra dependencies).
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, renameSync, readdirSync } from "node:fs";
import { get } from "node:https";
import { createWriteStream } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageDir = join(__dirname, "..");
const simulatorDir = join(packageDir, "simulator");
const simExe = join(simulatorDir, "build", "lvgl_sim.exe");

const REPO = "jaklys/Lvgl-mcp-esp32";
const ASSET_NAME = "lvgl-mcp-esp32-windows-x64.zip";

// ── Skip conditions ──────────────────────────────────────────────

if (process.env["LVGL_SIM_PATH"]) {
  console.log("[lvgl-mcp] LVGL_SIM_PATH is set, skipping simulator download.");
  process.exit(0);
}

if (existsSync(simExe)) {
  console.log("[lvgl-mcp] Simulator already present, skipping download.");
  process.exit(0);
}

if (process.platform !== "win32") {
  console.warn(
    "[lvgl-mcp] WARNING: Prebuilt simulator is only available for Windows x64.\n" +
    "  Set LVGL_SIM_PATH to point to your own lvgl_sim binary."
  );
  process.exit(0);
}

if (process.arch !== "x64") {
  console.warn(
    `[lvgl-mcp] WARNING: Prebuilt simulator is for x64, your arch is ${process.arch}.\n` +
    "  Set LVGL_SIM_PATH to point to your own lvgl_sim binary."
  );
  process.exit(0);
}

// ── Fetch release info ───────────────────────────────────────────

console.log("[lvgl-mcp] Downloading LVGL simulator from GitHub Releases...");

/**
 * HTTPS GET with redirect following. Returns the response body as a string.
 */
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    get(url, { headers: { "User-Agent": "lvgl-mcp-server-postinstall" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGet(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
      }
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data));
      res.on("error", reject);
    }).on("error", reject);
  });
}

/**
 * Download a file from URL to disk, following redirects.
 */
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    get(url, { headers: { "User-Agent": "lvgl-mcp-server-postinstall" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadFile(res.headers.location, destPath).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} downloading ${url}`));
      }
      const file = createWriteStream(destPath);
      res.pipe(file);
      file.on("finish", () => file.close(resolve));
      file.on("error", reject);
    }).on("error", reject);
  });
}

try {
  // Get latest release info
  const releaseJson = await httpsGet(`https://api.github.com/repos/${REPO}/releases/latest`);
  const release = JSON.parse(releaseJson);

  // Find the Windows asset
  const asset = release.assets?.find((a) => a.name === ASSET_NAME);
  if (!asset) {
    console.error(
      `[lvgl-mcp] ERROR: Could not find ${ASSET_NAME} in release ${release.tag_name}.\n` +
      `  Available assets: ${release.assets?.map((a) => a.name).join(", ") || "none"}\n` +
      "  You may need to build the simulator manually."
    );
    process.exit(1);
  }

  const downloadUrl = asset.browser_download_url;
  const zipPath = join(packageDir, ASSET_NAME);
  const extractDir = join(packageDir, "_release_tmp");

  // Download
  console.log(`[lvgl-mcp] Downloading ${release.tag_name} (${(asset.size / 1024 / 1024).toFixed(1)} MB)...`);
  await downloadFile(downloadUrl, zipPath);
  console.log("[lvgl-mcp] Download complete.");

  // Extract using PowerShell (available on all Windows 10+)
  console.log("[lvgl-mcp] Extracting...");
  mkdirSync(extractDir, { recursive: true });

  execSync(
    `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force"`,
    { stdio: "pipe", timeout: 60000 }
  );

  // Move simulator/ directory to package root
  const extractedSimDir = join(extractDir, "simulator");
  if (existsSync(extractedSimDir)) {
    if (existsSync(simulatorDir)) {
      rmSync(simulatorDir, { recursive: true, force: true });
    }
    renameSync(extractedSimDir, simulatorDir);
    console.log("[lvgl-mcp] Simulator installed successfully.");
  } else {
    // Check if files are one level deeper (zip might have a root folder)
    const entries = readdirSync(extractDir);
    let found = false;
    for (const entry of entries) {
      const nested = join(extractDir, entry, "simulator");
      if (existsSync(nested)) {
        if (existsSync(simulatorDir)) {
          rmSync(simulatorDir, { recursive: true, force: true });
        }
        renameSync(nested, simulatorDir);
        found = true;
        console.log("[lvgl-mcp] Simulator installed successfully.");
        break;
      }
    }
    if (!found) {
      console.error("[lvgl-mcp] ERROR: Could not find simulator/ in the release archive.");
      process.exit(1);
    }
  }

  // Clean up
  rmSync(zipPath, { force: true });
  rmSync(extractDir, { recursive: true, force: true });

  // Verify
  if (existsSync(join(simulatorDir, "build", "lvgl_sim.exe"))) {
    console.log("[lvgl-mcp] Verified: lvgl_sim.exe is present.");
  } else if (existsSync(join(simulatorDir, "lvgl_sim.exe"))) {
    console.log("[lvgl-mcp] Verified: lvgl_sim.exe is present.");
  } else {
    console.warn(
      "[lvgl-mcp] WARNING: lvgl_sim.exe not found after extraction.\n" +
      "  The simulator may need to be built manually."
    );
  }

} catch (err) {
  console.error(`[lvgl-mcp] ERROR during simulator download: ${err.message}`);
  console.error(
    "  You can manually download the simulator from:\n" +
    `  https://github.com/${REPO}/releases/latest\n` +
    "  Extract it and set LVGL_SIM_PATH to the path of lvgl_sim.exe"
  );
  // Don't fail the install — the MCP server can still work if the user
  // provides the simulator path manually
  process.exit(0);
}
