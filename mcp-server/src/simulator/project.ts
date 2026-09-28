/**
 * Multi-file projects (lvgl_render_project) and the ESP-IDF shim headers.
 *
 * Security model: inline file paths must be relative without ".." (they are
 * written below a staging directory the server owns); a `root` directory
 * must realpath-resolve inside one of the allowed roots (MCP client roots,
 * LVGL_PROJECT_ROOT, or the server's working directory unless that is the
 * filesystem root or the home directory). Symlinks are not followed when
 * collecting sources.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export const SOURCE_EXTENSIONS = [".c", ".cpp", ".cc", ".cxx"];
export const HEADER_EXTENSIONS = [".h", ".hpp", ".hh", ".hxx", ".inc"];
/** Directory names never searched for sources in `root` mode. */
export const EXCLUDED_DIRS = new Set([
  "build",
  "cmake-build-debug",
  "cmake-build-release",
  "CMakeFiles",
  ".git",
  ".svn",
  ".hg",
  "node_modules",
  "managed_components",
  ".pio",
  ".vscode",
  ".idea",
  ".cache",
  "dist",
  "__pycache__",
]);

export const MAX_PROJECT_FILES = 1000;
export const MAX_PROJECT_SOURCES = 500;
export const MAX_PROJECT_BYTES = 32 * 1024 * 1024;
const MAX_WALK_DEPTH = 16;

export class ProjectPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectPathError";
  }
}

/**
 * Validate and normalise a project-relative path (inline file path,
 * include dir). Returns it with forward slashes. Rejects absolute paths,
 * drive letters, UNC paths, ".." segments, control characters and ';'
 * (the CMake list separator).
 */
export function validateRelativePath(p: string, what = "path"): string {
  if (typeof p !== "string" || p.trim() === "") throw new ProjectPathError(`${what} must not be empty`);
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f;]/.test(p)) throw new ProjectPathError(`${what} "${p}" contains a control character or ';'`);
  if (/^[\\/]/.test(p) || /^[A-Za-z]:/.test(p) || path.isAbsolute(p)) {
    throw new ProjectPathError(`${what} "${p}" must be relative to the project root (no absolute paths)`);
  }
  const segs = p.replace(/\\/g, "/").split("/").filter((s) => s !== "" && s !== ".");
  if (segs.length === 0) throw new ProjectPathError(`${what} "${p}" does not name a file`);
  if (segs.some((s) => s === "..")) throw new ProjectPathError(`${what} "${p}" must not contain ".." segments`);
  return segs.join("/");
}

/** True when `child` is `parent` or lies below it (both absolute, already resolved). */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Directories a `root` project may live in. Client roots come first; the
 * working directory counts only when it is neither the filesystem root nor
 * the home directory (MCP clients often start servers there).
 */
export function defaultAllowedRoots(
  clientRoots: string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  home: string = os.homedir()
): string[] {
  const out = [...clientRoots];
  if (env["LVGL_PROJECT_ROOT"]) out.push(path.resolve(env["LVGL_PROJECT_ROOT"]));
  const c = path.resolve(cwd);
  if (path.parse(c).root !== c && path.resolve(home) !== c) out.push(c);
  return out;
}

/** Realpath `requested` and require it to be a directory inside one of `allowed`. */
export async function resolveProjectRoot(requested: string, allowed: string[]): Promise<string> {
  if (!requested || !path.isAbsolute(requested)) {
    throw new ProjectPathError(`root must be an absolute directory path (got "${requested}")`);
  }
  let real: string;
  try {
    real = await fs.realpath(requested);
  } catch {
    throw new ProjectPathError(`root directory does not exist: ${requested}`);
  }
  const st = await fs.stat(real);
  if (!st.isDirectory()) throw new ProjectPathError(`root is not a directory: ${requested}`);
  const allowedReal: string[] = [];
  for (const a of allowed) {
    try {
      allowedReal.push(await fs.realpath(a));
    } catch {
      /* ignore roots that do not exist */
    }
  }
  if (!allowedReal.some((a) => isInside(a, real))) {
    const list = allowedReal.length ? allowedReal.join(", ") : "(none)";
    throw new ProjectPathError(
      `root ${requested} is outside the allowed directories: ${list}. Allowed are the MCP client's roots, LVGL_PROJECT_ROOT and the server's working directory; or pass the files inline with \`files\`.`
    );
  }
  return real;
}

/** Glob (relative, forward slashes): `**` any depth, `*` within a segment, `?` one character. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  const g = glob.replace(/\\/g, "/").replace(/^\.\//, "");
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === "*") {
      if (g[i + 1] === "*") {
        i++;
        if (g[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  // A pattern without "/" matches the base name anywhere ("main.c", "*_test.c").
  return g.includes("/") ? new RegExp(`^${re}$`) : new RegExp(`(?:^|/)${re}$`);
}

export interface CollectedProject {
  /** Absolute source paths (.c/.cpp), sorted. */
  sources: string[];
  /** Project-relative paths of those sources. */
  relSources: string[];
  /** Absolute directories that contain headers (for the include path). */
  headerDirs: string[];
  /** Project-relative paths of the headers. */
  relHeaders: string[];
  hasCxx: boolean;
}

/** Walk `root` (no symlinks, excluded dirs skipped) and collect sources and header dirs. */
export async function collectSources(root: string, exclude: string[] = []): Promise<CollectedProject> {
  const ex = exclude.map(globToRegExp);
  const sources: string[] = [];
  const headerDirs = new Set<string>();
  const relHeaders: string[] = [];
  let files = 0;
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (depth > MAX_WALK_DEPTH) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (EXCLUDED_DIRS.has(e.name) || e.name.startsWith("build-") || ex.some((x) => x.test(r) || x.test(r + "/"))) continue;
        await walk(path.join(dir, e.name), r, depth + 1);
      } else if (e.isFile()) {
        if (++files > MAX_PROJECT_FILES * 10) throw new ProjectPathError(`project has more than ${MAX_PROJECT_FILES * 10} files; point root at the UI directory`);
        const ext = path.extname(e.name).toLowerCase();
        if (ex.some((x) => x.test(r))) continue;
        if (SOURCE_EXTENSIONS.includes(ext)) sources.push(r);
        else if (HEADER_EXTENSIONS.includes(ext)) {
          headerDirs.add(dir);
          relHeaders.push(r);
        }
      }
    }
  };
  await walk(root, "", 0);
  if (sources.length === 0) {
    throw new ProjectPathError(`no .c/.cpp sources found under ${root}${exclude.length ? " (after exclude)" : ""}`);
  }
  if (sources.length > MAX_PROJECT_SOURCES) {
    throw new ProjectPathError(`project has ${sources.length} sources (max ${MAX_PROJECT_SOURCES}); point root at the UI directory or use exclude`);
  }
  if (sources.some((s) => s.includes(";"))) throw new ProjectPathError("source paths must not contain ';'");
  sources.sort();
  return {
    sources: sources.map((s) => path.join(root, s)),
    relSources: sources,
    headerDirs: [...headerDirs].sort().slice(0, 64),
    relHeaders,
    hasCxx: sources.some((s) => path.extname(s).toLowerCase() !== ".c"),
  };
}

/**
 * Write inline files below `dir` (created if needed): unchanged files are
 * left alone (keeps mtimes for incremental builds), files from an earlier
 * project that are not part of this one are deleted.
 */
export async function stageInlineFiles(dir: string, files: Array<{ path: string; content: string }>): Promise<string[]> {
  if (files.length > MAX_PROJECT_FILES) throw new ProjectPathError(`too many files (${files.length}, max ${MAX_PROJECT_FILES})`);
  const total = files.reduce((s, f) => s + Buffer.byteLength(f.content, "utf-8"), 0);
  if (total > MAX_PROJECT_BYTES) throw new ProjectPathError(`inline files total ${total} bytes (max ${MAX_PROJECT_BYTES})`);
  const rels = files.map((f) => validateRelativePath(f.path, "file path"));
  const lower = new Set<string>();
  for (const r of rels) {
    const k = r.toLowerCase();
    if (lower.has(k)) throw new ProjectPathError(`duplicate file path "${r}"`);
    lower.add(k);
  }
  await fs.mkdir(dir, { recursive: true });
  const base = await fs.realpath(dir);
  const wanted = new Set<string>();
  for (let i = 0; i < files.length; i++) {
    const rel = rels[i]!;
    const abs = path.join(base, ...rel.split("/"));
    if (!isInside(base, abs)) throw new ProjectPathError(`file path "${rel}" escapes the project directory`);
    wanted.add(abs);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    let same = false;
    try {
      same = (await fs.readFile(abs, "utf-8")) === files[i]!.content;
    } catch {
      /* new file */
    }
    if (!same) await fs.writeFile(abs, files[i]!.content, "utf-8");
  }
  // Remove stale files (and then empty directories) from earlier projects.
  const prune = async (d: string): Promise<boolean> => {
    let empty = true;
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (await prune(p)) await fs.rmdir(p).catch(() => undefined);
        else empty = false;
      } else if (!wanted.has(p)) await fs.rm(p, { force: true });
      else empty = false;
    }
    return empty;
  };
  await prune(base);
  return rels;
}

/** C identifier check for `entry`. */
export function isCIdentifier(s: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(s);
}

/** "NAME" or "NAME=value" (no ';' or newlines: the value goes into a CMake list). */
export function isValidDefine(d: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*(=[^;\r\n]*)?$/.test(d) && d.length <= 256;
}

/** user_code.c for project mode: create_ui() calls the project's entry function. */
export function entryWrapperSource(entry: string, espShims: boolean): string {
  if (!isCIdentifier(entry)) throw new ProjectPathError(`entry "${entry}" is not a C identifier`);
  const lines = ["/* Generated by lvgl-mcp-server: project mode entry wrapper */"];
  if (espShims) lines.push(...ESP_SHIM_PRELUDE);
  lines.push('#include "lvgl.h"', "");
  if (entry === "create_ui") {
    lines.push("/* The project defines create_ui() itself. */", "typedef int lvgl_sim_project_mode_t;", "");
  } else {
    lines.push(
      `void ${entry}(void); /* must have C linkage (extern "C" in C++ files) */`,
      "",
      "void create_ui(void)",
      "{",
      `    ${entry}();`,
      "}",
      ""
    );
  }
  return lines.join("\n");
}

/** Lines prepended to user_code.c when ESP-IDF shims are on (esp_shim.h is simulator/templates/esp_shim.h). */
export const ESP_SHIM_PRELUDE = ["#ifndef LVGL_SIM_ESP_SHIMS", "#define LVGL_SIM_ESP_SHIMS 1", "#endif", '#include "esp_shim.h"'];

/** Prepend the shim prelude to a complete C file, keeping its line numbers. */
export function withEspShims(source: string, fileName: string): string {
  return [...ESP_SHIM_PRELUDE, `#line 1 "${fileName}"`, source].join("\n");
}

/**
 * Stub headers for common ESP-IDF includes. Each maps onto the simulator's
 * esp_shim.h (contract section 4); a few things esp_shim.h does not cover
 * (FreeRTOS mutexes/queues, esp_lvgl_port locking) are no-op stand-ins here.
 */
export const ESP_IDF_STUB_HEADERS: Record<string, string> = {
  "esp_log.h": "",
  "esp_err.h": "",
  "esp_timer.h": "",
  "esp_system.h": "",
  "esp_check.h": "",
  "sdkconfig.h": "",
  "freertos/FreeRTOS.h": "",
  "freertos/task.h": "",
  "freertos/semphr.h": `
#ifndef LVGL_SIM_SEMPHR_STUB
#define LVGL_SIM_SEMPHR_STUB
typedef void *SemaphoreHandle_t;
#define xSemaphoreCreateMutex() ((SemaphoreHandle_t)1)
#define xSemaphoreCreateRecursiveMutex() ((SemaphoreHandle_t)1)
#define xSemaphoreCreateBinary() ((SemaphoreHandle_t)1)
#define xSemaphoreTake(s, t) ((void)(s), (void)(t), 1)
#define xSemaphoreGive(s) ((void)(s), 1)
#define xSemaphoreTakeRecursive(s, t) ((void)(s), (void)(t), 1)
#define xSemaphoreGiveRecursive(s) ((void)(s), 1)
#define vSemaphoreDelete(s) ((void)(s))
#ifndef pdTRUE
#define pdTRUE 1
#define pdFALSE 0
#define pdPASS 1
#define pdFAIL 0
#endif
#endif
`,
  "freertos/queue.h": `
#ifndef LVGL_SIM_QUEUE_STUB
#define LVGL_SIM_QUEUE_STUB
typedef void *QueueHandle_t;
#define xQueueCreate(n, sz) ((QueueHandle_t)1)
#define xQueueSend(q, item, t) ((void)(q), (void)(item), (void)(t), 1)
#define xQueueReceive(q, item, t) ((void)(q), (void)(item), (void)(t), 0)
#endif
`,
  "esp_lvgl_port.h": `
#ifndef LVGL_SIM_LVGL_PORT_STUB
#define LVGL_SIM_LVGL_PORT_STUB
#include <stdbool.h>
#include <stdint.h>
#include "lvgl.h"
static inline bool lvgl_port_lock(uint32_t timeout_ms) { (void)timeout_ms; return true; }
static inline void lvgl_port_unlock(void) { }
#endif
`,
};

/** Write the ESP-IDF stub headers into `dir` (idempotent). */
export async function writeEspShimStubs(dir: string): Promise<void> {
  for (const [rel, body] of Object.entries(ESP_IDF_STUB_HEADERS)) {
    const abs = path.join(dir, ...rel.split("/"));
    const content = `/* Generated by lvgl-mcp-server (esp_shims): ESP-IDF stand-in for the simulator */\n#pragma once\n#include "esp_shim.h"\n${body}`;
    await fs.mkdir(path.dirname(abs), { recursive: true });
    let same = false;
    try {
      same = (await fs.readFile(abs, "utf-8")) === content;
    } catch {
      /* new */
    }
    if (!same) await fs.writeFile(abs, content, "utf-8");
  }
}
