import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

/**
 * Which working tree a review belongs to, derived from its git root.
 *
 * Both ends have to agree on this: the CLI names the worktree when it asks for a
 * review, and the extension has to find that same session again to bring a form
 * back after a window reload. Two copies of the rule would drift and quietly read
 * a different file, so this is the only one.
 */
export function resolveWorktreeId(cwd: string): string {
  const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
  }).trim();
  return worktreeIdFor(top);
}

/** Same identity, when the git root is already known. */
export function worktreeIdFor(repoRoot: string): string {
  return createHash("sha1").update(repoRoot).digest("hex").slice(0, 12);
}
