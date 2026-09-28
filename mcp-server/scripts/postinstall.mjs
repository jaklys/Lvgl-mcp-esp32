#!/usr/bin/env node
/**
 * postinstall.mjs - installs the LVGL simulator sources that match this
 * package version from the GitHub release `v<version>`.
 *
 * Runs after `npm install lvgl-mcp-server`. Uses only Node.js built-ins.
 *
 *  - Skipped inside the git checkout (../../simulator/CMakeLists.txt exists),
 *    when CI is set (unless LVGL_FORCE_DOWNLOAD=1), when LVGL_SKIP_DOWNLOAD=1
 *    or when LVGL_SIM_PATH is set.
 *  - Downloads SHA256SUMS.txt first, then the platform archive, and refuses
 *    to install an archive whose SHA-256 does not match.
 *  - Never falls back to "latest": the simulator must match the server.
 *  - Honors HTTPS_PROXY / https_proxy / npm_config_https_proxy and NO_PROXY.
 *  - Logs only to stderr. Always exits 0 so `npm install` itself never fails;
 *    on failure it prints the manual fix instead.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import https from "node:https";
import { dirname, join, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import tls from "node:tls";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = "jaklys/Lvgl-mcp-esp32";
const USER_AGENT = "lvgl-mcp-server-postinstall";

const CONNECT_TIMEOUT_MS = 30_000; // TCP/TLS/proxy handshake
const IDLE_TIMEOUT_MS = 60_000; // no bytes received for this long -> abort
const MAX_REDIRECTS = 5;
const MAX_ATTEMPTS = 3;

// Platform -> release asset. The archives are platform-neutral source trees
// (simulator + LVGL sources, no binaries): the simulator is compiled on the
// user's machine on the first render. There is one archive per tested OS; the
// macOS archive is built and tested on Apple Silicon and also serves Intel
// Macs (same sources; the local clang picks the architecture).
export const ASSETS = {
  "win32-x64": "lvgl-mcp-esp32-windows-x64.zip",
  "linux-x64": "lvgl-mcp-esp32-linux-x64.tar.gz",
  "darwin-arm64": "lvgl-mcp-esp32-macos.tar.gz",
  "darwin-x64": "lvgl-mcp-esp32-macos.tar.gz",
  // Same source tree as linux-x64: nothing in it is x64-specific.
  "linux-arm64": "lvgl-mcp-esp32-linux-x64.tar.gz",
};
// Platforms whose archive should work but that no CI job exercises.
export const UNTESTED_PLATFORMS = new Set(["linux-arm64"]);

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(__dirname, "..");
const simulatorDir = join(packageDir, "simulator");
const versionFile = join(simulatorDir, ".version");

// ── Logging (stderr only; stdout belongs to npm) ─────────────────────

function log(msg) {
  process.stderr.write(`[lvgl-mcp] ${msg}\n`);
}

function releaseBaseUrl(version) {
  return `https://github.com/${REPO}/releases/download/v${version}`;
}

function buildFromSourceSteps(version) {
  return [
    "  Build the simulator from source instead:",
    `    git clone --recursive --branch v${version} https://github.com/${REPO}.git`,
    "    cd Lvgl-mcp-esp32",
    "    ./scripts/setup.sh                                   (Linux/macOS)",
    "    powershell -ExecutionPolicy Bypass -File scripts\\setup.ps1   (Windows)",
    "  then point the server at it:  LVGL_SIM_PATH=<checkout>/simulator",
    "  A C/C++ compiler, CMake >= 3.16 and Ninja (or Make) are required in",
    "  every case, because each render compiles your code against LVGL.",
  ].join("\n");
}

function printManualFix(reason, version, asset) {
  const base = releaseBaseUrl(version);
  const lines = [
    "",
    "[lvgl-mcp] ============================================================",
    "[lvgl-mcp] ERROR: the LVGL simulator could not be installed.",
    `[lvgl-mcp] Reason: ${reason}`,
    "[lvgl-mcp] The MCP server itself is installed, but it cannot render",
    "[lvgl-mcp] until a simulator is available. To fix it manually:",
    "",
    `  1. Download ${asset} and SHA256SUMS.txt from`,
    `       ${base}/`,
    "  2. Verify the checksum:",
    "       sha256sum --ignore-missing -c SHA256SUMS.txt          (Linux)",
    `       grep ' ${asset}$' SHA256SUMS.txt | shasum -a 256 -c   (macOS)`,
    `       (Get-FileHash ${asset}).Hash   (PowerShell, compare by hand)`,
    "  3. Extract it and set LVGL_SIM_PATH to the extracted simulator/ folder",
    "     in your MCP server config.",
    "",
    "  Or retry this step (e.g. after fixing the proxy):",
    "       npm rebuild lvgl-mcp-server",
    "",
    buildFromSourceSteps(version),
    "[lvgl-mcp] ============================================================",
    "",
  ];
  process.stderr.write(lines.join("\n"));
}

// ── Proxy handling ───────────────────────────────────────────────────

export function proxyFor(targetUrl, env = process.env) {
  const target = new URL(targetUrl);
  const raw =
    env.HTTPS_PROXY ||
    env.https_proxy ||
    env.npm_config_https_proxy ||
    env.npm_config_proxy ||
    "";
  if (!raw) return null;

  const noProxy = (env.NO_PROXY || env.no_proxy || env.npm_config_noproxy || "")
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const host = target.hostname.toLowerCase();
  for (const entry of noProxy) {
    if (entry === "*") return null;
    const bare = entry.replace(/^\*?\./, "").replace(/:\d+$/, "");
    if (host === bare || host.endsWith(`.${bare}`)) return null;
  }

  try {
    return new URL(raw.includes("://") ? raw : `http://${raw}`);
  } catch {
    throw new Error(`invalid proxy URL in environment: ${raw}`);
  }
}

/** Opens a CONNECT tunnel through `proxy` and resolves with a TLS socket. */
function connectViaProxy(proxy, target) {
  return new Promise((resolvePromise, reject) => {
    const port = Number(target.port) || 443;
    const headers = { Host: `${target.hostname}:${port}`, "User-Agent": USER_AGENT };
    if (proxy.username) {
      const cred = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
      headers["Proxy-Authorization"] = `Basic ${Buffer.from(cred).toString("base64")}`;
    }
    const mod = proxy.protocol === "https:" ? https : http;
    const req = mod.request({
      host: proxy.hostname,
      port: Number(proxy.port) || (proxy.protocol === "https:" ? 443 : 80),
      method: "CONNECT",
      path: `${target.hostname}:${port}`,
      headers,
      agent: false,
    });
    const timer = setTimeout(() => {
      req.destroy(new Error(`proxy CONNECT to ${proxy.host} timed out`));
    }, CONNECT_TIMEOUT_MS);
    req.once("connect", (res, socket) => {
      clearTimeout(timer);
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`proxy ${proxy.host} refused CONNECT ${target.hostname}: HTTP ${res.statusCode}`));
        return;
      }
      const tlsSocket = tls.connect({ socket, servername: target.hostname });
      tlsSocket.once("secureConnect", () => resolvePromise(tlsSocket));
      tlsSocket.once("error", reject);
    });
    req.once("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`proxy ${proxy.host}: ${err.message}`));
    });
    req.end();
  });
}

// ── HTTP GET with redirects, timeouts and proxy ──────────────────────

class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} for ${url}`);
    this.status = status;
    this.retryable = status === 429 || status >= 500;
  }
}

async function openOnce(url) {
  const target = new URL(url);
  if (target.protocol !== "https:") throw new Error(`refusing non-HTTPS URL ${url}`);
  const proxy = proxyFor(url);
  const tunnel = proxy ? await connectViaProxy(proxy, target) : null;

  return new Promise((resolvePromise, reject) => {
    const req = https.request(
      target,
      {
        method: "GET",
        headers: { "User-Agent": USER_AGENT, Accept: "application/octet-stream, */*" },
        // No agent + createConnection => Node uses the tunnelled TLS socket as-is.
        ...(tunnel ? { createConnection: () => tunnel } : {}),
      },
      (res) => resolvePromise(res)
    );
    req.setTimeout(CONNECT_TIMEOUT_MS, () =>
      req.destroy(new Error(`no response from ${target.host} within ${CONNECT_TIMEOUT_MS / 1000} s`))
    );
    req.once("error", reject);
    req.end();
  });
}

/** Resolves with a 200 response stream (caller must consume it). */
async function httpGet(url) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await openOnce(current);
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      current = new URL(res.headers.location, current).toString();
      continue;
    }
    if (status !== 200) {
      res.resume();
      throw new HttpError(status, url);
    }
    // Idle timeout while streaming the body.
    res.socket?.setTimeout(IDLE_TIMEOUT_MS, () =>
      res.destroy(new Error(`download stalled for ${IDLE_TIMEOUT_MS / 1000} s`))
    );
    return res;
  }
  throw new Error(`too many redirects (> ${MAX_REDIRECTS}) for ${url}`);
}

async function withRetry(what, fn) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const retryable = !(err instanceof HttpError) || err.retryable;
      if (!retryable || attempt === MAX_ATTEMPTS) break;
      const delay = 1000 * 2 ** (attempt - 1);
      log(`${what} failed (${err.message}); retrying in ${delay / 1000} s...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

export async function fetchText(url) {
  return withRetry(`GET ${url}`, async () => {
    const res = await httpGet(url);
    const chunks = [];
    let size = 0;
    for await (const chunk of res) {
      size += chunk.length;
      if (size > 1024 * 1024) throw new Error(`${url} is unexpectedly large`);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  });
}

/** Streams `url` to `dest` via `dest.part`; resolves with the sha256 hex. */
export async function downloadFile(url, dest) {
  return withRetry(`download ${url}`, async () => {
    const part = `${dest}.part`;
    rmSync(part, { force: true });
    const res = await httpGet(url);
    const expectedLen = Number(res.headers["content-length"]) || 0;
    const hash = createHash("sha256");
    let received = 0;
    let lastReport = Date.now();
    const meter = new Transform({
      transform(chunk, _enc, cb) {
        hash.update(chunk);
        received += chunk.length;
        if (Date.now() - lastReport > 5000) {
          lastReport = Date.now();
          const pct = expectedLen ? ` (${Math.floor((received / expectedLen) * 100)}%)` : "";
          log(`  ${(received / 1048576).toFixed(1)} MB${pct}`);
        }
        cb(null, chunk);
      },
    });
    res.on("error", (err) => meter.destroy(err));
    try {
      await pipeline(res, meter, createWriteStream(part));
    } catch (err) {
      rmSync(part, { force: true });
      throw err;
    }
    if (expectedLen && received !== expectedLen) {
      rmSync(part, { force: true });
      throw new Error(`truncated download: got ${received} of ${expectedLen} bytes`);
    }
    renameSync(part, dest);
    return hash.digest("hex");
  });
}

// ── Checksums ────────────────────────────────────────────────────────

export function parseSha256Sums(text) {
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (m) map.set(m[2].trim(), m[1].toLowerCase());
  }
  return map;
}

// ── Extraction ───────────────────────────────────────────────────────

function findTar() {
  if (process.platform === "win32") {
    // Use the bsdtar that ships with Windows 10 1803+; a GNU tar from Git for
    // Windows earlier on PATH cannot read .zip and misparses "C:\" paths.
    const sys = join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
    return existsSync(sys) ? sys : null;
  }
  return "tar";
}

export function extractArchive(archive, destDir) {
  mkdirSync(destDir, { recursive: true });
  const tar = findTar();
  if (tar) {
    try {
      execFileSync(tar, ["-xf", archive, "-C", destDir], { stdio: ["ignore", "ignore", "pipe"], timeout: 300_000 });
      return;
    } catch (err) {
      if (process.platform !== "win32" || err.code !== "ENOENT") {
        const stderr = err.stderr ? String(err.stderr).trim() : err.message;
        throw new Error(`tar failed to extract ${archive}: ${stderr}`);
      }
    }
  }
  if (process.platform !== "win32") throw new Error("tar not found on PATH");
  // Fallback: PowerShell Expand-Archive. Paths are passed through environment
  // variables so no quoting/escaping of user paths is needed.
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath $env:LVGL_ARCHIVE -DestinationPath $env:LVGL_DEST -Force",
    ],
    {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 300_000,
      env: { ...process.env, LVGL_ARCHIVE: archive, LVGL_DEST: destDir },
    }
  );
}

function findExtractedSimulator(root) {
  const direct = join(root, "simulator");
  if (existsSync(join(direct, "CMakeLists.txt"))) return direct;
  for (const entry of readdirSync(root)) {
    const nested = join(root, entry, "simulator");
    if (existsSync(join(nested, "CMakeLists.txt"))) return nested;
  }
  return null;
}

// ── Main ─────────────────────────────────────────────────────────────

function readPackageVersion() {
  const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  if (!pkg.version) throw new Error("package.json has no version");
  return pkg.version;
}

function isTruthyEnv(v) {
  return !!v && !/^(0|false|no|off)$/i.test(v.trim());
}

function skipReason(version) {
  const checkout = resolve(__dirname, "..", "..", "simulator", "CMakeLists.txt");
  if (existsSync(checkout)) {
    return "running inside the git checkout; the server uses ../simulator (built from source)";
  }
  if (isTruthyEnv(process.env.LVGL_SKIP_DOWNLOAD)) return "LVGL_SKIP_DOWNLOAD is set";
  if (process.env.LVGL_SIM_PATH) return `LVGL_SIM_PATH is set (${process.env.LVGL_SIM_PATH})`;
  if (isTruthyEnv(process.env.CI) && !isTruthyEnv(process.env.LVGL_FORCE_DOWNLOAD)) {
    return "CI is set (set LVGL_FORCE_DOWNLOAD=1 to download anyway)";
  }
  try {
    if (
      existsSync(join(simulatorDir, "CMakeLists.txt")) &&
      readFileSync(versionFile, "utf8").trim() === version
    ) {
      return `simulator v${version} already installed`;
    }
  } catch {
    /* no .version -> (re)install */
  }
  return null;
}

// `baseUrl` is for tests only; installs always use the pinned release URL.
export async function install({ version, asset, targetDir = simulatorDir, baseUrl }) {
  const base = baseUrl ?? releaseBaseUrl(version);
  const workDir = join(packageDir, ".lvgl-download");
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });

  try {
    log(`Fetching ${base}/SHA256SUMS.txt`);
    let sums;
    try {
      sums = parseSha256Sums(await fetchText(`${base}/SHA256SUMS.txt`));
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) {
        throw new Error(
          `release v${version} has no SHA256SUMS.txt (HTTP 404) - either the release does not exist ` +
            "or it predates checksum publishing; refusing to install an unverified archive"
        );
      }
      throw err;
    }
    const expected = sums.get(asset);
    if (!expected) throw new Error(`SHA256SUMS.txt of v${version} has no entry for ${asset}`);

    const archive = join(workDir, asset);
    log(`Downloading ${base}/${asset}`);
    const actual = await downloadFile(`${base}/${asset}`, archive);
    if (actual !== expected) {
      throw new Error(`checksum mismatch for ${asset}: expected ${expected}, got ${actual}`);
    }
    log(`SHA-256 verified (${actual.slice(0, 16)}...), ${(statSync(archive).size / 1048576).toFixed(1)} MB`);

    const extractDir = join(workDir, "extract");
    log("Extracting...");
    extractArchive(archive, extractDir);
    const extracted = findExtractedSimulator(extractDir);
    if (!extracted) throw new Error(`${asset} does not contain simulator/CMakeLists.txt`);

    writeFileSync(join(extracted, ".version"), `${version}\n`);
    for (const bin of ["lvgl_sim", join("build", "lvgl_sim")]) {
      const p = join(extracted, bin);
      if (existsSync(p)) {
        try {
          chmodSync(p, 0o755);
        } catch {
          /* best effort */
        }
      }
    }

    // Swap in the new tree; keep the old one until the rename succeeded.
    const old = `${targetDir}.old`;
    rmSync(old, { recursive: true, force: true });
    if (existsSync(targetDir)) renameSync(targetDir, old);
    try {
      renameSync(extracted, targetDir);
    } catch (err) {
      if (existsSync(old)) renameSync(old, targetDir);
      throw err;
    }
    rmSync(old, { recursive: true, force: true });
    log(`Simulator v${version} installed in ${targetDir}`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

async function main() {
  let version = "unknown";
  const key = `${process.platform}-${process.arch}`;
  const asset = ASSETS[key];
  try {
    version = readPackageVersion();
    const reason = skipReason(version);
    if (reason) {
      log(`Skipping simulator download: ${reason}.`);
      return;
    }
    if (!asset) {
      log(
        `No simulator package for ${key}.\n` +
          `  Available for: ${Object.keys(ASSETS).join(", ")}.\n` +
          buildFromSourceSteps(version)
      );
      return;
    }
    if (UNTESTED_PLATFORMS.has(key)) {
      log(
        `Note: ${key} is not tested in CI. The simulator is compiled from source on the first render; ` +
          `please report problems at https://github.com/${REPO}/issues`
      );
    }
    await install({ version, asset });
  } catch (err) {
    printManualFix(err?.message ?? String(err), version, asset ?? "<platform archive>");
  }
}

// Run only when executed directly (the module can be imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
  process.exitCode = 0;
}
