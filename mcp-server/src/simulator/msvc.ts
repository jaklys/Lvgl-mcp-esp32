import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { MAX_BUFFER } from "./process.js";

/**
 * Locate vcvarsall.bat:
 *   1. VCVARSALL_PATH env var
 *   2. vswhere.exe (latest install with the x86/x64 C++ tools)
 *   3. well-known install paths of VS 2022 / 2019
 */
export function findVcvarsall(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env["VCVARSALL_PATH"]) return env["VCVARSALL_PATH"];

  const programFilesX86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const programFiles = env["ProgramFiles"] || "C:\\Program Files";

  const vswhere = path.join(programFilesX86, "Microsoft Visual Studio", "Installer", "vswhere.exe");
  if (existsSync(vswhere)) {
    try {
      const out = execFileSync(
        vswhere,
        [
          "-latest",
          "-products",
          "*",
          "-requires",
          "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
          "-property",
          "installationPath",
        ],
        { encoding: "utf-8", windowsHide: true, timeout: 15000 }
      );
      const install = out.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
      if (install) {
        const candidate = path.join(install, "VC", "Auxiliary", "Build", "vcvarsall.bat");
        if (existsSync(candidate)) return candidate;
      }
    } catch {
      /* fall through to hard-coded paths */
    }
  }

  const editions = ["BuildTools", "Community", "Professional", "Enterprise"];
  const years = ["2022", "2019"];
  for (const year of years) {
    for (const edition of editions) {
      for (const root of [programFiles, programFilesX86]) {
        const candidate = path.join(
          root,
          "Microsoft Visual Studio",
          year,
          edition,
          "VC",
          "Auxiliary",
          "Build",
          "vcvarsall.bat"
        );
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return undefined;
}

/** Parse the output of `set` (KEY=VALUE per line) into an env object. */
export function parseSetOutput(out: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const line of out.split(/\r?\n/)) {
    // Skip cmd's hidden per-drive vars like "=C:=C:\\" (they start with '=').
    if (line.startsWith("=")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    env[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return env;
}

const envCache = new Map<string, Promise<NodeJS.ProcessEnv>>();

/**
 * Run vcvarsall.bat once and capture the resulting environment
 * (`cmd /d /s /c ""<vcvars>" x64 >nul && set"`). Cached per vcvars path.
 * The captured env is passed directly to execFile(cmake, ...) - no batch files.
 */
export function captureVcvarsEnv(vcvarsallPath: string): Promise<NodeJS.ProcessEnv> {
  let cached = envCache.get(vcvarsallPath);
  if (!cached) {
    cached = new Promise<NodeJS.ProcessEnv>((resolve, reject) => {
      execFile(
        process.env["ComSpec"] || "cmd.exe",
        ["/d", "/s", "/c", `""${vcvarsallPath}" x64 >nul && set"`],
        {
          windowsVerbatimArguments: true,
          windowsHide: true,
          maxBuffer: MAX_BUFFER,
          timeout: 120000,
        },
        (err, stdout, stderr) => {
          if (err) {
            reject(
              new Error(
                `Running vcvarsall.bat failed (${vcvarsallPath}): ${err.message}\n${stderr || ""}`.trim()
              )
            );
            return;
          }
          const env = parseSetOutput(stdout);
          if (!Object.keys(env).some((k) => k.toUpperCase() === "INCLUDE")) {
            reject(new Error(`vcvarsall.bat (${vcvarsallPath}) did not set up an MSVC environment (INCLUDE missing).`));
            return;
          }
          resolve(env);
        }
      );
    });
    // Do not cache failures - the user may fix their install without restarting.
    cached.catch(() => envCache.delete(vcvarsallPath));
    envCache.set(vcvarsallPath, cached);
  }
  return cached;
}
