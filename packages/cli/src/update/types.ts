/**
 * What one leg of an update reports back. A leg is anything that carries a
 * version of revizorro on this machine: the npm CLI, the VS Code extension,
 * the Claude plugin skill.
 *
 * `skipped` is a first-class outcome, not a soft failure. A machine without
 * VS Code, or without the Claude plugin ever installed, is not broken — those
 * legs simply have nothing to reconcile, and saying so beats inventing an
 * install the human never asked for.
 */
export type LegResult =
  | { leg: string; state: "current"; version: string }
  | { leg: string; state: "updated"; from: string; to: string }
  | { leg: string; state: "skipped"; reason: string }
  /**
   * `exitCode` lets a leg speak the conventional shell code for its own failure
   * (127 for a missing binary, npm's own code for a refused install) so a script
   * wrapping this command can branch without parsing prose.
   */
  | { leg: string; state: "failed"; reason: string; exitCode?: number };

/** Brings one leg to `target`, or explains why it did not. */
export type UpdateLeg = (target: string) => Promise<LegResult>;

/**
 * The one seam through which legs reach outside processes. `null` means the binary is
 * not on PATH — a different thing from a command that ran and failed, and the
 * legs treat it differently.
 */
export interface Shell {
  /** Runs to completion with output inherited; resolves the exit code, or null when absent. */
  run: (cmd: string, args: string[]) => Promise<number | null>;
  /** Runs capturing stdout; resolves null when the binary is not on PATH. */
  capture: (cmd: string, args: string[]) => Promise<string | null>;
}
