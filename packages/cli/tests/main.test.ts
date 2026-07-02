import { describe, it, expect } from "vitest";
import { runReview } from "../src/index.js";
import type { ReviewTransport } from "@revizorro/core";
import type { PushPayload, ReviewEvent } from "@revizorro/protocol";

const fakeTransport = (event: ReviewEvent): ReviewTransport => ({ review: async () => event });

describe("runReview", () => {
  it("prints the review event JSON for `review`", async () => {
    const r = await runReview(["review", "--worktree"], {
      transport: fakeTransport({ type: "decision", verdict: "approved", comments: [] }),
      worktreeId: "wt1",
      repoRoot: "/repo",
      readPush: () => ({ replies: [], comments: [] }),
    });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ type: "decision", verdict: "approved", comments: [] });
  });
  it("forwards a closed event so the agent knows the human left without a verdict", async () => {
    const r = await runReview(["review", "--worktree"], {
      transport: fakeTransport({ type: "closed" }),
      worktreeId: "wt1",
      repoRoot: "/repo",
      readPush: () => ({ replies: [], comments: [] }),
    });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ type: "closed" });
  });
  it("passes the push payload through on `--push`", async () => {
    let received: PushPayload | undefined;
    const transport: ReviewTransport = {
      review: async (_wt, _repoRoot, push) => {
        received = push;
        return { type: "idle" };
      },
    };
    const r = await runReview(["review", "--push", "p.json"], {
      transport,
      worktreeId: "wt1",
      repoRoot: "/repo",
      readPush: () => ({ replies: [{ threadId: "t1", body: "ack" }], comments: [] }),
    });
    expect(received).toEqual({ replies: [{ threadId: "t1", body: "ack" }], comments: [] });
    expect(r.exitCode).toBe(0);
  });
  it("exits 10 with no output when `review --check` finds a worktree diff", async () => {
    const r = await runReview(["review", "--check"], {
      transport: fakeTransport({ type: "idle" }),
      diff: { diff: async () => [{ path: "a.ts", contentHash: "h1" }] },
      worktreeId: "wt1",
      repoRoot: "/repo",
      readPush: () => ({ replies: [], comments: [] }),
    });
    expect(r.exitCode).toBe(10);
    expect(r.stdout).toBe("");
  });
  it("exits 0 when `review --check` finds an empty diff (nothing to review)", async () => {
    const r = await runReview(["review", "--check"], {
      transport: fakeTransport({ type: "idle" }),
      diff: { diff: async () => [] },
      worktreeId: "wt1",
      repoRoot: "/repo",
      readPush: () => ({ replies: [], comments: [] }),
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
  });
  it("exits 2 on an unknown command", async () => {
    const r = await runReview(["bogus"], {
      transport: fakeTransport({ type: "idle" }),
      worktreeId: "wt1",
      repoRoot: "/repo",
      readPush: () => ({ replies: [], comments: [] }),
    });
    expect(r.exitCode).toBe(2);
  });
});
