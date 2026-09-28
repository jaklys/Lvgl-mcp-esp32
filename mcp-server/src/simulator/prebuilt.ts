/**
 * Prebuilt LVGL artifacts (contract section 7):
 *   <simulator>/prebuilt/<platform>/liblvgl.a | lvgl.lib   static LVGL library
 *   <simulator>/prebuilt/<platform>/include/               LVGL public headers
 *   <simulator>/prebuilt/<platform>/lvgl_sim(.exe)          simulator binary (JSON UI mode, first render)
 * Platform ids: linux-x64, windows-x64, macos-arm64, macos-x64.
 */
import { existsSync } from "node:fs";
import * as path from "node:path";

export type PlatformId = "linux-x64" | "windows-x64" | "macos-arm64" | "macos-x64";

/** Platform id for node's platform/arch, or null when no prebuilt artifacts exist for it. */
export function platformId(platform: NodeJS.Platform = process.platform, arch: string = process.arch): PlatformId | null {
  if (platform === "linux" && arch === "x64") return "linux-x64";
  if (platform === "win32" && arch === "x64") return "windows-x64";
  if (platform === "darwin" && arch === "arm64") return "macos-arm64";
  if (platform === "darwin" && arch === "x64") return "macos-x64";
  return null;
}

export interface PrebuiltInfo {
  platform: PlatformId | null;
  /** <simulator>/prebuilt/<platform> when it exists. */
  dir: string | null;
  /** Static library (liblvgl.a, liblvgl.lib or lvgl.lib) - passed to CMake as LVGL_PREBUILT_DIR=dir. */
  library: string | null;
  /** Prebuilt simulator binary. */
  simulator: string | null;
}

export const PREBUILT_LIBRARY_NAMES = ["liblvgl.a", "liblvgl.lib", "lvgl.lib"];

export function detectPrebuilt(
  simulatorDir: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  exists: (p: string) => boolean = existsSync
): PrebuiltInfo {
  const id = platformId(platform, arch);
  if (!id) return { platform: null, dir: null, library: null, simulator: null };
  const dir = path.join(simulatorDir, "prebuilt", id);
  if (!exists(dir)) return { platform: id, dir: null, library: null, simulator: null };
  const library = PREBUILT_LIBRARY_NAMES.map((n) => path.join(dir, n)).find(exists) ?? null;
  const simPath = path.join(dir, platform === "win32" ? "lvgl_sim.exe" : "lvgl_sim");
  return { platform: id, dir, library, simulator: exists(simPath) ? simPath : null };
}

/**
 * Link/configure errors that mean "the prebuilt library does not fit this
 * toolchain" (MSVC toolset/runtime mismatch, wrong architecture, PIE, LTO,
 * unreadable archive) rather than a mistake in the user's code.
 */
const MISMATCH_PATTERNS: RegExp[] = [
  /LNK2038/, // mismatch detected for '_MSC_VER' / 'RuntimeLibrary'
  /LNK1112/, // module machine type conflicts with target machine type
  /LNK1104/, // cannot open file 'lvgl.lib'
  /LNK1143|LNK1136|LNK1107/, // invalid or corrupt file
  /C1900|LNK1257/, // IL mismatch (LTCG)
  /file format not recognized|file in wrong format|could not read symbols|malformed archive/i,
  /is incompatible with|incompatible target|wrong ELF class/i,
  /building for [\w-]+ but attempting to link with file built for/i,
  /was built for newer (macOS|iOS)/i,
  /found architecture '\w+', required architecture '\w+'/i,
  /ignoring file .*liblvgl/i,
  /can not be used when making a PIE object|recompile with -fPIE|recompile with -fPIC/i,
  /plugin needed to handle lto object|lto-wrapper failed/i,
  /undefined reference to `__(?:stack_chk|isoc23_|memcpy_chk|printf_chk|sprintf_chk|fprintf_chk|snprintf_chk)/,
  /version `GLIBC_[\d.]+' not found|undefined reference to `[\w]+@GLIBC_/,
  /unresolved external symbol __(?:imp_|security_|CxxFrameHandler|std_|chkstk|GSHandlerCheck)/,
];

/**
 * True when a failed build/configure should be retried without the prebuilt
 * library: the output names the prebuilt directory/library or shows a
 * toolchain mismatch signature. Undefined LVGL symbols caused by the user
 * (e.g. lv_font_montserrat_13) do not match.
 */
export function isPrebuiltFailure(output: string, prebuiltDir: string | null): boolean {
  if (!output) return false;
  const hasError = /error|LNK\d|undefined|cannot|ld:|collect2|failed/i.test(output);
  if (!hasError) return false;
  if (prebuiltDir) {
    const norm = (s: string) => s.replace(/\\/g, "/").toLowerCase();
    const dir = norm(prebuiltDir).replace(/\/+$/, "");
    const out = norm(output);
    // The prebuilt dir shows up in compile and link command lines too (-isystem
    // <dir>/include, <dir>/liblvgl.a); require it on an error-ish line that is
    // not a compiler command line and not merely "-Werror=...": a compile
    // error in the user's code must not trigger the source-build fallback.
    for (const raw of out.split("\n")) {
      const line = raw.replace(/-w(?:no-)?error\S*/g, "");
      if (/^failed: /.test(line) || /\s[-/]c\s/.test(` ${line} `) || /\s-isystem\s/.test(line)) continue;
      if (line.includes(dir) && /error|cannot|could not|not found|invalid|incompatible|ignoring|lnk\d/.test(line)) return true;
    }
  }
  return MISMATCH_PATTERNS.some((re) => re.test(output));
}

/**
 * Decide whether the next configure should use the prebuilt library:
 * present, not disabled by an earlier fallback, and not turned off with
 * LVGL_NO_PREBUILT=1.
 */
export function usePrebuiltLibrary(info: PrebuiltInfo, disabled: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  if (disabled || !info.dir || !info.library) return false;
  const off = env["LVGL_NO_PREBUILT"];
  return !(off && off !== "0" && off.toLowerCase() !== "false");
}
