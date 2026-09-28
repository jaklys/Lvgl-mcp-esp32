import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { CompilerConfig } from "./simulator/compiler.js";
import { captureVcvarsEnv } from "./simulator/msvc.js";
import { detectPrebuilt, type PrebuiltInfo } from "./simulator/prebuilt.js";
import { isWindows, resolveExecutable, runProcess } from "./simulator/process.js";

export interface DoctorReport {
  ok: boolean;
  /** Fatal problems: rendering cannot work until they are fixed. */
  problems: string[];
  /** Informational findings (tool versions, non-fatal warnings). */
  notes: string[];
}

async function firstLine(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<string | undefined> {
  return (await probe(cmd, args, env)).line;
}

/** Run `cmd args`; `line` is the first output line on success, `output` the full text either way. */
async function probe(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<{ line?: string; output: string }> {
  const res = await runProcess(cmd, args, { env, timeoutMs: 15000 });
  const output = `${res.stdout}\n${res.stderr}`.trim();
  if (res.spawnError || res.code !== 0) return { output: output || (res.spawnError?.message ?? "") };
  const text = (res.stdout || res.stderr).trim();
  return { line: text.split(/\r?\n/)[0], output };
}

type Tool = "cmake" | "ninja" | "make" | "cc";

/** How to install a missing build tool, per platform. */
export function installHint(tool: Tool, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    return {
      cmake: "e.g. winget install Kitware.CMake, or the VS 'C++ CMake tools' component",
      ninja: "winget install Ninja-build.Ninja, or VS 'C++ CMake tools'",
      make: "install ninja (recommended)",
      cc: "install Visual Studio Build Tools with the 'Desktop development with C++' workload",
    }[tool];
  }
  if (platform === "darwin") {
    return {
      cmake: "e.g. brew install cmake",
      ninja: "brew install ninja",
      make: "brew install ninja (recommended), or xcode-select --install for make",
      cc: "install the Xcode Command Line Tools: xcode-select --install",
    }[tool];
  }
  return {
    cmake: "e.g. apt install cmake",
    ninja: "apt install ninja-build",
    make: "install ninja-build (recommended) or make",
    cc: "install gcc or clang, e.g. apt install build-essential",
  }[tool];
}

/** macOS: /usr/bin/cc exists even without the Command Line Tools and fails like this. */
const XCRUN_MISSING_RE = /invalid active developer path|xcode-select: note|xcrun: error/i;

/**
 * Check everything needed to compile and run the simulator and describe
 * what is missing in terms a user can act on.
 */
export async function runDoctor(
  cfg: CompilerConfig,
  env: NodeJS.ProcessEnv = process.env,
  prebuilt: PrebuiltInfo = detectPrebuilt(cfg.simulatorDir)
): Promise<DoctorReport> {
  const problems: string[] = [];
  const notes: string[] = [];
  const sim = cfg.simulatorDir;

  // --- prebuilt artifacts (contract section 7) -----------------------------
  notes.push(...prebuiltNotes(prebuilt));

  // --- simulator sources -------------------------------------------------
  if (!existsSync(sim)) {
    problems.push(
      `Simulator directory not found: ${sim}. Set LVGL_SIM_PATH to a directory containing the simulator's CMakeLists.txt (or reinstall the npm package so postinstall can download it).`
    );
  } else {
    for (const rel of ["CMakeLists.txt", "main.c", path.join("templates", "user_code_wrapper.c")]) {
      if (!existsSync(path.join(sim, rel))) {
        problems.push(`Simulator file missing: ${path.join(sim, rel)} (incomplete simulator directory).`);
      }
    }
    if (!existsSync(path.join(sim, "lib", "lvgl", "lvgl.h"))) {
      const msg = `LVGL sources missing in ${path.join(sim, "lib", "lvgl")}. In a git checkout run: git submodule update --init --recursive`;
      if (prebuilt.library) notes.push(`${msg} (builds use the prebuilt library; no fallback to a source build is possible)`);
      else problems.push(msg);
    }
  }

  // --- build directory -----------------------------------------------------
  try {
    await fs.mkdir(cfg.buildDir, { recursive: true });
    await fs.access(cfg.buildDir, fs.constants.W_OK);
  } catch (err) {
    problems.push(
      `Build directory ${cfg.buildDir} is not writable (${(err as Error).message}). Set LVGL_BUILD_DIR to a writable directory.`
    );
  }

  // --- toolchain environment ----------------------------------------------
  let toolEnv: NodeJS.ProcessEnv = env;
  if (isWindows) {
    if (cfg.vcvarsallPath) {
      try {
        toolEnv = { ...env, ...(await captureVcvarsEnv(cfg.vcvarsallPath)) };
        notes.push(`MSVC environment: ${cfg.vcvarsallPath}`);
      } catch (err) {
        problems.push(`${(err as Error).message}`);
      }
    }
  }

  // --- cmake ---------------------------------------------------------------
  const cmake = resolveExecutable(cfg.cmakePath, toolEnv);
  if (!cmake) {
    problems.push(
      `CMake not found (${cfg.cmakePath}). Install CMake >= 3.16 (${installHint("cmake")}) or set CMAKE_PATH.` +
        (process.platform === "darwin" ? DARWIN_PATH_NOTE : "")
    );
  } else {
    const v = await firstLine(cmake, ["--version"], toolEnv);
    if (v) notes.push(`${v} (${cmake})`);
    else problems.push(`${cmake} --version failed; the CMake installation looks broken.`);
  }

  // --- build tool ------------------------------------------------------------
  if (cfg.generator === "Ninja") {
    const ninja = resolveExecutable(cfg.ninjaPath, toolEnv);
    if (!ninja) {
      problems.push(
        `Ninja not found (${cfg.ninjaPath}). Install ninja (${installHint("ninja")}) or set NINJA_PATH.`
      );
    } else notes.push(`ninja: ${ninja}`);
  } else if (!resolveExecutable("make", toolEnv) && !resolveExecutable("gmake", toolEnv)) {
    problems.push(`Neither ninja nor make found. ${capitalize(installHint("make"))}.`);
  }

  // --- C compiler --------------------------------------------------------------
  if (isWindows && !env["CC"]) {
    const cl = resolveExecutable("cl", toolEnv);
    if (cl) notes.push(`C compiler: ${cl}`);
    else
      problems.push(
        "MSVC C compiler (cl.exe) not found. Install Visual Studio 2022 Build Tools with the 'Desktop development with C++' workload, or set VCVARSALL_PATH to your vcvarsall.bat."
      );
  } else {
    const candidates = cfg.compilerPath ? [cfg.compilerPath] : ["cc", "gcc", "clang"];
    const found = candidates.map((c) => resolveExecutable(c, toolEnv)).find(Boolean);
    if (!found) {
      problems.push(`No C compiler found (tried ${candidates.join(", ")}). ${capitalize(installHint("cc"))}, or set CC.`);
    } else {
      const v = await probe(found, ["--version"], toolEnv);
      const why = v.output.split(/\r?\n/)[0] ?? "";
      if (v.line) notes.push(`C compiler: ${v.line} (${found})`);
      else if (XCRUN_MISSING_RE.test(v.output)) {
        // macOS: the /usr/bin/cc shim exists, but the Command Line Tools do not.
        problems.push(
          `The C compiler ${found} does not work (${why}). ${capitalize(installHint("cc", "darwin"))}, then restart the MCP client.`
        );
      } else {
        // Not fatal: some compilers (cl.exe via CC) do not understand --version.
        notes.push(`C compiler: ${found} (\`--version\` failed${why ? `: ${why}` : ""})`);
      }
    }
    if (!isWindows) {
      const cxx = (cfg.cxxCompilerPath ? [cfg.cxxCompilerPath] : ["c++", "g++", "clang++"])
        .map((c) => resolveExecutable(c, toolEnv))
        .find(Boolean);
      if (!cxx) notes.push("Warning: no C++ compiler found (c++/g++/clang++); CMake may refuse to configure a C/C++ project.");
    }
  }

  return { ok: problems.length === 0, problems, notes };
}

/** Doctor notes about the prebuilt library / simulator binary. */
export function prebuiltNotes(p: PrebuiltInfo): string[] {
  const notes: string[] = [];
  if (p.library) notes.push(`Prebuilt LVGL library: ${p.library} (builds skip compiling LVGL; falls back to a source build if it does not link)`);
  notes.push(
    p.simulator
      ? `JSON UI rendering (lvgl_render_ui) available without a toolchain: yes (prebuilt ${p.simulator})`
      : `JSON UI rendering (lvgl_render_ui) available without a toolchain: no (no prebuilt lvgl_sim for ${p.platform ?? "this platform"}${p.dir ? ` in ${p.dir}` : ""})`
  );
  return notes;
}

const DARWIN_PATH_NOTE =
  " (Also searched /opt/homebrew/bin, /usr/local/bin, /opt/local/bin and CMake.app: apps started from the Dock do not see your shell's PATH.)";

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function formatDoctorReport(r: DoctorReport): string {
  const lines: string[] = [];
  if (r.ok) lines.push("Toolchain check passed.");
  else {
    lines.push("The LVGL simulator cannot build on this machine:");
    for (const p of r.problems) lines.push(`  - ${p}`);
  }
  for (const n of r.notes) lines.push(`  * ${n}`);
  return lines.join("\n");
}
