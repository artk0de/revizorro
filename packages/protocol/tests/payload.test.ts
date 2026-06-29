import { describe, it, expect } from "vitest";
import { PushPayload } from "../src/index.js";

describe("PushPayload", () => {
  it("defaults replies and comments to empty arrays", () => {
    expect(PushPayload.parse({})).toEqual({ replies: [], comments: [] });
  });
  it("parses a reply and a comment", () => {
    const p = PushPayload.parse({
      replies: [{ threadId: "t1", body: "it narrows the union" }],
      comments: [{ file: "b.ts", range: { startLine: 1, endLine: 1 }, body: "rename" }],
    });
    expect(p.replies[0].threadId).toBe("t1");
    expect(p.comments[0].file).toBe("b.ts");
  });
});
