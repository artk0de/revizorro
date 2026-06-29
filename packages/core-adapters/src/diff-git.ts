import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import type { DiffProvider, DiffFile } from "@revizorro/core";

const exec = promisify(execFile);

export class GitDiffProvider implements DiffProvider {
  constructor(
    private readonly repoRoot: string,
    private readonly baseRef = "main",
  ) {}

  private async git(...args: string[]): Promise<string> {
    const { stdout } = await exec("git", args, {
      cwd: this.repoRoot,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  }

  async diff(_worktreeId: string): Promise<DiffFile[]> {
    const base = (await this.git("merge-base", this.baseRef, "HEAD")).trim();
    const committed = await this.git("diff", "--name-only", base, "HEAD");
    const uncommitted = await this.git("diff", "--name-only", "HEAD");
    const untracked = await this.git("ls-files", "--others", "--exclude-standard");
    const paths = new Set(
      [committed, uncommitted, untracked].flatMap((s) => s.split("\n")).filter(Boolean),
    );
    const files: DiffFile[] = [];
    for (const path of paths) {
      let contentHash = "";
      try {
        const bytes = await readFile(join(this.repoRoot, path));
        contentHash = createHash("sha1").update(bytes).digest("hex");
      } catch {
        // deleted file → empty hash
      }
      files.push({ path, contentHash });
    }
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }
}
