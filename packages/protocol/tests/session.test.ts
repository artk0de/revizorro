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
