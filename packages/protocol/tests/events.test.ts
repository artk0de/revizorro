import { describe, it, expect } from "vitest";
import { ReviewEvent } from "../src/index.js";

describe("ReviewEvent", () => {
  it("parses a question event", () => {
    const e = ReviewEvent.parse({
      type: "question",
      threadId: "t1",
      file: "a.ts",
      range: { startLine: 3, endLine: 5 },
      body: "why this cast?",
    });
    expect(e.type).toBe("question");
  });
  it("parses a decision with default empty comments", () => {
    const e = ReviewEvent.parse({ type: "decision", verdict: "approved" });
    expect(e).toEqual({ type: "decision", verdict: "approved", comments: [] });
  });
  it("rejects an unknown type", () => {
    expect(() => ReviewEvent.parse({ type: "bogus" })).toThrow();
  });
  it("parses idle", () => {
    expect(ReviewEvent.parse({ type: "idle" }).type).toBe("idle");
  });
  it("defaults a comment's side to new and accepts old", () => {
    const newSide = ReviewEvent.parse({
      type: "comment",
      threadId: "t1",
      file: "a.ts",
      range: { startLine: 1, endLine: 1 },
      body: "note",
    });
    const oldSide = ReviewEvent.parse({
      type: "comment",
      threadId: "t2",
      file: "a.ts",
      side: "old",
      range: { startLine: 9, endLine: 9 },
      body: "removed here",
    });
    expect(newSide.type === "comment" && newSide.side).toBe("new");
    expect(oldSide.type === "comment" && oldSide.side).toBe("old");
  });
});
