import { describe, it, expect } from "vitest";
import { composeDraftKey, replyDraftKey, editDraftKey } from "../src/index.js";

describe("draft keys", () => {
  it("keeps each thread's reply separate", () => {
    expect(replyDraftKey("t1")).not.toBe(replyDraftKey("t2"));
    expect(replyDraftKey("t1")).toBe(replyDraftKey("t1"));
  });

  it("keeps each edited message separate", () => {
    expect(editDraftKey("t1", 0)).not.toBe(editDraftKey("t1", 1));
    expect(editDraftKey("t1", 0)).not.toBe(editDraftKey("t2", 0));
  });

  it("keeps a composer keyed by its exact range and side", () => {
    expect(composeDraftKey("a.ts", "new", 3, 5)).toBe(composeDraftKey("a.ts", "new", 3, 5));
    expect(composeDraftKey("a.ts", "new", 3, 5)).not.toBe(composeDraftKey("a.ts", "old", 3, 5));
    expect(composeDraftKey("a.ts", "new", 3, 5)).not.toBe(composeDraftKey("a.ts", "new", 3, 6));
    expect(composeDraftKey("a.ts", "new", 3, 5)).not.toBe(composeDraftKey("b.ts", "new", 3, 5));
  });

  // A reply on thread "1" and an edit of message 1 must never collide, whatever the ids.
  it("never collides across draft kinds", () => {
    const keys = [replyDraftKey("1"), editDraftKey("1", 1), composeDraftKey("1", "new", 1, 1)];
    expect(new Set(keys).size).toBe(3);
  });

  it("survives ids and paths containing the separator", () => {
    expect(replyDraftKey("a:b")).not.toBe(replyDraftKey("a:b:c"));
    expect(composeDraftKey("a:b.ts", "new", 1, 1)).not.toBe(composeDraftKey("a:b.ts:x", "new", 1, 1));
  });
});
