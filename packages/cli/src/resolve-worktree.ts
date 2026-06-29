import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

export function resolveWorktreeId(cwd: string): string {
  const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
  }).trim();
  return createHash("sha1").update(top).digest("hex").slice(0, 12);
}
