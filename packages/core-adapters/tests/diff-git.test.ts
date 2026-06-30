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
});
