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
const openRound = async (): Promise<{ poll: Promise<unknown> }> => {
  let formIsUp: () => void = () => undefined;
  const opened = new Promise<void>((r) => (formIsUp = r));
  host = new ReviewHost(
    () => undefined,
    () => formIsUp(),
  );
  const port = await host.start();
  const poll = new HttpReviewClient(port).review("wt1", repo);
  await opened;
  return { poll };
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
