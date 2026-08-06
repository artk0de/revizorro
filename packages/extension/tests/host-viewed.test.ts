import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpReviewClient, FsSessionStore } from "@revizorro/core-adapters";
import { ReviewHost } from "../src/host.js";

const git = (cwd: string, ...a: string[]): string =>
  execFileSync("git", a, { cwd, encoding: "utf8" });

let repo: string;
let host: ReviewHost;
let port: number;

/**
 * Form-open bookkeeping, scoped to one test.
 *
 * A host whose poll timed out can still open its form after the test that made it
 * has moved on. Counting opens per generation — and ignoring any that arrive from
 * a retired host — stops a late callback from releasing the next test's wait
 * before its round has been saved.
 */
interface Opens {
  count: number;
  notify: () => void;
}
let live: Opens;

/** Issue a review call and wait until the form it opens has actually rendered. */
const review = async (): Promise<void> => {
  const gen = live;
  const target = gen.count + 1;
  const opened = new Promise<void>((resolve) => {
    gen.notify = () => {
      if (gen.count >= target) resolve();
    };
    if (gen.count >= target) resolve();
  });
  const poll = new HttpReviewClient(port).review("wt1", repo);
  await opened;
  await poll.catch(() => undefined);
};

const stored = async (): Promise<Record<string, { viewed: boolean; contentHash: string }>> => {
  const s = await new FsSessionStore(repo, "feature").load("wt1");
  return s?.files ?? {};
};

beforeEach(async () => {
  process.env.REVIZORRO_POLL_TIMEOUT_MS = "500";
  repo = mkdtempSync(join(tmpdir(), "rvz-viewed-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
  git(repo, "checkout", "-qb", "feature");
  writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");

  const gen: Opens = { count: 0, notify: () => undefined };
  live = gen;
  host = new ReviewHost(
    () => undefined,
    () => {
      if (live !== gen) return;
      gen.count += 1;
      gen.notify();
    },
  );
  port = await host.start();
});

afterEach(async () => {
  await host?.stop();
  delete process.env.REVIZORRO_POLL_TIMEOUT_MS;
});

// The tick means "I have read this diff". Once the agent rewrites the file the
// human has not read the diff in front of them, so a tick left standing invites
// them to approve code nobody looked at.
describe("a viewed file the agent then edits", () => {
  it("loses its viewed tick when the agent re-opens the same round after editing it", async () => {
    await review();
    await host.setViewed("a.ts", true);
    expect((await stored())["a.ts"].viewed).toBe(true);

    // The agent applies a fix and calls review again — same scope, round still open.
    writeFileSync(join(repo, "a.ts"), "export const a = 3; // fixed\n");
    await review();

    expect((await stored())["a.ts"].viewed).toBe(false);
    // Real git plus two long-poll round trips; the default 5s is tight once the
    // suite runs every file at once.
  }, 20_000);

  it("keeps the tick on a file the agent left alone, so re-reading is not asked for twice", async () => {
    writeFileSync(join(repo, "b.ts"), "export const b = 1;\n");
    await review();
    await host.setViewed("a.ts", true);
    await host.setViewed("b.ts", true);

    writeFileSync(join(repo, "b.ts"), "export const b = 2; // fixed\n");
    await review();

    const files = await stored();
    expect({ a: files["a.ts"].viewed, b: files["b.ts"].viewed }).toEqual({ a: true, b: false });
  }, 20_000);
});
