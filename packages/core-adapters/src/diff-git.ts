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
    private readonly baseRef?: string,
  ) {}

  /**
   * Base branch to diff against. Explicit ref wins; else $REVIZORRO_BASE; else the
   * repo's own default branch (origin/HEAD → main → master). Hardcoding "main"
   * broke repos whose default is "master" (`git merge-base main HEAD` → fatal).
   */
  private async resolveBase(): Promise<string> {
    if (this.baseRef) return this.baseRef;
    if (process.env.REVIZORRO_BASE) return process.env.REVIZORRO_BASE;
    try {
      const head = (await this.git("symbolic-ref", "--short", "refs/remotes/origin/HEAD")).trim();
      if (head) return head;
    } catch {
      // no origin/HEAD configured
    }
    for (const candidate of ["main", "master"]) {
      try {
        await this.git("rev-parse", "--verify", "--quiet", candidate);
        return candidate;
      } catch {
        // candidate branch absent
      }
    }
    return "main";
  }

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
    const base = (await this.git("merge-base", await this.resolveBase(), "HEAD")).trim();
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
