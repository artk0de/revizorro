import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpReviewClient } from "@revizorro/core-adapters";
import { ReviewHost } from "../src/host.js";

const git = (cwd: string, ...a: string[]): string =>
  execFileSync("git", a, { cwd, encoding: "utf8" });

/** A repo with one committed file and one edit on a feature branch, ready to review. */
const repoWithChange = (prefix: string, branch: string): string => {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
  git(repo, "checkout", "-qb", branch);
  writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
  return repo;
};

let host: ReviewHost;
let opened: string[];
let port: number;

/**
 * Open a round for one worktree and wait for its form to be up. Two worktrees are
 * the point of these tests, so the wait is per worktree rather than "a form opened".
 *
 * The poll comes back wrapped in an object on purpose: returned bare from an async
 * function it would be flattened, and the caller would sit on the long poll itself.
 */
const openRound = async (repo: string, worktreeId: string): Promise<{ poll: Promise<unknown> }> => {
  const poll = new HttpReviewClient(port).review(worktreeId, repo);
  void poll.catch(() => undefined);
  const deadline = Date.now() + 10_000;
  while (!opened.includes(worktreeId) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  expect(opened).toContain(worktreeId);
  return { poll };
};

let repoA: string;
let repoB: string;

beforeEach(async () => {
  process.env.REVIZORRO_POLL_TIMEOUT_MS = "5000";
  repoA = repoWithChange("rvz-par-a-", "feature-a");
  repoB = repoWithChange("rvz-par-b-", "feature-b");
  opened = [];
  host = new ReviewHost(
    () => undefined,
    (session) => {
      opened.push(session.worktreeId);
    },
  );
  port = await host.start();
});

afterEach(async () => {
  await host?.stop();
  delete process.env.REVIZORRO_POLL_TIMEOUT_MS;
});

// Two agent sessions on two worktrees is the normal shape of this user's work. The
// window used to hold exactly one review, so the second one took the form away from
// the first and left its agent blocked on a round nobody could answer.
describe("two reviews in one window", () => {
  it("keeps the first review alive when a second worktree opens its own", async () => {
    await openRound(repoA, "wtA");
    await openRound(repoB, "wtB");

    expect(host.review("wtA")?.repoRoot).toBe(repoA);
    expect(host.review("wtB")?.repoRoot).toBe(repoB);
    expect(host.review("wtA")?.branch()).toBe("feature-a");
    expect(host.review("wtB")?.branch()).toBe("feature-b");
  });

  it("hands each verdict to the agent that asked about that worktree", async () => {
    const { poll: pollA } = await openRound(repoA, "wtA");
    const { poll: pollB } = await openRound(repoB, "wtB");

    await host.review("wtA")?.approve();
    await host.review("wtB")?.requestChanges();

    expect(await pollA).toMatchObject({ type: "decision", verdict: "approved" });
    expect(await pollB).toMatchObject({ type: "decision", verdict: "changes_requested" });
  });

  it("keeps the threads one review owes an answer to out of the other's loaders", async () => {
    await openRound(repoA, "wtA");
    await openRound(repoB, "wtB");

    await host.review("wtA")?.addHumanComment("a.ts", { startLine: 1, endLine: 1 }, "why?", true);

    expect(host.review("wtA")?.isPending("t1")).toBe(true);
    expect(host.review("wtB")?.isPending("t1")).toBe(false);
  });

  it("reports each round's own duration, not the other round's", async () => {
    await openRound(repoA, "wtA");
    // Enough of a gap that the two rounds cannot report the same elapsed time.
    await new Promise((r) => setTimeout(r, 60));
    await openRound(repoB, "wtB");

    const a = host.review("wtA")?.roundOpenedAt();
    const b = host.review("wtB")?.roundOpenedAt();
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(b as number).toBeGreaterThan(a as number);
  });
});
