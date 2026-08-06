import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpReviewClient, worktreeIdFor } from "@revizorro/core-adapters";
import { ReviewHost } from "../src/host.js";

const git = (cwd: string, ...a: string[]): string =>
  execFileSync("git", a, { cwd, encoding: "utf8" });

let repo: string;
let opener: ReviewHost | undefined;
let reopened: ReviewHost | undefined;
let shown: { round: number; status: string }[];

/** The window the agent originally opened its review in. */
const openRound = async (): Promise<void> => {
  let up: () => void = () => undefined;
  const ready = new Promise<void>((r) => {
    up = r;
  });
  opener = new ReviewHost(
    () => undefined,
    () => {
      up();
    },
  );
  const port = await opener.start();
  const poll = new HttpReviewClient(port).review(worktreeIdFor(repo), repo);
  void poll.catch(() => undefined);
  await ready;
  await poll.catch(() => undefined);
};

/** What a window does when it comes back up: a brand new host over the same repo. */
const reload = async (): Promise<void> => {
  await opener?.stop();
  opener = undefined;
  shown = [];
  reopened = new ReviewHost(
    () => undefined,
    (s: { round: number; status: string }) => {
      shown.push({ round: s.round, status: s.status });
    },
  );
  await reopened.start();
  await reopened.restore(repo);
};

beforeEach(() => {
  process.env.REVIZORRO_POLL_TIMEOUT_MS = "500";
  shown = [];
  repo = mkdtempSync(join(tmpdir(), "rvz-restore-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
  git(repo, "checkout", "-qb", "feature");
  writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
});

afterEach(async () => {
  await opener?.stop();
  await reopened?.stop();
  opener = undefined;
  reopened = undefined;
  delete process.env.REVIZORRO_POLL_TIMEOUT_MS;
});

// Reloading a window is something a human does mid-review — to pick up an updated
// extension, or because something looked wrong. Losing the review to it strands
// them: the panel is the only way to answer, and only the agent can re-open it.
describe("restoring the form after a window reload", () => {
  it("brings an unfinished review back up", async () => {
    await openRound();

    await reload();

    expect(shown).toEqual([{ round: 1, status: "open" }]);
  }, 20_000);

  it("stays quiet when the last round was already decided, so a finished review does not reappear", async () => {
    await openRound();
    await opener?.requestChanges();

    await reload();

    expect(shown).toEqual([]);
  }, 20_000);

  it("stays quiet in a window whose project was never reviewed", async () => {
    await reload();

    expect(shown).toEqual([]);
  }, 20_000);
});
