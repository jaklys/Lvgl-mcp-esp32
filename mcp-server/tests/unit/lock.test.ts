import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { withDirLock } from "../../src/simulator/lock.js";

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "lvgl-mcp-lock-test-"));
}

test("withDirLock serializes holders and releases the lock", async () => {
  const dir = await tmpDir();
  const order: string[] = [];
  const opts = { waitMs: 5000, staleMs: 60000, pollMs: 10 };
  await Promise.all([
    withDirLock(dir, opts, async () => {
      order.push("a-start");
      await new Promise((r) => setTimeout(r, 100));
      order.push("a-end");
    }),
    new Promise((r) => setTimeout(r, 20)).then(() =>
      withDirLock(dir, opts, async () => {
        order.push("b-start");
        order.push("b-end");
      })
    ),
  ]);
  assert.deepEqual(order, ["a-start", "a-end", "b-start", "b-end"]);
  await assert.rejects(fs.stat(path.join(dir, ".lvgl-mcp.lock")));
  await fs.rm(dir, { recursive: true, force: true });
});

test("withDirLock breaks a lock whose owner process is dead", async () => {
  const dir = await tmpDir();
  const lock = path.join(dir, ".lvgl-mcp.lock");
  await fs.mkdir(lock);
  await fs.writeFile(path.join(lock, "owner"), "999999999");
  const v = await withDirLock(dir, { waitMs: 2000, staleMs: 60000, pollMs: 10 }, async () => 42);
  assert.equal(v, 42);
  await fs.rm(dir, { recursive: true, force: true });
});

test("withDirLock times out while a live process holds the lock", async () => {
  const dir = await tmpDir();
  const lock = path.join(dir, ".lvgl-mcp.lock");
  await fs.mkdir(lock);
  await fs.writeFile(path.join(lock, "owner"), String(process.pid));
  await assert.rejects(
    withDirLock(dir, { waitMs: 200, staleMs: 60000, pollMs: 10 }, async () => 1),
    /locked by another lvgl-mcp-server process/
  );
  await fs.rm(dir, { recursive: true, force: true });
});
