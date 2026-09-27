import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { CompilerConfig } from "./simulator/compiler.js";
import { captureVcvarsEnv } from "./simulator/msvc.js";
import { isWindows, resolveExecutable, runProcess } from "./simulator/process.js";

export interface DoctorReport {
  ok: boolean;
  /** Fatal problems: rendering cannot work until they are fixed. */
  problems: string[];
  /** Informational findings (tool versions, non-fatal warnings). */
  notes: string[];
}

async function firstLine(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const res = await runProcess(cmd, args, { env, timeoutMs: 15000 });
  if (res.spawnError || res.code !== 0) return undefined;
  const text = (res.stdout || res.stderr).trim();
  return text.split(/\r?\n/)[0];
}

/**
 * Check everything needed to compile and run the simulator and describe
 * what is missing in terms a user can act on.
 */
export async function runDoctor(
  cfg: CompilerConfig,
  env: NodeJS.ProcessEnv = process.env
): Promise<DoctorReport> {
  const problems: string[] = [];
  const notes: string[] = [];
  const sim = cfg.simulatorDir;

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
      problems.push(
        `LVGL sources missing in ${path.join(sim, "lib", "lvgl")}. In a git checkout run: git submodule update --init --recursive`
      );
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
      `CMake not found (${cfg.cmakePath}). Install CMake >= 3.16 (${
        isWindows ? "e.g. winget install Kitware.CMake, or the VS 'C++ CMake tools' component" : "e.g. apt install cmake"
      }) or set CMAKE_PATH.`
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
        `Ninja not found (${cfg.ninjaPath}). Install ninja (${isWindows ? "winget install Ninja-build.Ninja, or VS 'C++ CMake tools'" : "apt install ninja-build"}) or set NINJA_PATH.`
      );
    } else notes.push(`ninja: ${ninja}`);
  } else if (!resolveExecutable("make", toolEnv) && !resolveExecutable("gmake", toolEnv)) {
    problems.push("Neither ninja nor make found. Install ninja-build (recommended) or make.");
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
      problems.push(
        `No C compiler found (tried ${candidates.join(", ")}). Install gcc or clang (e.g. apt install build-essential) or set CC.`
      );
    } else {
      const v = await firstLine(found, ["--version"], toolEnv);
      notes.push(`C compiler: ${v ?? found} (${found})`);
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
