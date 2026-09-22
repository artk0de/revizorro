import { describe, it, expect } from "vitest";
import { runReview } from "../src/index.js";
import type { ReviewOptions, ReviewTransport } from "@revizorro/core";
import type { PushPayload, ReviewEvent } from "@revizorro/protocol";

const fakeTransport = (event: ReviewEvent): ReviewTransport => ({ review: async () => event });

describe("runReview", () => {
  it("prints the review event JSON for `review`", async () => {
    const r = await runReview(["review", "--worktree"], {
      transport: fakeTransport({ type: "decision", verdict: "approved", comments: [] }),
      worktreeId: "wt1",
      repoRoot: "/repo",
      readPush: () => ({ replies: [], comments: [] }),
      now: () => 0,
    });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      type: "decision",
      verdict: "approved",
      comments: [],
      waitedMs: 0,
      waited: "0.0s",
    });
  });
  it("forwards a closed event so the agent knows the human left without a verdict", async () => {
    const r = await runReview(["review", "--worktree"], {
      transport: fakeTransport({ type: "closed" }),
      worktreeId: "wt1",
      repoRoot: "/repo",
      readPush: () => ({ replies: [], comments: [] }),
      now: () => 0,
    });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ type: "closed", waitedMs: 0, waited: "0.0s" });
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
  it("forwards --staged-only so only the index gets reviewed", async () => {
    let opts: ReviewOptions | undefined;
    const transport: ReviewTransport = {
      review: async (_wt, _repoRoot, _push, o) => {
        opts = o;
        return { type: "idle" };
      },
    };
    await runReview(["review", "--worktree", "--staged-only"], {
      transport,
      worktreeId: "wt1",
      repoRoot: "/repo",
      readPush: () => ({ replies: [], comments: [] }),
    });
    expect(opts).toEqual({ stagedOnly: true });
  });
  it("sends no scope at all when the call names none, so the round keeps its own", async () => {
    let opts: ReviewOptions | undefined;
    const transport: ReviewTransport = {
      review: async (_wt, _repoRoot, _push, o) => {
        opts = o;
        return { type: "idle" };
      },
    };
    await runReview(["review", "--push", "p.json"], {
      transport,
      worktreeId: "wt1",
      repoRoot: "/repo",
      readPush: () => ({ replies: [{ threadId: "t1", body: "done" }], comments: [] }),
    });
    expect(opts).toEqual({});
  });
  it("reviews the whole worktree when --staged-only is absent", async () => {
    let opts: ReviewOptions | undefined;
    const transport: ReviewTransport = {
      review: async (_wt, _repoRoot, _push, o) => {
        opts = o;
        return { type: "idle" };
      },
    };
    await runReview(["review", "--worktree"], {
      transport,
      worktreeId: "wt1",
      repoRoot: "/repo",
      readPush: () => ({ replies: [], comments: [] }),
    });
    expect(opts).toEqual({ stagedOnly: false });
  });
  it("forwards --base so the review runs against the real target branch", async () => {
    let opts: ReviewOptions | undefined;
    const transport: ReviewTransport = {
      review: async (_wt, _repoRoot, _push, o) => {
        opts = o;
        return { type: "idle" };
      },
    };
    await runReview(["review", "--worktree", "--base", "develop"], {
      transport,
      worktreeId: "wt1",
      repoRoot: "/repo",
      readPush: () => ({ replies: [], comments: [] }),
    });
    expect(opts).toEqual({ stagedOnly: false, baseRef: "develop" });
  });
  it("leaves the base unset when --base is absent (auto-detect)", async () => {
    let opts: ReviewOptions | undefined;
    const transport: ReviewTransport = {
      review: async (_wt, _repoRoot, _push, o) => {
        opts = o;
        return { type: "idle" };
      },
    };
    await runReview(["review", "--worktree"], {
      transport,
      worktreeId: "wt1",
      repoRoot: "/repo",
      readPush: () => ({ replies: [], comments: [] }),
    });
    expect(opts?.baseRef).toBeUndefined();
  });
  it("advertises `update` in the usage, because the command ships alongside review", async () => {
    const r = await runReview([], {
      transport: fakeTransport({ type: "idle" }),
      worktreeId: "wt1",
      repoRoot: "/repo",
      readPush: () => ({ replies: [], comments: [] }),
    });

    expect(r.stdout).toContain("revizorro update");
  });
  // Every one of these exists so the agent reports a time it was told, rather than
  // one it measured around the command or added up from heartbeats itself.
  it("stamps how long the call blocked, so the agent never times the command itself", async () => {
    let clock = 1_000;
    const transport: ReviewTransport = {
      review: async () => {
        clock += 187_204;
        return { type: "decision", verdict: "approved", comments: [] };
      },
    };
    const r = await runReview(["review", "--worktree"], {
      transport,
      worktreeId: "wt1",
      repoRoot: "/repo",
      readPush: () => ({ replies: [], comments: [] }),
      now: () => clock,
    });
    expect(JSON.parse(r.stdout)).toMatchObject({ waitedMs: 187_204, waited: "3m 7s" });
  });
  it("spells out the round duration the host reported, so nobody sums up idle heartbeats", async () => {
    const r = await runReview(["review"], {
      transport: fakeTransport({ type: "idle", reviewMs: 1_284_000 }),
      worktreeId: "wt1",
      repoRoot: "/repo",
      readPush: () => ({ replies: [], comments: [] }),
      now: () => 0,
    });
    expect(JSON.parse(r.stdout)).toMatchObject({ reviewMs: 1_284_000, reviewFor: "21m 24s" });
  });
  it("spells out the inactivity in the units the ten-minute idle policy is written in", async () => {
    const r = await runReview(["review"], {
      transport: fakeTransport({ type: "idle", inactiveForMs: 754_000 }),
      worktreeId: "wt1",
      repoRoot: "/repo",
      readPush: () => ({ replies: [], comments: [] }),
      now: () => 0,
    });
    expect(JSON.parse(r.stdout)).toMatchObject({ inactiveForMs: 754_000, inactiveFor: "12m 34s" });
  });
  // `held` says an event came out of the queue; it does not say whether that
  // happened seconds ago or a round ago. Its age does, and reading it must not
  // cost the agent a subtraction it can get wrong.
  it("spells out how old the event is, so a replay from an earlier round is visible", async () => {
    const r = await runReview(["review"], {
      transport: fakeTransport({
        type: "decision",
        verdict: "approved",
        comments: [],
        at: 1_000,
        held: true,
      }),
      worktreeId: "wt1",
      repoRoot: "/repo",
      readPush: () => ({ replies: [], comments: [] }),
      now: () => 2_461_000,
    });
    expect(JSON.parse(r.stdout)).toMatchObject({ ageMs: 2_460_000, age: "41m" });
  });
  it("spells out nothing the host did not measure, so an older host still parses", async () => {
    const r = await runReview(["review"], {
      transport: fakeTransport({ type: "idle" }),
      worktreeId: "wt1",
      repoRoot: "/repo",
      readPush: () => ({ replies: [], comments: [] }),
      now: () => 0,
    });
    const event = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(event.reviewFor).toBeUndefined();
    expect(event.inactiveFor).toBeUndefined();
    expect(event.age).toBeUndefined();
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
