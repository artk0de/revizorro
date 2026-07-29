import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import type { DiffProvider, DiffFile } from "@revizorro/core";

const exec = promisify(execFile);

export interface GitDiffOptions {
  /**
   * Review the index instead of the worktree: only what is committed on the branch
   * plus what is `git add`-ed. Unstaged edits and untracked files stay out, so an
   * agent can put exactly the change it wants reviewed into the index.
   */
  stagedOnly?: boolean;
}

/** One row of `git diff --name-status`: `M\tpath` or, for renames, `R100\told\tnew`. */
interface StatusRow {
  status: string;
  from: string;
  to?: string;
}

export class GitDiffProvider implements DiffProvider {
  constructor(
    private readonly repoRoot: string,
    private readonly baseRef?: string,
    private readonly options: GitDiffOptions = {},
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

  /**
   * The branch under review, for the form to show. A detached HEAD has no name, so
   * fall back to the short sha rather than printing the literal "HEAD" — with a few
   * worktrees open, the label is how you tell which diff you are looking at.
   */
  async branch(): Promise<string> {
    const name = (await this.gitAllowFail("rev-parse", "--abbrev-ref", "HEAD")).trim();
    if (name && name !== "HEAD") return name;
    return (await this.gitAllowFail("rev-parse", "--short", "HEAD")).trim();
  }

  private async git(...args: string[]): Promise<string> {
    const { stdout } = await exec("git", args, {
      cwd: this.repoRoot,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  }

  /** Run git for binary-safe output (file contents read out of the index). */
  private async gitBytes(...args: string[]): Promise<Buffer> {
    const { stdout } = await exec("git", args, {
      cwd: this.repoRoot,
      maxBuffer: 64 * 1024 * 1024,
      encoding: "buffer",
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

  private parseNameStatus(out: string): StatusRow[] {
    const rows: StatusRow[] = [];
    for (const line of out.split("\n")) {
      const [status, from, to] = line.split("\t");
      if (!status || !from) continue;
      rows.push({ status, from, to: to || undefined });
    }
    return rows;
  }

  /** Walk the rename chain back to the path this file was originally created under. */
  private originOf(path: string, renames: Map<string, string>): string | undefined {
    const seen = new Set([path]);
    let origin: string | undefined;
    let cur = renames.get(path);
    while (cur && !seen.has(cur)) {
      origin = cur;
      seen.add(cur);
      cur = renames.get(cur);
    }
    return origin;
  }

  async diff(_worktreeId: string): Promise<DiffFile[]> {
    const staged = this.options.stagedOnly === true;
    // Two different questions, two different baselines. --staged-only asks "review
    // what I just staged", so the branch's own last commit is the baseline and the
    // commits already on the branch stay out of it. Plain worktree review asks
    // "review this branch", so it baselines at the fork point with the target.
    const base = staged
      ? "HEAD"
      : (await this.git("merge-base", await this.resolveBase(), "HEAD")).trim();
    // --name-status -M keeps the rename pairs that --name-only collapses away, so a
    // moved file can be shown as `old → new` instead of a brand-new file.
    const committed = staged ? "" : await this.git("diff", "--name-status", "-M", base, "HEAD");
    const working = staged
      ? await this.git("diff", "--cached", "--name-status", "-M", "HEAD")
      : await this.git("diff", "--name-status", "-M", "HEAD");
    // Untracked files are worktree-only by definition — `git add` puts them in the
    // index, where the --cached listing above already picks them up.
    const untrackedOut = staged
      ? ""
      : await this.git("ls-files", "--others", "--exclude-standard");
    const untracked = new Set(untrackedOut.split("\n").filter(Boolean));

    const rows = [
      ...this.parseNameStatus(committed),
      ...this.parseNameStatus(working),
      ...[...untracked].map((from): StatusRow => ({ status: "A", from })),
    ];
    const renames = new Map<string, string>();
    for (const r of rows) if (r.to && /^[RC]/.test(r.status)) renames.set(r.to, r.from);
    const paths = new Set(rows.map((r) => r.to ?? r.from));
    // A rename's source only exists as the left half of the pair — never as a file
    // of its own (it may still be listed by the other diff as a plain change).
    for (const r of rows) if (r.to) paths.delete(r.from);

    const files: DiffFile[] = [];
    for (const path of paths) {
      const oldPath = this.originOf(path, renames);
      let contentHash = "";
      let content: string | undefined;
      try {
        const bytes = staged
          ? await this.gitBytes("show", `:${path}`)
          : await readFile(join(this.repoRoot, path));
        contentHash = createHash("sha1").update(bytes).digest("hex");
        content = bytes.toString("utf8");
      } catch {
        // deleted file → empty hash, no content
      }
      // Passing BOTH sides of a rename keeps git's rename detection alive under a
      // pathspec; a single path would render the move as a full-content addition.
      const pathspec = oldPath ? [oldPath, path] : [path];
      const patch = untracked.has(path)
        ? await this.gitAllowFail("diff", "--no-index", "--", "/dev/null", path)
        : staged
          ? await this.gitAllowFail("diff", "--cached", "-M", base, "--", ...pathspec)
          : await this.gitAllowFail("diff", "-M", base, "--", ...pathspec);
      const binary = /Binary files|GIT binary patch/.test(patch);
      files.push({
        path,
        oldPath,
        contentHash,
        patch,
        binary,
        content: binary ? undefined : content,
      });
    }
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }
}
