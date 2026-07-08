/**
 * postinstall.mjs — Downloads the prebuilt LVGL simulator from GitHub Releases.
 *
 * Runs automatically after `npm install lvgl-mcp-server`.
 * Downloads a prebuilt simulator for supported platforms (Windows x64, Linux x64).
 * Skips if the simulator is already present or LVGL_SIM_PATH is set.
 * Uses only Node.js built-ins (no extra dependencies).
 */

import { execFileSync, execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  rmSync,
  renameSync,
  readdirSync,
  readFileSync,
  chmodSync,
} from "node:fs";
import { get } from "node:https";
import { createWriteStream } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageDir = join(__dirname, "..");
const simulatorDir = join(packageDir, "simulator");

const REPO = "jaklys/Lvgl-mcp-esp32";

// Platform → release asset map. Unsupported platforms fall through to a
// friendly warning and a clean (exit 0) install.
const ASSET_MAP = {
  "win32-x64": "lvgl-mcp-esp32-windows-x64.zip",
  "linux-x64": "lvgl-mcp-esp32-linux-x64.tar.gz",
};

const isWindows = process.platform === "win32";
const simBinaryName = isWindows ? "lvgl_sim.exe" : "lvgl_sim";
const simExe = join(simulatorDir, "build", simBinaryName);

const platformKey = `${process.platform}-${process.arch}`;
const ASSET_NAME = ASSET_MAP[platformKey];

// ── Skip conditions ──────────────────────────────────────────────

if (process.env["LVGL_SIM_PATH"]) {
  console.log("[lvgl-mcp] LVGL_SIM_PATH is set, skipping simulator download.");
  process.exit(0);
}

if (existsSync(simExe)) {
  console.log("[lvgl-mcp] Simulator already present, skipping download.");
  process.exit(0);
}

if (!ASSET_NAME) {
  console.warn(
    `[lvgl-mcp] WARNING: No prebuilt simulator is available for ${platformKey}.\n` +
    "  Supported: " + Object.keys(ASSET_MAP).join(", ") + "\n" +
    "  Build it from source (scripts/build.sh on POSIX, scripts/build.bat on Windows)\n" +
    "  and/or set LVGL_SIM_PATH to point to your own " + simBinaryName + " binary."
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

/**
 * Read the package's own version so we can pin to the matching release tag.
 */
function getPackageVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf-8"));
    return pkg.version;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the release to download. Prefer the tag matching this package's
 * version (so old npm versions never pull incompatible future assets); on
 * any failure, fall back to the latest release.
 */
async function resolveRelease() {
  const version = getPackageVersion();
  if (version) {
    try {
      const json = await httpsGet(
        `https://api.github.com/repos/${REPO}/releases/tags/v${version}`
      );
      console.log(`[lvgl-mcp] Using release v${version}.`);
      return JSON.parse(json);
    } catch (err) {
      console.log(
        `[lvgl-mcp] Release v${version} not found (${err.message}); falling back to latest.`
      );
    }
  }
  const json = await httpsGet(`https://api.github.com/repos/${REPO}/releases/latest`);
  return JSON.parse(json);
}

try {
  const release = await resolveRelease();

  // Find the platform asset
  const asset = release.assets?.find((a) => a.name === ASSET_NAME);
  if (!asset) {
    console.warn(
      `[lvgl-mcp] WARNING: Could not find ${ASSET_NAME} in release ${release.tag_name}.\n` +
      `  Available assets: ${release.assets?.map((a) => a.name).join(", ") || "none"}\n` +
      "  Build the simulator from source or set LVGL_SIM_PATH manually."
    );
    process.exit(0);
  }

  const downloadUrl = asset.browser_download_url;
  const archivePath = join(packageDir, ASSET_NAME);
  const extractDir = join(packageDir, "_release_tmp");

  // Download
  console.log(`[lvgl-mcp] Downloading ${release.tag_name} (${(asset.size / 1024 / 1024).toFixed(1)} MB)...`);
  await downloadFile(downloadUrl, archivePath);
  console.log("[lvgl-mcp] Download complete.");

  // Extract
  console.log("[lvgl-mcp] Extracting...");
  mkdirSync(extractDir, { recursive: true });

  if (isWindows) {
    // PowerShell Expand-Archive is available on all Windows 10+.
    execSync(
      `powershell -NoProfile -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${extractDir}' -Force"`,
      { stdio: "pipe", timeout: 60000 }
    );
  } else {
    // tar is available on Linux/macOS.
    execFileSync("tar", ["-xzf", archivePath, "-C", extractDir], {
      stdio: "pipe",
      timeout: 60000,
    });
  }

  // Move simulator/ directory to package root
  const extractedSimDir = join(extractDir, "simulator");
  if (existsSync(extractedSimDir)) {
    if (existsSync(simulatorDir)) {
      rmSync(simulatorDir, { recursive: true, force: true });
    }
    renameSync(extractedSimDir, simulatorDir);
    console.log("[lvgl-mcp] Simulator installed successfully.");
  } else {
    // Check if files are one level deeper (archive might have a root folder)
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
      console.warn("[lvgl-mcp] WARNING: Could not find simulator/ in the release archive.");
      process.exit(0);
    }
  }

  // Clean up
  rmSync(archivePath, { force: true });
  rmSync(extractDir, { recursive: true, force: true });

  // On POSIX, make sure the binary is executable (defensive — tar usually
  // preserves the mode, but archives can strip it).
  if (!isWindows) {
    for (const candidate of [
      join(simulatorDir, "build", simBinaryName),
      join(simulatorDir, simBinaryName),
    ]) {
      if (existsSync(candidate)) {
        try {
          chmodSync(candidate, 0o755);
        } catch {
          /* best effort */
        }
      }
    }
  }

  // Verify
  if (existsSync(join(simulatorDir, "build", simBinaryName))) {
    console.log(`[lvgl-mcp] Verified: ${simBinaryName} is present.`);
  } else if (existsSync(join(simulatorDir, simBinaryName))) {
    console.log(`[lvgl-mcp] Verified: ${simBinaryName} is present.`);
  } else {
    console.warn(
      `[lvgl-mcp] WARNING: ${simBinaryName} not found after extraction.\n` +
      "  The simulator may need to be built manually."
    );
  }

} catch (err) {
  console.error(`[lvgl-mcp] ERROR during simulator download: ${err.message}`);
  console.error(
    "  You can manually download the simulator from:\n" +
    `  https://github.com/${REPO}/releases/latest\n` +
    `  Extract it and set LVGL_SIM_PATH to the path of ${simBinaryName}`
  );
  // Don't fail the install — the MCP server can still work if the user
  // provides the simulator path manually
  process.exit(0);
}
