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

  /** Run git, returning stdout even when the command exits non-zero (e.g. `diff --no-index`). */
  private async gitAllowFail(...args: string[]): Promise<string> {
    try {
      return await this.git(...args);
    } catch (e) {
      return (e as { stdout?: string }).stdout ?? "";
    }
  }

  async diff(_worktreeId: string): Promise<DiffFile[]> {
    const base = (await this.git("merge-base", this.baseRef, "HEAD")).trim();
    const committed = await this.git("diff", "--name-only", base, "HEAD");
    const uncommitted = await this.git("diff", "--name-only", "HEAD");
    const untrackedOut = await this.git("ls-files", "--others", "--exclude-standard");
    const untracked = new Set(untrackedOut.split("\n").filter(Boolean));
    const paths = new Set(
      [committed, uncommitted, untrackedOut].flatMap((s) => s.split("\n")).filter(Boolean),
    );

    const files: DiffFile[] = [];
    for (const path of paths) {
      let contentHash = "";
      let content: string | undefined;
      try {
        const bytes = await readFile(join(this.repoRoot, path));
        contentHash = createHash("sha1").update(bytes).digest("hex");
        content = bytes.toString("utf8");
      } catch {
        // deleted file → empty hash, no content
      }
      const patch = untracked.has(path)
        ? await this.gitAllowFail("diff", "--no-index", "--", "/dev/null", path)
        : await this.gitAllowFail("diff", base, "--", path);
      const binary = /Binary files|GIT binary patch/.test(patch);
      files.push({ path, contentHash, patch, binary, content: binary ? undefined : content });
    }
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }
}
