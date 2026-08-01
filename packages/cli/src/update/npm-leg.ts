import type { Shell, UpdateLeg } from "./types.js";

export interface NpmLegDeps {
  /** Version of the CLI process running right now, read from its own package.json. */
  currentVersion: string;
  shell: Shell;
  /** True when this CLI is running from a linked working tree rather than an install. */
  linked?: boolean;
}

const PACKAGE = "@revizorro/cli";
/** The shell's own code for "command not found". */
const NOT_FOUND = 127;

/** Brings the globally installed CLI to `target`, leaving it alone when it is already there. */
export function npmLeg(deps: NpmLegDeps): UpdateLeg {
  return async (target) => {
    if (deps.currentVersion === target) {
      return { leg: "cli", state: "current", version: target };
    }

    // Whoever linked this checkout is working ON revizorro. Installing over the
    // link would swap their working tree for a published tarball — destructive,
    // and from a command that reads as routine housekeeping.
    if (deps.linked === true) {
      return {
        leg: "cli",
        state: "skipped",
        reason: "running from a linked checkout — `npm install -g` would replace your link",
      };
    }

    const code = await deps.shell.run("npm", ["install", "-g", `${PACKAGE}@${target}`]);
    if (code === null) {
      return {
        leg: "cli",
        state: "failed",
        reason: "npm is not on PATH — install Node.js, or update the CLI by hand",
        exitCode: NOT_FOUND,
      };
    }
    if (code !== 0) {
      return { leg: "cli", state: "failed", reason: `npm exited ${code}`, exitCode: code };
    }
    return { leg: "cli", state: "updated", from: deps.currentVersion, to: target };
  };
}
