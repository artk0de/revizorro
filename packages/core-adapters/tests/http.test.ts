import { describe, it, expect, afterEach } from "vitest";
import { HttpReviewHost, HttpReviewClient } from "../src/index.js";

let host: HttpReviewHost;
afterEach(async () => {
  await host?.stop();
});

describe("HTTP transport contract", () => {
  it("delivers an emitted event to a waiting client", async () => {
    host = new HttpReviewHost();
    const port = await host.start();
    const client = new HttpReviewClient(port);
    const pending = client.review("wt1", "/repo");
    setTimeout(() => {
      host.emit("wt1", { type: "decision", verdict: "approved", comments: [] });
    }, 20);
    expect(await pending).toEqual({ type: "decision", verdict: "approved", comments: [] });
  });
  it("fires onReview for a plain review but not for a push delivery", async () => {
    host = new HttpReviewHost();
    const port = await host.start();
    const reviews: string[] = [];
    host.onReview((wt) => reviews.push(wt));
    host.onPush((wt) => host.emit(wt, { type: "idle" }));
    const client = new HttpReviewClient(port);
    const pending = client.review("wt1", "/repo");
    setTimeout(() => host.emit("wt1", { type: "idle" }), 20);
    await pending;
    await client.review("wt1", "/repo", {
      replies: [],
      comments: [{ file: "a.ts", range: { startLine: 1, endLine: 1 }, body: "x" }],
    });
    expect(reviews).toEqual(["wt1"]);
  });
  it("carries the stagedOnly option from the client to the host", async () => {
    host = new HttpReviewHost();
    const port = await host.start();
    const seen: (boolean | undefined)[] = [];
    host.onReview((wt, _repoRoot, opts) => {
      seen.push(opts?.stagedOnly);
      host.emit(wt, { type: "idle" });
    });
    const client = new HttpReviewClient(port);
    await client.review("wt1", "/repo", undefined, { stagedOnly: true });
    await client.review("wt1", "/repo");
    expect(seen).toEqual([true, undefined]);
  });
  it("reports whether an emitted event actually reached a waiting agent", async () => {
    host = new HttpReviewHost();
    const port = await host.start();
    // Nobody is blocked on this worktree — the verdict would be lost.
    expect(host.emit("wt1", { type: "decision", verdict: "approved", comments: [] })).toBe(false);
    const client = new HttpReviewClient(port);
    const pending = client.review("wt1", "/repo");
    await new Promise((r) => setTimeout(r, 20));
    expect(host.emit("wt1", { type: "decision", verdict: "approved", comments: [] })).toBe(true);
    await pending;
  });
  it("surfaces a client push to the host", async () => {
    host = new HttpReviewHost();
    const port = await host.start();
    const seen: unknown[] = [];
    host.onPush((wt, repoRoot, push) => {
      seen.push({ wt, repoRoot, push });
      host.emit(wt, { type: "idle" });
    });
    const client = new HttpReviewClient(port);
    await client.review("wt1", "/repo", { replies: [{ threadId: "t1", body: "ack" }], comments: [] });
    expect(seen).toEqual([
      {
        wt: "wt1",
        repoRoot: "/repo",
        push: { replies: [{ threadId: "t1", body: "ack" }], comments: [] },
      },
    ]);
  });
});
