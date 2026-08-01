import { existsSync } from "node:fs";

import type { Shell, UpdateLeg } from "./types.js";

export interface ExtensionLegDeps {
  shell: Shell;
  /** The packaged extension the CLI package carries, installed straight from disk. */
  vsixPath: string;
}

const ID = "artk0de.revizorro";

/** Pulls `<publisher>.<name>@<version>` lines apart to find the one extension we own. */
function installedVersion(listing: string): string | null {
  for (const line of listing.split("\n")) {
    const at = line.lastIndexOf("@");
    if (at > 0 && line.slice(0, at).trim() === ID) return line.slice(at + 1).trim();
  }
  return null;
}

/**
 * Holds the VS Code extension to the same version as the CLI.
 *
 * The two halves talk over HTTP through a shared protocol package, so a set that
 * drifts apart fails at review time rather than at install time.
 *
 * The bytes come from the VSIX inside the npm package rather than from the
 * Marketplace: one tarball then carries all three artifacts at one version, and
 * updating needs neither a Marketplace listing nor a publisher token.
 */
export function extensionLeg(deps: ExtensionLegDeps): UpdateLeg {
  return async (target) => {
    const listing = await deps.shell.capture("code", ["--list-extensions", "--show-versions"]);
    if (listing === null) {
      return {
        leg: "extension",
        state: "skipped",
        reason: "the VS Code CLI `code` is not on PATH",
      };
    }

    const from = installedVersion(listing);
    // `update` is not `install`: an editor extension the human never chose is no
    // more this command's to add than a Claude plugin they never installed.
    if (from === null) {
      return {
        leg: "extension",
        state: "skipped",
        reason: "the revizorro extension is not installed in VS Code",
      };
    }
    if (from === target) return { leg: "extension", state: "current", version: target };

    // Only a release packages the extension into the CLI, so a locally built or
    // hand-assembled copy legitimately has none.
    if (!existsSync(deps.vsixPath)) {
      return {
        leg: "extension",
        state: "skipped",
        reason: "this build of the CLI carries no packaged extension to install from",
      };
    }

    const code = await deps.shell.run("code", ["--install-extension", deps.vsixPath, "--force"]);
    if (code !== 0) {
      return {
        leg: "extension",
        state: "failed",
        reason: code === null ? "the VS Code CLI vanished mid-run" : `code exited ${code}`,
      };
    }
    // VS Code writes the new version to disk but a running window keeps executing
    // the old extension host, so the human has to reload before it takes effect.
    return { leg: "extension", state: "updated", from, to: target };
  };
}
