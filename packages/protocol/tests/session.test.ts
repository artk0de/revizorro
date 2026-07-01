import { describe, it, expect } from "vitest";
import { SessionState } from "../src/index.js";

describe("SessionState", () => {
  it("parses a minimal open session", () => {
    const s = SessionState.parse({
      worktreeId: "wt1",
      round: 1,
      status: "open",
      files: { "a.ts": { viewed: false, contentHash: "h1" } },
      threads: [],
    });
    expect(s.round).toBe(1);
  });
  it("defaults a thread's side to new and accepts old", () => {
    const s = SessionState.parse({
      worktreeId: "wt1",
      round: 1,
      status: "open",
      files: {},
      threads: [
        { id: "t1", file: "a.ts", range: { startLine: 5, endLine: 5 }, messages: [{ author: "human", body: "x" }] },
        {
          id: "t2",
          file: "a.ts",
          side: "old",
          range: { startLine: 3, endLine: 3 },
          messages: [{ author: "human", body: "y" }],
        },
      ],
    });
    expect(s.threads[0].side).toBe("new");
    expect(s.threads[1].side).toBe("old");
  });
  it("requires round >= 1", () => {
    expect(() =>
      SessionState.parse({
        worktreeId: "wt1",
        round: 0,
        status: "open",
        files: {},
        threads: [],
      }),
    ).toThrow();
  });
});
