/**
 * Cleaning and parsing of compiler / build-tool output.
 *
 * `cmake --build` output mixes ninja/make progress lines, full compiler
 * command lines and the actual diagnostics (ninja prints compiler output on
 * stdout, make on stderr). We strip the noise, shorten absolute paths and
 * parse gcc/clang and MSVC diagnostics into structured records.
 */

export type Severity = "error" | "warning" | "note";

export interface Diagnostic {
  file: string;
  line: number;
  col?: number;
  severity: Severity;
  message: string;
  /** Compiler-specific code, e.g. "C2065" (MSVC) or "LNK2019". */
  code?: string;
}

export interface PathShortening {
  /** Absolute build directory (user_code.c lives here). */
  buildDir: string;
  /** Absolute simulator source directory. */
  simulatorDir: string;
  /** Extra directories stripped first (project roots: keep project-relative file names). */
  stripDirs?: string[];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Build a regex matching `dir` followed by a separator, with / and \ interchangeable. */
function dirPattern(dir: string): RegExp {
  const trimmed = dir.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]+/).map(escapeRegExp);
  // Windows paths are case-insensitive; harmless on POSIX for our fixed dirs.
  return new RegExp(parts.join("[\\\\/]+") + "[\\\\/]+", "gi");
}

/**
 * Replace absolute build/simulator paths with short, stable names:
 *   <buildDir>/user_code.c      -> user_code.c
 *   <simulatorDir>/lib/lvgl/... -> lvgl/...
 *   <simulatorDir>/...          -> simulator/...
 */
export function shortenPaths(text: string, p: PathShortening): string {
  let out = text;
  // Longest first: a project staged below the build dir must lose its full prefix.
  for (const d of [...(p.stripDirs ?? [])].sort((a, b) => b.length - a.length)) {
    if (d) out = out.replace(dirPattern(d), "");
  }
  if (p.buildDir) out = out.replace(dirPattern(p.buildDir), "");
  if (p.simulatorDir) {
    out = out.replace(dirPattern(p.simulatorDir + "/lib/lvgl"), "lvgl/");
    out = out.replace(dirPattern(p.simulatorDir), "simulator/");
    // Normalise the separators of the paths we shortened.
    out = out.replace(/\b(lvgl|simulator)\/[^\s:()'"]*/g, (m) => m.replace(/\\/g, "/"));
  }
  // Object files referenced by linkers: CMakeFiles/lvgl_sim.dir/.../user_code.c.o
  out = out.replace(/CMakeFiles[\\/]+lvgl_sim\.dir[\\/]+(?:[^\s:]*[\\/]+)?(user_code\.c)\.o(?:bj)?/g, "$1");
  // Project sources: CMakeFiles/lvgl_sim.dir/<mangled path>/ui_main.c.o -> ui_main.c
  out = out.replace(/CMakeFiles[\\/]+lvgl_sim\.dir[\\/]+(?:[^\s:]*[\\/]+)?([\w.+-]+\.(?:c|cpp|cc|cxx))\.o(?:bj)?/g, "$1");
  return out;
}

const NOISE_PATTERNS: RegExp[] = [
  /^\s*\[\d+\/\d+\]\s/, // ninja progress: [3/5] Building C object ...
  /^\s*\[\s*\d+%\]\s/, // make progress: [ 50%] Building C object ...
  /^FAILED: /, // ninja failure header
  /^ninja: /, // ninja: build stopped / Entering directory / no work to do
  /^g?make(\[\d+\])?: /, // make[2]: *** ...
  /^\s*(Consolidate compiler generated dependencies|Scanning dependencies)/,
  /^Microsoft \(R\) /, // MSVC banners
  /^Copyright \(C\) Microsoft/,
  /^\s*(Creating library|Generating Code|Finished generating code)/,
  /^: && /, // ninja link command: ": && /usr/bin/cc ... && :"
  /^LINK: command /, // cmake vs_link_exe echo on MSVC
  /^cc1: some warnings being treated as errors/,
  /^\d+ (errors?|warnings?)( and \d+ (errors?|warnings?))? generated\./, // clang summary
];

/** Heuristic: a compiler / linker command line echoed by ninja or make. */
function isCommandLine(line: string): boolean {
  const t = line.trim();
  if (t.length < 20) return false;
  if (/^(\S*[\\/])?(cc|gcc|g\+\+|c\+\+|clang|clang\+\+|cl|link|ld|ar|ranlib|cmake|lib)(\.exe)?(\s|$)/i.test(t)) {
    return / -[co]\s| \/c\s| \/Fo| -o\s| \/OUT:| -E\s|-D[A-Z_]+|\/nologo| -S\s| --build\s| -E /.test(t);
  }
  if (/^"?[A-Za-z]:\\.*\.exe"?\s/i.test(t) && /\s\/(nologo|c|Fo|OUT:)/i.test(t)) return true;
  if (/^cmd\.exe \/C /i.test(t)) return true;
  return false;
}

/**
 * Strip build-tool noise from combined build output and shorten paths.
 * Keeps compiler diagnostics and their caret/context lines.
 */
export function cleanBuildOutput(raw: string, p: PathShortening): string {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    if (NOISE_PATTERNS.some((re) => re.test(line))) continue;
    if (isCommandLine(line)) continue;
    kept.push(line);
  }
  // collapse runs of blank lines and trim
  const text = kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return shortenPaths(text, p);
}

const GCC_RE =
  /^(?<file>(?:[A-Za-z]:)?[^:\n]+?):(?<line>\d+):(?:(?<col>\d+):)?\s*(?<sev>fatal error|error|warning|note):\s*(?<msg>.*)$/;
const MSVC_RE =
  /^\s*(?<file>[^\n(]+?)\((?<line>\d+)(?:,(?<col>\d+))?\)\s*:\s*(?<sev>fatal error|error|warning|note)(?:\s+(?<code>[A-Z]+\d+))?\s*:\s*(?<msg>.*)$/;
// user_code.c:(.text+0x12): undefined reference to `foo'
const GNU_LD_RE = /^(?<file>[^:\n]+?):\(\.[\w.$]+\+0x[0-9a-f]+\):\s*(?<msg>undefined reference to .*)$/;
// /usr/bin/ld: user_code.c: in function `create_ui': ... / ld: undefined reference
const LD_UNDEF_RE = /^(?:\S*ld(?:\.\w+)?|collect2|clang|cc|gcc):\s*(?:error:\s*)?(?<msg>(?:undefined (?:reference|symbol)|Undefined symbols).*)$/;
// Apple ld64 / ld-prime (macOS):
//   Undefined symbols for architecture arm64:
//     "_lv_font_montserrat_13", referenced from:
//         _create_ui in user_code.c.o
const APPLE_LD_HEADER_RE = /^Undefined symbols for architecture \S+:$/;
const APPLE_LD_SYMBOL_RE = /^\s+"_?(?<sym>[^"]+)", referenced from:$/;
const APPLE_LD_REF_RE = /^\s+_?(?<fn>\S+) in (?<obj>\S+?)(?:\.o(?:bj)?)?(?:\s|$)/;
// user_code.c.obj : error LNK2019: unresolved external symbol foo referenced in function create_ui
const MSVC_LINK_RE = /^\s*(?<file>[^\n:]+?)\s*:\s*(?<sev>fatal error|error|warning)\s+(?<code>LNK\d+)\s*:\s*(?<msg>.*)$/;

function normSeverity(s: string): Severity {
  if (s.includes("error")) return "error";
  if (s === "warning") return "warning";
  return "note";
}

function baseName(f: string): string {
  const m = /[^\\/]+$/.exec(f);
  return m ? m[0] : f;
}

/**
 * Parse gcc/clang (`file:line:col: severity: msg`), MSVC
 * (`file(line[,col]): error Cxxxx: msg`) and common linker errors into
 * structured diagnostics. Input should already be path-shortened.
 */
export function parseDiagnostics(text: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  const seen = new Set<string>();
  const push = (d: Diagnostic) => {
    const key = `${d.file}:${d.line}:${d.col ?? ""}:${d.severity}:${d.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(d);
  };
  // Apple ld: the symbol line is followed by "_fn in file.o" lines.
  let appleLd = false;
  let appleSym: Diagnostic | null = null;
  for (const rawLine of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = rawLine.trimEnd();
    if (APPLE_LD_HEADER_RE.test(line)) {
      appleLd = true;
      continue;
    }
    if (appleLd) {
      const sym = APPLE_LD_SYMBOL_RE.exec(line);
      if (sym?.groups) {
        appleSym = { file: "", line: 0, severity: "error", message: `undefined symbol '${sym.groups.sym}'` };
        push(appleSym);
        continue;
      }
      const ref = APPLE_LD_REF_RE.exec(line);
      if (ref?.groups && appleSym) {
        if (!appleSym.file) {
          appleSym.file = baseName(ref.groups.obj);
          appleSym.message += ` referenced from ${ref.groups.fn}`;
        }
        continue;
      }
      if (!/^\s/.test(line)) appleLd = false;
      appleSym = null;
    }
    let m = MSVC_RE.exec(line);
    if (m?.groups) {
      const g = m.groups;
      push({
        file: g.file.trim(),
        line: Number(g.line),
        ...(g.col ? { col: Number(g.col) } : {}),
        severity: normSeverity(g.sev),
        message: g.msg.trim(),
        ...(g.code ? { code: g.code } : {}),
      });
      continue;
    }
    m = MSVC_LINK_RE.exec(line);
    if (m?.groups) {
      const g = m.groups;
      push({
        file: baseName(g.file.trim()).replace(/\.obj$/i, ""),
        line: 0,
        severity: normSeverity(g.sev),
        message: g.msg.trim(),
        code: g.code,
      });
      continue;
    }
    m = GNU_LD_RE.exec(line);
    if (m?.groups) {
      push({
        file: baseName(m.groups.file).replace(/\.o$/, ""),
        line: 0,
        severity: "error",
        message: m.groups.msg.trim(),
      });
      continue;
    }
    m = GCC_RE.exec(line);
    if (m?.groups) {
      const g = m.groups;
      // Skip "In file included from" style or "(.text+0x..)" linker refs.
      if (g.file.includes("(.text")) continue;
      push({
        file: g.file.trim(),
        line: Number(g.line),
        ...(g.col ? { col: Number(g.col) } : {}),
        severity: normSeverity(g.sev),
        message: g.msg.trim(),
      });
      continue;
    }
    m = LD_UNDEF_RE.exec(line);
    if (m?.groups) {
      push({ file: "", line: 0, severity: "error", message: m.groups.msg.trim() });
    }
  }
  return out;
}

/**
 * Drop warning/note blocks (header line + indented source/caret lines) that
 * belong to files other than `userFiles`, e.g. LVGL library warnings printed
 * during the first build. Errors are always kept.
 */
export function focusOnUserFiles(text: string, userFiles: string[]): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let keep = true;
  for (const line of lines) {
    const m = MSVC_RE.exec(line) ?? GCC_RE.exec(line);
    const inFn = /^(.+?): (In function|At top level|In file included from)/.exec(line);
    if (m?.groups) {
      const file = baseName(m.groups.file.trim());
      keep = userFiles.includes(file) || normSeverity(m.groups.sev) === "error";
    } else if (inFn) {
      keep = userFiles.includes(baseName(inFn[1].trim()));
    } else if (!/^\s/.test(line)) {
      keep = true; // linker lines, summaries, ...
    }
    if (keep) out.push(line);
  }
  return out.join("\n");
}

/** One-line rendering of a diagnostic: `snippet.c:2:5: error: msg`. */
export function formatDiagnostic(d: Diagnostic): string {
  const loc = d.file ? `${d.file}${d.line ? `:${d.line}` : ""}${d.col ? `:${d.col}` : ""}: ` : "";
  return `${loc}${d.severity}: ${d.code ? d.code + ": " : ""}${d.message}`;
}

/** Add hints for common mistakes, based on the diagnostics. */
export function diagnosticHints(diags: Diagnostic[], fullFile: boolean): string[] {
  const hints = new Set<string>();
  for (const d of diags) {
    const m = d.message;
    if (/create_ui/.test(m) && /(undefined|unresolved)/i.test(m)) {
      hints.add(
        fullFile
          ? "Full-file mode requires a global `void create_ui(void)` function."
          : "Snippet mode already defines create_ui(); do not define it yourself (use lvgl_render_full for complete files)."
      );
    }
    if (/implicit declaration of function|C4013|undeclared|undefined (?:reference|symbol)|unresolved external/i.test(m)) {
      const fn = /['‘`"]?(lv_\w+)/.exec(m)?.[1];
      if (fn) {
        hints.add(
          `\`${fn}\` does not exist in this LVGL build. This is LVGL 9.x - check the v8->v9 rename table in the lvgl://api-reference resource (e.g. lv_btn_create -> lv_button_create, lv_scr_act -> lv_screen_active, lv_img_* -> lv_image_*).`
        );
      } else {
        const other =
          /(?:function|reference to|symbol)\s+['‘`"]?([A-Za-z_]\w*)/.exec(m)?.[1] ??
          /^['‘]([A-Za-z_]\w*)['’] undefined/.exec(m)?.[1];
        if (other && other !== "create_ui") {
          hints.add(
            `\`${other}\` is not declared/defined: misspelled, missing #include, or defined in another file of your project (define or stub it${fullFile ? "" : " - helper functions need lvgl_render_full"}).`
          );
        }
      }
    }
    if (/function definition is not allowed here|a function-definition is not allowed|C2601|nested function|invalid storage class/i.test(m) && !fullFile) {
      hints.add(
        "Snippet mode pastes your code inside the body of create_ui(); helper functions, static callbacks and #includes need lvgl_render_full."
      );
    }
    if (/lv_font_montserrat_\d+/.test(m) && /undeclared|undefined|C2065/i.test(m)) {
      hints.add("Only Montserrat sizes 8..48 (even sizes) are built into the simulator.");
    }
  }
  return [...hints];
}
