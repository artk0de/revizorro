import { describe, it, expect } from "vitest";
import {
  startRound,
  applyDecision,
  markVerdictDelivered,
  markVerdictPending,
  isVerdictReplayable,
} from "../src/index.js";
import type { SessionState } from "@revizorro/protocol";

describe("startRound", () => {
  it("starts round 1 from null with unviewed files", () => {
    const s = startRound(null, "wt1", [{ path: "a.ts", contentHash: "h1" }]);
    expect(s.round).toBe(1);
    expect(s.status).toBe("open");
    expect(s.files["a.ts"]).toEqual({ viewed: false, contentHash: "h1" });
    expect(s.threads).toEqual([]);
  });
  it("increments round and collapses unchanged viewed files", () => {
    const prev: SessionState = {
      worktreeId: "wt1",
      round: 1,
      status: "changes_requested",
      files: { "a.ts": { viewed: true, contentHash: "h1" } },
      threads: [
        {
          id: "t1",
          file: "a.ts",
          range: { startLine: 1, endLine: 1 },
          messages: [{ author: "human", body: "x" }],
          resolved: true,
        },
        {
          id: "t2",
          file: "a.ts",
          range: { startLine: 2, endLine: 2 },
          messages: [{ author: "human", body: "y" }],
          resolved: false,
        },
      ],
    };
    const s = startRound(prev, "wt1", [{ path: "a.ts", contentHash: "h1" }]);
    expect(s.round).toBe(2);
    expect(s.files["a.ts"].viewed).toBe(true);
    expect(s.threads.map((t) => t.id)).toEqual(["t2"]); // resolved dropped
  });
});

describe("applyDecision", () => {
  it("sets status to approved", () => {
    const s = startRound(null, "wt1", []);
    expect(applyDecision(s, "approved").status).toBe("approved");
  });
  it("leaves a fresh verdict undelivered so a missed decision can be replayed", () => {
    const s = applyDecision(startRound(null, "wt1", []), "approved");
    expect(s.verdictDelivered).toBe(false);
  });
  it("marks the verdict delivered once an agent has received it", () => {
    const s = markVerdictDelivered(applyDecision(startRound(null, "wt1", []), "approved"));
    expect(s.verdictDelivered).toBe(true);
    expect(s.status).toBe("approved");
  });
  it("replays a verdict the agent just missed (it was starting up)", () => {
    const now = 1_000_000;
    const s = markVerdictPending(applyDecision(startRound(null, "wt1", []), "approved"), now);
    expect(isVerdictReplayable(s, now + 3_000)).toBe(true);
  });
  it("stops replaying a stale verdict — a later review wants a new round", () => {
    const now = 1_000_000;
    const s = markVerdictPending(applyDecision(startRound(null, "wt1", []), "approved"), now);
    expect(isVerdictReplayable(s, now + 60 * 60 * 1000)).toBe(false);
  });
  it("never replays a verdict the agent already received", () => {
    const now = 1_000_000;
    const s = markVerdictDelivered(applyDecision(startRound(null, "wt1", []), "approved"));
    expect(isVerdictReplayable(s, now)).toBe(false);
  });
  it("never replays while the round is still open", () => {
    expect(isVerdictReplayable(startRound(null, "wt1", []), 1_000_000)).toBe(false);
  });
  it("clears the delivery flag when the next round opens", () => {
    const decided = applyDecision(startRound(null, "wt1", []), "changes_requested");
    const next = startRound(decided, "wt1", [{ path: "a.ts", contentHash: "h1" }]);
    expect(next.status).toBe("open");
    expect(next.verdictDelivered).toBe(false);
  });
});
