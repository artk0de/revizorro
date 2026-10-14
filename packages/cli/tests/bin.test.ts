import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { HttpReviewHost } from "@revizorro/core-adapters";
import type { ReviewOptions } from "@revizorro/core";
import type { PushPayload } from "@revizorro/protocol";
import { runReview, resolveWorktreeId } from "../src/index.js";

// The bin is the CLI's contract with the agent: flags in, JSON / exit code out. It
// is pinned end to end — bundled exactly as the published package bundles it, then
// run as a child process — so the flags, the bytes on stdout and stderr, and the
// exit codes are what is held, not how the bin happens to be put together.

const pkgSrc = (dir: string) =>
  fileURLToPath(new URL(`../../${dir}/src/index.ts`, import.meta.url));
const binEntry = fileURLToPath(new URL("../bin/revizorro.js", import.meta.url));

let bundle: string;
beforeAll(async () => {
  bundle = join(mkdtempSync(join(tmpdir(), "rvz-bin-")), "revizorro.cjs");
  // Same flags as the package's build script, but against the workspace SOURCES, so
  // the pin follows the code under test rather than whatever dist/ was last built.
  await build({
    entryPoints: [binEntry],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: bundle,
    logLevel: "silent",
    alias: {
      "@revizorro/protocol": pkgSrc("protocol"),
      "@revizorro/core": pkgSrc("core"),
      "@revizorro/core-adapters": pkgSrc("core-adapters"),
      "@revizorro/cli": pkgSrc("cli"),
    },
  });
}, 60_000);

const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" });

interface BinRun {
  stdout: string;
  stderr: string;
  code: number | null;
}

// Each case spawns node and git several times; on a loaded machine that alone can
// pass the default five seconds.
const SLOW = { timeout: 30_000 };

let hostsDir: string;

// Async on purpose: the review cases answer from a host living in THIS process, which
// a synchronous spawn would starve.
async function runBin(
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<BinRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bundle, ...args], {
      cwd,
      env: { ...process.env, REVIZORRO_HOSTS_DIR: hostsDir, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ stdout, stderr, code });
    });
  });
}

const usage = async (argv: string[]) =>
  (
    await runReview(argv, {
      transport: null as never,
      worktreeId: "",
      repoRoot: "",
      readPush: () => ({ replies: [], comments: [] }),
    })
  ).stdout;

let repo: string;
beforeEach(() => {
  hostsDir = mkdtempSync(join(tmpdir(), "rvz-hosts-"));
  repo = realpathSync(mkdtempSync(join(tmpdir(), "rvz-binrepo-")));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
  git(repo, "checkout", "-qb", "feature");
});

describe("revizorro bin: commands that need no window", SLOW, () => {
  it("prints the usage and exits 0 when called with no arguments", async () => {
    const r = await runBin([], repo);
    expect(r).toEqual({ stdout: `${await usage([])}\n`, stderr: "", code: 0 });
  });

  it("prints the usage and exits 0 for --help and -h", async () => {
    for (const flag of ["--help", "-h"]) {
      const r = await runBin([flag], repo);
      expect(r).toEqual({ stdout: `${await usage([flag])}\n`, stderr: "", code: 0 });
    }
  });

  it("prints the usage and exits 2 for an unknown command", async () => {
    const r = await runBin(["bogus"], repo);
    expect(r).toEqual({ stdout: `${await usage(["bogus"])}\n`, stderr: "", code: 2 });
  });

  it("does not need a git repository to print the usage", async () => {
    const plain = mkdtempSync(join(tmpdir(), "rvz-plain-"));
    const r = await runBin(["--help"], plain, { GIT_CEILING_DIRECTORIES: tmpdir() });
    expect(r.code).toBe(0);
  });
});

describe("revizorro bin: review --check", SLOW, () => {
  it("exits 0 with no output when the branch has nothing to review", async () => {
    expect(await runBin(["review", "--check"], repo)).toEqual({ stdout: "", stderr: "", code: 0 });
  });

  it("exits 10 with no output when the worktree has a diff", async () => {
    writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
    expect(await runBin(["review", "--check"], repo)).toEqual({ stdout: "", stderr: "", code: 10 });
  });

  it("honours --staged-only: an unstaged edit is nothing, the same edit staged is a diff", async () => {
    writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
    expect((await runBin(["review", "--check", "--staged-only"], repo)).code).toBe(0);
    git(repo, "add", "a.ts");
    expect((await runBin(["review", "--check", "--staged-only"], repo)).code).toBe(10);
  });

  it("honours --base: a branch commit is a diff against main but nothing against itself", async () => {
    writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
    git(repo, "commit", "-aqm", "change a");
    expect((await runBin(["review", "--check"], repo)).code).toBe(10);
    expect((await runBin(["review", "--check", "--base", "feature"], repo)).code).toBe(0);
  });

  it("needs no VS Code window", async () => {
    // hostsDir is empty: a window lookup would fail the run.
    writeFileSync(join(repo, "b.ts"), "export const b = 1;\n");
    expect((await runBin(["review", "--check"], repo)).code).toBe(10);
  });
});

describe("revizorro bin: failures", SLOW, () => {
  it("exits 1 naming the missing window when no revizorro window is registered", async () => {
    const r = await runBin(["review", "--worktree"], repo);
    expect(r).toEqual({
      stdout: "",
      stderr:
        "revizorro: no revizorro window found — open a folder in VS Code with the revizorro extension\n",
      code: 1,
    });
  });

  it("exits 1 with a revizorro-prefixed error outside a git repository", async () => {
    const plain = mkdtempSync(join(tmpdir(), "rvz-plain-"));
    const r = await runBin(["review", "--worktree"], plain, { GIT_CEILING_DIRECTORIES: tmpdir() });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("revizorro: Command failed: git rev-parse --show-toplevel");
  });
});

describe("revizorro bin: review through a window", SLOW, () => {
  let host: HttpReviewHost;
  let port: number;
  const reviews: { worktreeId: string; repoRoot: string; opts: ReviewOptions }[] = [];
  const pushes: { worktreeId: string; push: PushPayload; opts: ReviewOptions }[] = [];

  beforeEach(async () => {
    reviews.length = 0;
    pushes.length = 0;
    host = new HttpReviewHost();
    host.onReview((worktreeId, repoRoot, opts) => {
      reviews.push({ worktreeId, repoRoot, opts });
      host.emit(worktreeId, { type: "decision", verdict: "approved", comments: [] });
    });
    host.onPush((worktreeId, _repoRoot, push, opts) => {
      pushes.push({ worktreeId, push, opts });
      host.emit(worktreeId, { type: "decision", verdict: "approved", comments: [] });
    });
    port = await host.start();
  });

  afterEach(async () => {
    await host.stop();
  });

  const registerWindow = (project: string) => {
    mkdirSync(hostsDir, { recursive: true });
    writeFileSync(
      join(hostsDir, `${port}.json`),
      JSON.stringify({ port, project, pid: process.pid }),
      "utf8",
    );
  };

  it("prints the event JSON and exits 0, reviewing this repo and worktree in its own window", async () => {
    registerWindow(repo);
    const r = await runBin(["review", "--worktree", "--base", "main"], repo);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout.endsWith("}\n")).toBe(true);
    expect(JSON.parse(r.stdout)).toMatchObject({
      type: "decision",
      verdict: "approved",
      comments: [],
      waitedMs: expect.any(Number),
    });
    expect(reviews).toEqual([
      {
        worktreeId: resolveWorktreeId(repo),
        repoRoot: git(repo, "rev-parse", "--show-toplevel").trim(),
        opts: { stagedOnly: false, baseRef: "main" },
      },
    ]);
  });

  it("warns once on stderr when the only window belongs to another project", async () => {
    registerWindow("/somewhere/else");
    const r = await runBin(["review", "--worktree"], repo);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe(
      `revizorro: no VS Code window has ${repo} open — the review form will appear in ` +
        "the window for /somewhere/else\n",
    );
    expect(JSON.parse(r.stdout)).toMatchObject({ type: "decision", verdict: "approved" });
  });

  it("names a window with no project as (no project)", async () => {
    registerWindow("");
    const r = await runBin(["review", "--worktree"], repo);
    expect(r.stderr).toBe(
      `revizorro: no VS Code window has ${repo} open — the review form will appear in ` +
        "the window for (no project)\n",
    );
  });

  it("delivers --push to the window as a push, not a plain review", async () => {
    registerWindow(repo);
    const file = join(mkdtempSync(join(tmpdir(), "rvz-push-")), "push.json");
    writeFileSync(file, JSON.stringify({ replies: [{ threadId: "t1", body: "done" }] }), "utf8");
    const r = await runBin(["review", "--push", file, "--staged-only"], repo);
    expect(r.code).toBe(0);
    expect(reviews).toEqual([]);
    expect(pushes).toEqual([
      {
        worktreeId: resolveWorktreeId(repo),
        push: { replies: [{ threadId: "t1", body: "done" }], comments: [] },
        opts: { stagedOnly: true },
      },
    ]);
  });
});
