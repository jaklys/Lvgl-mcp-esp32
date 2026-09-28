import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SimulatorError } from "./errors.js";

export interface LockOptions {
  /** Give up waiting after this many ms. */
  waitMs: number;
  /** A lock older than this is considered stale even if its owner lives. */
  staleMs: number;
  pollMs?: number;
  signal?: AbortSignal;
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Cross-process mutex for the shared build directory (several MCP server
 * instances - e.g. two editor sessions - may use the same simulator/build).
 * Implemented as an atomic mkdir; stale locks (dead owner or too old) are
 * broken.
 */
export async function withDirLock<T>(dir: string, opts: LockOptions, fn: () => Promise<T>): Promise<T> {
  await fs.mkdir(dir, { recursive: true });
  const lockDir = path.join(dir, ".lvgl-mcp.lock");
  const owner = path.join(lockDir, "owner");
  const deadline = Date.now() + opts.waitMs;
  const poll = opts.pollMs ?? 100;

  for (;;) {
    try {
      await fs.mkdir(lockDir);
      await fs.writeFile(owner, String(process.pid)).catch(() => undefined);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    // Held by someone: stale?
    let stale = false;
    try {
      const st = await fs.stat(lockDir);
      const pid = Number.parseInt(await fs.readFile(owner, "utf-8").catch(() => ""), 10);
      const age = Date.now() - st.mtimeMs;
      if (age > opts.staleMs) stale = true;
      else if (Number.isFinite(pid) && !isAlive(pid)) stale = true;
      else if (!Number.isFinite(pid) && age > 5000) stale = true; // owner file never written
    } catch {
      continue; // lock vanished between mkdir and stat: retry immediately
    }
    if (stale) {
      await fs.rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
      continue;
    }
    if (opts.signal?.aborted) throw new SimulatorError("cancelled", "Request cancelled by the client.");
    if (Date.now() > deadline) {
      throw new SimulatorError(
        "timeout",
        `The build directory ${dir} is locked by another lvgl-mcp-server process (${lockDir}). Try again, or delete the lock directory if no other server is running.`
      );
    }
    await new Promise((r) => setTimeout(r, poll));
  }

  try {
    return await fn();
  } finally {
    await fs.rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
