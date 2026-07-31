import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpReviewClient } from "@revizorro/core-adapters";
import { ReviewHost } from "../src/host.js";

const git = (cwd: string, ...a: string[]): string =>
  execFileSync("git", a, { cwd, encoding: "utf8" });

let repo: string;
let host: ReviewHost;

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

const line = { startLine: 1, endLine: 1 };

beforeEach(() => {
  process.env.REVIZORRO_POLL_TIMEOUT_MS = "500";
  repo = mkdtempSync(join(tmpdir(), "rvz-pending-"));
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
  delete process.env.REVIZORRO_POLL_TIMEOUT_MS;
});

// The loader count is a promise to the human: this many threads are waiting on
// the agent right now. A question the agent never got round to answering must
// not keep inflating it for the rest of the session.
describe("what the agent is said to be answering", () => {
  it("forgets a question the human resolved instead of waiting for", async () => {
    const { poll } = await openRound();
    await host.addHumanComment("a.ts", line, "why this?", true);
    await poll.catch(() => undefined);
    expect(host.isPending("t1")).toBe(true);

    // The human gave up waiting and closed the thread. Nothing can answer it now.
    await host.resolveThread("t1", true);
    expect(host.isPending("t1")).toBe(false);
  });

  it("counts only the threads this clarify actually handed over", async () => {
    const { poll } = await openRound();
    await host.addHumanComment("a.ts", line, "first question", true);
    await poll.catch(() => undefined);
    await host.addHumanComment("a.ts", line, "second question", true);
    // Neither was answered — the agent went off to fix code. Both get closed.
    await host.resolveThread("t1", true);
    await host.resolveThread("t2", true);

    await host.addHumanComment("a.ts", line, "the one open comment", false);
    await host.clarify();

    expect({
      t1: host.isPending("t1"),
      t2: host.isPending("t2"),
      t3: host.isPending("t3"),
    }).toEqual({ t1: false, t2: false, t3: true });
  });
});
