import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpReviewClient } from "@revizorro/core-adapters";
import { ReviewHost } from "../src/host.js";

const git = (cwd: string, ...a: string[]): string =>
  execFileSync("git", a, { cwd, encoding: "utf8" });

const settle = async (p: Promise<unknown>, ms: number): Promise<"settled" | "pending"> =>
  Promise.race([
    p.then(() => "settled" as const),
    new Promise<"pending">((r) => setTimeout(() => r("pending"), ms)),
  ]);

let repo: string;
let host: ReviewHost;

/**
 * Open a round and wait for the form to actually be up. Acting before that is a
 * race: the host has no context yet, so a comment lands nowhere and the test
 * passes for the wrong reason.
 */
// Returns the poll wrapped in an object on purpose: handing back the bare promise
// would let async/await flatten it, so the caller would sit on the long poll itself.
const openRound = async (): Promise<{ poll: Promise<unknown>; port: number }> => {
  let formIsUp: () => void = () => undefined;
  const opened = new Promise<void>((r) => (formIsUp = r));
  host = new ReviewHost(
    () => undefined,
    () => formIsUp(),
  );
  const port = await host.start();
  const poll = new HttpReviewClient(port).review("wt1", repo);
  await opened;
  return { poll, port };
};

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "rvz-wake-"));
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
  await host?.stop();
  // Set by the decided-round test; left behind it would silently shorten the poll
  // for every test that runs after it.
  delete process.env.REVIZORRO_POLL_TIMEOUT_MS;
});

// A review belongs to the branch it is reviewing. Carrying the round number,
// the threads and the viewed marks across a checkout shows the human comments
// about code that is no longer in the diff, and calls a first look "round 6".
describe("a session belongs to its branch", () => {
  it("starts a new branch at round 1 with none of the old branch's threads", async () => {
    process.env.REVIZORRO_POLL_TIMEOUT_MS = "500";
    // Record WHICH callback fired: a replayed verdict renders, it does not open a
    // round, and asserting only on the numbers would pass on that replay.
    const seen: { how: string; round: number; status: string; threads: unknown[] }[] = [];
    const capture =
      (how: string) =>
      (s: { round: number; status: string; threads: unknown[] }): void => {
        seen.push({ how, round: s.round, status: s.status, threads: s.threads });
      };
    host = new ReviewHost(capture("render"), capture("open"));
    const port = await host.start();
    const client = new HttpReviewClient(port);

    await client.review("wt1", repo);
    await host.addHumanComment("a.ts", { startLine: 1, endLine: 1 }, "note on the old branch", false);
    await host.requestChanges();

    git(repo, "checkout", "-qb", "other");
    writeFileSync(join(repo, "a.ts"), "export const a = 3;\n");
    seen.length = 0;
    await client.review("wt1", repo);
    // The poll answers on its own timer; opening the round runs a git diff and can
    // finish after it. Wait for the form, or the assertion races the work.
    for (let i = 0; i < 60 && !seen.some((e) => e.how === "open"); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }

    const opened = seen.filter((e) => e.how === "open");
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ round: 1, status: "open" });
    expect(opened[0].threads).toEqual([]);
    // Nothing from the old branch may be replayed into the new one.
    expect(seen.some((e) => e.status === "changes_requested")).toBe(false);
  });
});

// Only "Ask agent" is a request for the agent's attention. A passive comment is a
// note the human leaves while reading; waking the agent for it sends it off acting
// on half a review, before the human has decided anything.
describe("what wakes a blocked agent", () => {
  it("leaves the agent blocked when the human writes a passive comment", async () => {
    const { poll } = await openRound();
    await host.addHumanComment("a.ts", { startLine: 1, endLine: 1 }, "reads oddly", false);
    expect(await settle(poll, 400)).toBe("pending");
  });

  it("knows the branch under review once a round is open", async () => {
    await openRound();
    expect(host.branch()).toBe("feature");
  });

  // The skill tells the agent to push its fix replies right after a verdict. That
  // push lands on a round that is already decided and whose panel is gone, so
  // without an answer here the agent parks on the poll for the full ceiling —
  // exactly at the moment it has work to get on with.
  it("answers a push that lands on an already-decided round", async () => {
    process.env.REVIZORRO_POLL_TIMEOUT_MS = "4000";
    const { poll, port } = await openRound();
    await host.requestChanges();
    await poll;
    const started = Date.now();
    const event = await new HttpReviewClient(port).review("wt1", repo, {
      replies: [{ threadId: "t1", body: "fixed it" }],
      comments: [],
    });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(event).toMatchObject({ type: expect.any(String) });
  });

  it("wakes the agent when the human uses Ask agent", async () => {
    const { poll } = await openRound();
    await host.addHumanComment("a.ts", { startLine: 1, endLine: 1 }, "why this?", true);
    expect(await poll).toMatchObject({ type: "question", body: "why this?" });
  });

  it("still hands a passive comment to the agent with the verdict", async () => {
    const { poll } = await openRound();
    await host.addHumanComment("a.ts", { startLine: 1, endLine: 1 }, "reads oddly", false);
    await host.requestChanges();
    const event = (await poll) as { type: string; comments: { body: string }[] };
    expect(event.type).toBe("decision");
    expect(event.comments.map((c) => c.body)).toContain("reads oddly");
  });
});
