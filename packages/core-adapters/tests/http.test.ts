import { describe, it, expect, afterEach } from "vitest";
import { createServer, request } from "node:http";
import { HttpReviewHost, HttpReviewClient, isDeadHostError } from "../src/index.js";

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
    expect(await pending).toMatchObject({ type: "decision", verdict: "approved", comments: [] });
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
  it("releases a blocked agent when the host shuts down", async () => {
    host = new HttpReviewHost();
    const port = await host.start();
    const client = new HttpReviewClient(port);
    const pending = client.review("wt1", "/repo");
    await new Promise((r) => setTimeout(r, 20));
    // The window reloads / the extension updates → the host goes away mid-poll.
    await host.stop();
    const err = await pending.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).not.toBeNull();
    expect(isDeadHostError(err)).toBe(true);
  });

  it("reads an empty response as a dead host rather than a parse error", async () => {
    // A bare server that answers 200 with no body — what a half-dead host looks like.
    const bare = createServer((_req, res) => {
      res.end();
    });
    const port = await new Promise<number>((r) =>
      bare.listen(0, "127.0.0.1", () => {
        r((bare.address() as { port: number }).port);
      }),
    );
    const err = await new HttpReviewClient(port).review("wt1", "/repo").then(
      () => null,
      (e: unknown) => e,
    );
    bare.close();
    expect(isDeadHostError(err)).toBe(true);
  });

  it("does not mistake a protocol error for a dead host", async () => {
    const bare = createServer((_req, res) => {
      res.end('{"type":"nonsense"}');
    });
    const port = await new Promise<number>((r) =>
      bare.listen(0, "127.0.0.1", () => {
        r((bare.address() as { port: number }).port);
      }),
    );
    const err = await new HttpReviewClient(port).review("wt1", "/repo").then(
      () => null,
      (e: unknown) => e,
    );
    bare.close();
    expect(err).not.toBeNull();
    expect(isDeadHostError(err)).toBe(false);
  });

  // The human can ask a second question while the agent is off writing the answer
  // to the first — it is not polling then, and a plain emit would drop the event.
  it("holds an event raised while the agent is away and hands it over on its next call", async () => {
    host = new HttpReviewHost();
    const port = await host.start();
    host.onReview(() => {
      /* the form re-opens; no event of its own */
    });
    expect(host.emit("wt1", { type: "question", threadId: "t2", file: "a.ts", side: "new", range: { startLine: 1, endLine: 1 }, body: "second question" }, true)).toBe(false);
    const event = await new HttpReviewClient(port).review("wt1", "/repo");
    expect(event).toMatchObject({ type: "question", threadId: "t2" });
  });

  it("keeps held events in order", async () => {
    host = new HttpReviewHost();
    const port = await host.start();
    host.onReview(() => undefined);
    host.emit("wt1", { type: "comment", threadId: "t1", file: "a.ts", side: "new", range: { startLine: 1, endLine: 1 }, body: "first" }, true);
    host.emit("wt1", { type: "comment", threadId: "t2", file: "a.ts", side: "new", range: { startLine: 2, endLine: 2 }, body: "second" }, true);
    const client = new HttpReviewClient(port);
    expect(await client.review("wt1", "/repo")).toMatchObject({ threadId: "t1" });
    expect(await client.review("wt1", "/repo")).toMatchObject({ threadId: "t2" });
  });

  it("does not hold an event that a waiting agent took", async () => {
    host = new HttpReviewHost();
    const port = await host.start();
    host.onReview(() => undefined);
    const client = new HttpReviewClient(port);
    const pending = client.review("wt1", "/repo");
    await new Promise((r) => setTimeout(r, 20));
    expect(host.emit("wt1", { type: "idle" }, true)).toBe(true);
    expect(await pending).toMatchObject({ type: "idle" });
    // Nothing left over for the next call. The abandoned poll is torn down by the
    // afterEach stop(), so swallow its rejection rather than leaving it unhandled.
    const abandoned = client.review("wt1", "/repo");
    abandoned.catch(() => undefined);
    const second = await Promise.race([
      abandoned,
      new Promise((r) => setTimeout(() => r("blocked"), 300)),
    ]);
    expect(second).toBe("blocked");
  });

  // A killed CLI (cancelled command, timeout, closed terminal) leaves its request
  // behind. Nothing removed it, so it stayed first in line and swallowed the next
  // event — the human approved and the live agent kept waiting.
  it("drops a poll whose connection died so the next event reaches a live agent", async () => {
    host = new HttpReviewHost();
    const port = await host.start();
    host.onReview(() => undefined);

    const body = JSON.stringify({ worktreeId: "wt1", repoRoot: "/repo" });
    const dead = request({
      host: "127.0.0.1",
      port,
      path: "/review",
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    });
    dead.on("error", () => undefined);
    dead.end(body);
    await new Promise((r) => setTimeout(r, 50));
    dead.destroy(); // the agent's process is gone
    await new Promise((r) => setTimeout(r, 50));

    const live = new HttpReviewClient(port).review("wt1", "/repo");
    await new Promise((r) => setTimeout(r, 50));
    expect(host.emit("wt1", { type: "decision", verdict: "approved", comments: [] })).toBe(true);
    expect(await live).toMatchObject({ type: "decision", verdict: "approved", comments: [] });
  });

  // Without this the call never returns: the agent's command sits there for as
  // long as the human takes to click something, looking like a hung tool.
  it("answers a poll with idle instead of blocking forever", async () => {
    host = new HttpReviewHost({ pollTimeoutMs: 150 });
    const port = await host.start();
    host.onReview(() => undefined);
    const started = Date.now();
    expect(await new HttpReviewClient(port).review("wt1", "/repo")).toEqual({ type: "idle" });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("does not time a poll out once an event has been delivered", async () => {
    host = new HttpReviewHost({ pollTimeoutMs: 150 });
    const port = await host.start();
    host.onReview(() => undefined);
    const pending = new HttpReviewClient(port).review("wt1", "/repo");
    await new Promise((r) => setTimeout(r, 20));
    host.emit("wt1", { type: "decision", verdict: "approved", comments: [] });
    expect(await pending).toMatchObject({ verdict: "approved" });
    // The timer must not fire afterwards and try to answer a finished response.
    await new Promise((r) => setTimeout(r, 250));
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

describe("event provenance", () => {
  it("stamps when the human acted, so an agent can judge freshness", async () => {
    host = new HttpReviewHost();
    const port = await host.start();
    host.onReview(() => undefined);
    const before = Date.now();
    const pending = new HttpReviewClient(port).review("wt1", "/repo");
    await new Promise((r) => setTimeout(r, 20));
    host.emit("wt1", { type: "decision", verdict: "approved", comments: [] });
    const event = await pending;
    expect(event.at).toBeGreaterThanOrEqual(before);
    expect(event.held).toBeUndefined(); // delivered straight to a waiting agent
  });

  // An instant answer looks like a stale replay unless the event says otherwise.
  it("marks an event that waited in the queue as held, keeping its original time", async () => {
    host = new HttpReviewHost({ pollTimeoutMs: 5000 });
    const port = await host.start();
    host.onReview(() => undefined);
    const raisedAt = Date.now();
    host.emit("wt1", { type: "decision", verdict: "approved", comments: [] }, true);
    await new Promise((r) => setTimeout(r, 60));
    const event = await new HttpReviewClient(port).review("wt1", "/repo");
    expect(event).toMatchObject({ type: "decision", verdict: "approved", held: true });
    expect(event.at).toBeLessThanOrEqual(raisedAt + 50); // stamped when raised, not when delivered
  });

  it("answers a timed-out poll with whatever context the host supplies", async () => {
    host = new HttpReviewHost({ pollTimeoutMs: 120 });
    const port = await host.start();
    host.onReview(() => undefined);
    host.onIdle(() => ({
      type: "idle",
      review: { round: 7, files: 15, openThreads: 2, viewedFiles: 6 },
    }));
    const event = await new HttpReviewClient(port).review("wt1", "/repo");
    expect(event).toMatchObject({
      type: "idle",
      review: { round: 7, files: 15, openThreads: 2, viewedFiles: 6 },
    });
  });

  it("falls back to a bare idle when the host offers no context", async () => {
    host = new HttpReviewHost({ pollTimeoutMs: 120 });
    const port = await host.start();
    host.onReview(() => undefined);
    expect(await new HttpReviewClient(port).review("wt1", "/repo")).toMatchObject({ type: "idle" });
  });
});
