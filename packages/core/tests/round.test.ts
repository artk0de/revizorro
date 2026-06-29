import { describe, it, expect } from "vitest";
import { startRound, applyDecision } from "../src/index.js";
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
      status: "declined",
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
});
