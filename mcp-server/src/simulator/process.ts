import { spawn, execFile, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import * as path from "node:path";

export const isWindows = process.platform === "win32";

/** Upper bound for captured stdout / stderr of any child process. */
export const MAX_BUFFER = 10 * 1024 * 1024;

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Kill the whole process tree after this many milliseconds. */
  timeoutMs?: number;
  /** Abort (kill the process tree) when this signal fires. */
  signal?: AbortSignal;
  maxBuffer?: number;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  /** Exit code, or null when the process was terminated by a signal. */
  code: number | null;
  /** Terminating signal (POSIX), e.g. "SIGSEGV". */
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  /** Set when the process could not be started at all (e.g. ENOENT). */
  spawnError?: NodeJS.ErrnoException;
  /** True when stdout or stderr exceeded maxBuffer and was truncated. */
  truncated: boolean;
}

/** Children that are currently running; killed on server shutdown. */
const running = new Set<ChildProcess>();

/**
 * Kill a child and all of its descendants.
 * POSIX (Linux, macOS): the child is spawned detached (setsid: own process
 * group) so we signal -pid. Windows: taskkill /T /F.
 */
export function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (isWindows) {
    try {
      execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => {
        /* ignore */
      });
    } catch {
      /* ignore */
    }
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/** Kill every child process started through runProcess(). */
export function killAllChildren(): void {
  for (const child of running) killTree(child);
  running.clear();
}

/**
 * Spawn a process, capture stdout+stderr, never throw on non-zero exit.
 * Enforces a timeout and honours an AbortSignal by killing the whole tree.
 */
export function runProcess(
  command: string,
  args: readonly string[],
  opts: RunOptions = {}
): Promise<RunResult> {
  const maxBuffer = opts.maxBuffer ?? MAX_BUFFER;
  return new Promise((resolve) => {
    const result: RunResult = {
      stdout: "",
      stderr: "",
      code: null,
      signal: null,
      timedOut: false,
      aborted: false,
      truncated: false,
    };

    if (opts.signal?.aborted) {
      result.aborted = true;
      resolve(result);
      return;
    }

    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd: opts.cwd,
        env: opts.env,
        windowsHide: true,
        detached: !isWindows,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      result.spawnError = err as NodeJS.ErrnoException;
      resolve(result);
      return;
    }
    running.add(child);

    const out: Buffer[] = [];
    const errb: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;
    child.stdout?.on("data", (d: Buffer) => {
      if (outLen < maxBuffer) {
        out.push(d);
        outLen += d.length;
      } else result.truncated = true;
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (errLen < maxBuffer) {
        errb.push(d);
        errLen += d.length;
      } else result.truncated = true;
    });

    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        result.timedOut = true;
        killTree(child);
      }, opts.timeoutMs);
    }
    const onAbort = () => {
      result.aborted = true;
      killTree(child);
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      running.delete(child);
      result.stdout = Buffer.concat(out).toString("utf-8").slice(0, maxBuffer);
      result.stderr = Buffer.concat(errb).toString("utf-8").slice(0, maxBuffer);
      resolve(result);
    };

    child.on("error", (err: NodeJS.ErrnoException) => {
      result.spawnError = err;
      finish();
    });
    child.on("close", (code, signal) => {
      result.code = code;
      result.signal = signal;
      finish();
    });
  });
}

/**
 * Resolve an executable name against PATH (and PATHEXT on Windows).
 * Returns the absolute path, the input itself when it already is a path to
 * an existing file, or undefined when nothing was found.
 */
export function resolveExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const isFile = (p: string): boolean => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  const exts = isWindows
    ? ["", ...(envGet(env, "PATHEXT") ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)]
    : [""];

  if (name.includes("/") || (isWindows && name.includes("\\"))) {
    for (const ext of exts) if (isFile(name + ext)) return name + ext;
    return existsSync(name) ? name : undefined;
  }
  const dirs = (envGet(env, "PATH") ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir.replace(/^"(.*)"$/, "$1"), name + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Case-insensitive env lookup (Windows env keys are case-insensitive). */
export function envGet(env: NodeJS.ProcessEnv, key: string): string | undefined {
  if (env[key] !== undefined) return env[key];
  const lower = key.toLowerCase();
  for (const k of Object.keys(env)) if (k.toLowerCase() === lower) return env[k];
  return undefined;
}
