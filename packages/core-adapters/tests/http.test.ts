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
    const pending = client.review("wt1");
    setTimeout(() => host.emit("wt1", { type: "decision", verdict: "approved", comments: [] }), 20);
    expect(await pending).toEqual({ type: "decision", verdict: "approved", comments: [] });
  });
  it("surfaces a client push to the host", async () => {
    host = new HttpReviewHost();
    const port = await host.start();
    const seen: unknown[] = [];
    host.onPush((wt, push) => {
      seen.push({ wt, push });
      host.emit(wt, { type: "idle" });
    });
    const client = new HttpReviewClient(port);
    await client.review("wt1", { replies: [{ threadId: "t1", body: "ack" }], comments: [] });
    expect(seen).toEqual([
      { wt: "wt1", push: { replies: [{ threadId: "t1", body: "ack" }], comments: [] } },
    ]);
  });
});
