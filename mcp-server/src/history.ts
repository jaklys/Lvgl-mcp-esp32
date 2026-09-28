import type { RenderResult } from "./simulator/types.js";

export interface HistoryEntry {
  /** "r1", "r2", ... (never reused within a server process). */
  id: string;
  /** Tool that produced the render. */
  tool: string;
  createdAt: number;
  result: RenderResult;
}

/** The last `max` renders (final PNG + tree + everything else), for lvgl_diff and lvgl_inspect. */
export class RenderHistory {
  private entries: HistoryEntry[] = [];
  private next = 1;

  constructor(readonly max = 20) {}

  add(result: RenderResult, tool: string): HistoryEntry {
    const entry: HistoryEntry = { id: `r${this.next++}`, tool, createdAt: Date.now(), result };
    this.entries.push(entry);
    if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max);
    return entry;
  }

  get(id: string): HistoryEntry | undefined {
    const norm = id.trim().toLowerCase();
    return this.entries.find((e) => e.id === norm || e.id === `r${norm}`);
  }

  latest(): HistoryEntry | undefined {
    return this.entries[this.entries.length - 1];
  }

  ids(): string[] {
    return this.entries.map((e) => e.id);
  }

  /** "r3 (lvgl_render, 320x240), r4 (...)" for error messages. */
  describe(): string {
    if (this.entries.length === 0) return "none yet";
    return this.entries.map((e) => `${e.id} (${e.tool}, ${e.result.pngWidth}x${e.result.pngHeight})`).join(", ");
  }
}
