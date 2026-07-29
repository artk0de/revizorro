import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitDiffProvider } from "../src/index.js";

const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" });
let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "rvz-git-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
  git(repo, "checkout", "-qb", "feature");
});

describe("GitDiffProvider", () => {
  it("reports a committed change on the branch", async () => {
    writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
    git(repo, "commit", "-aqm", "change a");
    const files = await new GitDiffProvider(repo, "main").diff("wt");
    expect(files.map((f) => f.path)).toContain("a.ts");
    expect(files.find((f) => f.path === "a.ts")!.contentHash).toMatch(/^[0-9a-f]{40}$/);
  });
  it("reports an uncommitted new file", async () => {
    writeFileSync(join(repo, "b.ts"), "export const b = 3;\n");
    const files = await new GitDiffProvider(repo, "main").diff("wt");
    expect(files.map((f) => f.path)).toContain("b.ts");
  });
  it("includes a unified patch with +/- lines for a tracked change", async () => {
    writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
    git(repo, "commit", "-aqm", "change a");
    const files = await new GitDiffProvider(repo, "main").diff("wt");
    const a = files.find((f) => f.path === "a.ts")!;
    expect(a.patch).toContain("-export const a = 1;");
    expect(a.patch).toContain("+export const a = 2;");
    expect(a.binary).toBe(false);
  });
  it("includes new-file content as an added patch for an untracked file", async () => {
    writeFileSync(join(repo, "b.ts"), "export const b = 3;\n");
    const files = await new GitDiffProvider(repo, "main").diff("wt");
    const b = files.find((f) => f.path === "b.ts")!;
    expect(b.patch).toContain("+export const b = 3;");
  });
  it("reports a renamed file under its new path, carrying the old one", async () => {
    git(repo, "mv", "a.ts", "moved-a.ts");
    git(repo, "commit", "-qm", "move a");
    const files = await new GitDiffProvider(repo, "main").diff("wt");
    expect(files.map((f) => f.path)).toEqual(["moved-a.ts"]);
    expect(files[0].oldPath).toBe("a.ts");
  });
  it("diffs a renamed-and-edited file against its old path, not as a new file", async () => {
    // git only calls it a rename above ~50% similarity, so the moved file has to be
    // big enough for one edited line to leave the rest recognisable.
    const lines = Array.from({ length: 20 }, (_, i) => `export const v${i} = ${i};`);
    const big = mkdtempSync(join(tmpdir(), "rvz-move-"));
    git(big, "init", "-q", "-b", "main");
    git(big, "config", "user.email", "t@t");
    git(big, "config", "user.name", "t");
    writeFileSync(join(big, "big.ts"), `${lines.join("\n")}\n`);
    git(big, "add", ".");
    git(big, "commit", "-qm", "base");
    git(big, "checkout", "-qb", "feature");
    git(big, "mv", "big.ts", "nested-big.ts");
    writeFileSync(join(big, "nested-big.ts"), `${[...lines.slice(0, 3), "export const v3 = 333;", ...lines.slice(4)].join("\n")}\n`);
    git(big, "commit", "-aqm", "move and edit big");

    const files = await new GitDiffProvider(big, "main").diff("wt");
    const moved = files.find((f) => f.path === "nested-big.ts")!;
    expect(moved.oldPath).toBe("big.ts");
    expect(moved.patch).toContain("-export const v3 = 3;");
    expect(moved.patch).toContain("+export const v3 = 333;");
    expect(moved.patch).not.toContain("+export const v7 = 7;"); // untouched lines aren't re-added
  });
  it("leaves oldPath unset for a plain modification", async () => {
    writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
    git(repo, "commit", "-aqm", "change a");
    const files = await new GitDiffProvider(repo, "main").diff("wt");
    expect(files.find((f) => f.path === "a.ts")!.oldPath).toBeUndefined();
  });
  it("stagedOnly skips unstaged edits and untracked files", async () => {
    writeFileSync(join(repo, "a.ts"), "export const a = 2;\n"); // unstaged edit
    writeFileSync(join(repo, "b.ts"), "export const b = 3;\n");
    git(repo, "add", "b.ts"); // staged addition
    writeFileSync(join(repo, "c.ts"), "export const c = 4;\n"); // untracked
    const files = await new GitDiffProvider(repo, "main", { stagedOnly: true }).diff("wt");
    expect(files.map((f) => f.path)).toEqual(["b.ts"]);
  });
  it("stagedOnly diffs the staged content, ignoring later worktree edits", async () => {
    writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
    git(repo, "add", "a.ts");
    writeFileSync(join(repo, "a.ts"), "export const a = 999;\n"); // unstaged on top
    const files = await new GitDiffProvider(repo, "main", { stagedOnly: true }).diff("wt");
    const a = files.find((f) => f.path === "a.ts")!;
    expect(a.patch).toContain("+export const a = 2;");
    expect(a.patch).not.toContain("999");
    expect(a.content).toBe("export const a = 2;\n");
  });
  // --staged-only answers "review what I just staged", so its baseline is the
  // branch's last commit — NOT the fork point with the target branch. Pulling in
  // earlier commits of the branch would bury the staged change under old work.
  it("stagedOnly baselines against HEAD, excluding earlier commits on the branch", async () => {
    writeFileSync(join(repo, "committed.ts"), "export const c = 1;\n");
    git(repo, "add", "committed.ts");
    git(repo, "commit", "-qm", "earlier work on the branch");
    writeFileSync(join(repo, "staged.ts"), "export const s = 1;\n");
    git(repo, "add", "staged.ts");

    const files = await new GitDiffProvider(repo, "main", { stagedOnly: true }).diff("wt");
    expect(files.map((f) => f.path)).toEqual(["staged.ts"]);
  });

  it("stagedOnly reports nothing when the index matches HEAD", async () => {
    writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
    git(repo, "commit", "-aqm", "change a");
    const files = await new GitDiffProvider(repo, "main", { stagedOnly: true }).diff("wt");
    expect(files).toEqual([]);
  });

  it("worktree mode still reviews the whole branch against the target", async () => {
    writeFileSync(join(repo, "committed.ts"), "export const c = 1;\n");
    git(repo, "add", "committed.ts");
    git(repo, "commit", "-qm", "earlier work on the branch");
    writeFileSync(join(repo, "dirty.ts"), "export const d = 1;\n");

    const files = await new GitDiffProvider(repo, "main").diff("wt");
    expect(files.map((f) => f.path).sort()).toEqual(["committed.ts", "dirty.ts"]);
  });

  it("diffs against an explicitly given target branch, not the default one", async () => {
    // Branch off a second baseline; reviewing against it must hide main-era work.
    git(repo, "checkout", "-qb", "target");
    writeFileSync(join(repo, "on-target.ts"), "export const t = 1;\n");
    git(repo, "add", "on-target.ts");
    git(repo, "commit", "-qm", "work that belongs to the target branch");
    git(repo, "checkout", "-qb", "feature-2");
    writeFileSync(join(repo, "mine.ts"), "export const m = 1;\n");
    git(repo, "add", "mine.ts");
    git(repo, "commit", "-qm", "my work");

    expect((await new GitDiffProvider(repo, "target").diff("wt")).map((f) => f.path)).toEqual([
      "mine.ts",
    ]);
    expect(
      (await new GitDiffProvider(repo, "main").diff("wt")).map((f) => f.path).sort(),
    ).toEqual(["mine.ts", "on-target.ts"]);
  });
  it("auto-detects the default branch when no base ref is given (master, no main)", async () => {
    const mrepo = mkdtempSync(join(tmpdir(), "rvz-master-"));
    git(mrepo, "init", "-q", "-b", "master");
    git(mrepo, "config", "user.email", "t@t");
    git(mrepo, "config", "user.name", "t");
    writeFileSync(join(mrepo, "a.ts"), "export const a = 1;\n");
    git(mrepo, "add", ".");
    git(mrepo, "commit", "-qm", "base");
    git(mrepo, "checkout", "-qb", "feature");
    writeFileSync(join(mrepo, "a.ts"), "export const a = 2;\n");
    git(mrepo, "commit", "-aqm", "change a");
    // No explicit base ref → provider must fall back to master (there is no main).
    const files = await new GitDiffProvider(mrepo).diff("wt");
    expect(files.map((f) => f.path)).toContain("a.ts");
  });

  // The form shows what you are reviewing; without the branch name a reviewer with
  // several worktrees open has to guess which one the diff came from.
  it("reports the checked-out branch", async () => {
    expect(await new GitDiffProvider(repo, "main").branch()).toBe("feature");
  });

  it("falls back to a short sha when HEAD is detached", async () => {
    const sha = git(repo, "rev-parse", "--short", "HEAD").trim();
    git(repo, "checkout", "-q", "--detach");
    expect(await new GitDiffProvider(repo, "main").branch()).toBe(sha);
  });
});
