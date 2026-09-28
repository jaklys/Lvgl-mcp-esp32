import type { Diagnostic } from "./diagnostics.js";

export type SimErrorKind =
  | "setup" // toolchain / simulator directory missing (doctor failed)
  | "configure" // cmake configure failed
  | "compile" // user code does not compile / link
  | "timeout" // compile or run exceeded its time budget
  | "crash" // simulator killed by a signal / access violation
  | "assertion" // LVGL assertion or argument check failed (exit 3)
  | "output" // simulator could not write PNG/JSON (exit 2)
  | "args" // simulator rejected its arguments (exit 1)
  | "runtime" // any other non-zero exit / bad output
  | "cancelled"; // MCP request cancelled by the client

export class SimulatorError extends Error {
  readonly kind: SimErrorKind;
  readonly diagnostics: Diagnostic[];
  /** LVGL log lines / stderr tail relevant to the failure. */
  readonly logs: string[];
  /** User printf output (stdout of the simulator). */
  readonly stdout: string;

  constructor(
    kind: SimErrorKind,
    message: string,
    extra: { diagnostics?: Diagnostic[]; logs?: string[]; stdout?: string } = {}
  ) {
    super(message);
    this.name = "SimulatorError";
    this.kind = kind;
    this.diagnostics = extra.diagnostics ?? [];
    this.logs = extra.logs ?? [];
    this.stdout = extra.stdout ?? "";
  }
}
