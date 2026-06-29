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
      readPush: () => ({ replies: [], comments: [] }),
    });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ type: "decision", verdict: "approved", comments: [] });
  });
  it("passes the push payload through on `--push`", async () => {
    let received: PushPayload | undefined;
    const transport: ReviewTransport = {
      review: async (_wt, push) => {
        received = push;
        return { type: "idle" };
      },
    };
    const r = await runReview(["review", "--push", "p.json"], {
      transport,
      worktreeId: "wt1",
      readPush: () => ({ replies: [{ threadId: "t1", body: "ack" }], comments: [] }),
    });
    expect(received).toEqual({ replies: [{ threadId: "t1", body: "ack" }], comments: [] });
    expect(r.exitCode).toBe(0);
  });
  it("exits 2 on an unknown command", async () => {
    const r = await runReview(["bogus"], {
      transport: fakeTransport({ type: "idle" }),
      worktreeId: "wt1",
      readPush: () => ({ replies: [], comments: [] }),
    });
    expect(r.exitCode).toBe(2);
  });
});
