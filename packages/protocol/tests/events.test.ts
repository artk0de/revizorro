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
});
